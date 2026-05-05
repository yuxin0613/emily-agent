import { SubAgent } from "../agents/SubAgent.ts";
import { createAgentProfile, renderAgentProfile } from "../agents/AgentProfile.ts";
import { buildRoleWorkProduct } from "../agents/RoleWorkProduct.ts";
import type { ModelProvider } from "../llm/ModelProvider.ts";
import { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import { ProviderUsageStore } from "../llm/ProviderUsageStore.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import { readRoleDefinition } from "../roles/RoleDefinitionLoader.ts";
import { SkillRegistry } from "../skills/SkillRegistry.ts";
import { parsePermissionMode } from "../tools/PermissionMode.ts";
import { IllegalTaskTransitionError, TaskTransitionConflictError } from "../tasks/errors.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { createTaskResult, serializeTaskResult } from "../tasks/TaskResult.ts";
import { ToolGateway } from "../tools/ToolGateway.ts";
import { ToolExecutor, type ToolExecutionResult } from "../tools/ToolExecutor.ts";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.ts";
import type { JsonValue, Metadata, SkillHintResolution, Task, TaskResult, ToolHintResolution } from "../types.ts";

interface StartMessage {
  type: "task.start";
  taskId: string;
  role: string;
  agentId: string;
  dataDir: string;
  leaseMs?: number;
  leaseToken?: string | null;
}

const cancelledTasks = new Map<string, string>();

process.on("message", (message: unknown) => {
  if (isCancelMessage(message)) {
    cancelledTasks.set(message.taskId, message.reason || "cancelled by main agent");
    return;
  }
  if (!isStartMessage(message)) return;
  runTask(message).catch((error: Error) => {
    process.stderr.write(`worker fatal error: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
});

async function runTask({ taskId, role, agentId, dataDir, leaseMs = 30000, leaseToken = null }: StartMessage): Promise<void> {
  const taskStore = await TaskStore.create({ dataDir });
  const memory = await MemorySystem.create({ dataDir });
  const providerUsageStore = await ProviderUsageStore.create({ dataDir });
  const providerRegistry = await ProviderRegistry.create({ dataDir, persist: false, usageStore: providerUsageStore });
  let eventId: number | null = null;

  const heartbeat = setInterval(() => {
    process.send?.({
      type: "agent.heartbeat",
      taskId,
      role,
      agentId,
      leaseToken,
    });
  }, Math.max(1000, Math.floor(leaseMs / 3)));

  try {
    eventId = taskStore.claimTask(taskId, agentId, { leaseMs, leaseToken: leaseToken || undefined });
    await taskStore.writeTaskMarkdown(taskId);
    notify("task.changed", { taskId, eventId, leaseToken });

    const task = taskStore.getTaskOrThrow(taskId);
    throwIfCancelled(taskId);
    if (task.metadata.forceCrash) {
      process.exit(70);
    }
    const result = role === "inspector"
      ? await withTimeout(inspectTask({ task, taskStore }), readNumber(task.metadata.timeoutMs, leaseMs * 2), taskId)
      : await withTimeout(runRoleTask({ role, task, memory, providerRegistry, taskStore }), readNumber(task.metadata.timeoutMs, leaseMs * 2), taskId);
    throwIfCancelled(taskId);

    eventId = taskStore.finishTask(taskId, {
      result: serializeTaskResult(limitTaskResult(result, readNumber(task.metadata.maxResultChars, 12000))),
      agentId,
      leaseToken,
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    if (error instanceof TaskCancelledError) {
      eventId = safeTaskMutation(taskStore, taskId, "task.cancelled", () => taskStore.cancelTask(taskId, {
        reason: error.message,
        agentId,
        leaseToken,
      }));
    } else {
      eventId = safeTaskMutation(taskStore, taskId, "task.failed", () => taskStore.failTask(taskId, {
        error: message,
        result: serializeTaskResult(createTaskResult({
          status: "failed",
          summary: `任务执行失败：${error instanceof Error ? error.message : String(error)}`,
        })),
        agentId,
        leaseToken,
      }));
    }
  } finally {
    clearInterval(heartbeat);

    const finalTask = taskStore.getTask(taskId);
    if (finalTask?.status === "running" && (!finalTask.leaseToken || finalTask.leaseToken === leaseToken)) {
      eventId = safeTaskMutation(taskStore, taskId, "task.failed", () => taskStore.failTask(taskId, {
        error: "Worker reached finally without a terminal status.",
        result: "任务没有产生明确结果，已由 worker finally 兜底标记失败。",
        agentId,
        leaseToken,
      }));
    }

    await taskStore.writeTaskMarkdown(taskId);
    notify("task.changed", { taskId, eventId, leaseToken });
    notify("task.finished", { taskId, eventId, leaseToken });
    providerUsageStore.close();
    taskStore.close();
  }
}

async function runRoleTask({
  role,
  task,
  memory,
  providerRegistry,
  taskStore,
}: {
  role: string;
  task: Task;
  memory: MemorySystem;
  providerRegistry: ProviderRegistry;
  taskStore: TaskStore;
}): Promise<TaskResult> {
  const definition = await readRoleDefinition(role, { roleDir: process.env.EMILY_ROLE_DIR });
  const profile = await createAgentProfile({
    agentId: String(task.assignedAgentId || `${role}-${process.pid}`),
    definition,
    task,
    dataDir: process.env.EMILY_DATA_DIR || process.cwd(),
  });
  taskStore.addEvent({
    type: "agent.profile.created",
    taskId: task.id,
    agentId: profile.id,
    payload: {
      role: profile.role,
      sessionScope: profile.sessionScope,
      memoryScope: profile.memoryScope,
      stateDir: profile.stateDir,
      skillAllowlist: profile.skillAllowlist,
      providerFallback: profile.providerBinding.fallback,
      permissionMode: profile.toolPolicy.permissionMode,
      effectiveAllowedTools: profile.toolPolicy.effectiveAllowedTools,
    },
  });
  let providerFallback: { requestedProviderId: string; fallbackProviderId: string; reason: string } | null = null;
  const model: ModelProvider = providerRegistry.createForRole(definition, {
    onFallback: (fallback) => {
      providerFallback = fallback;
    },
  });
  if (providerFallback) {
    taskStore.addEvent({
      type: "runtime.anomaly",
      taskId: task.id,
      payload: {
        severity: "warning",
        code: "provider_fallback",
        message: `Role ${role} fell back from provider ${providerFallback.requestedProviderId} to ${providerFallback.fallbackProviderId}.`,
        repaired: true,
        reason: providerFallback.reason,
      },
    });
  }
  const permissionMode = parsePermissionMode(task.metadata.permissionMode);
  const toolGateway = new ToolGateway(definition, {
    registry: createDefaultToolRegistry(),
    permissionMode,
  });
  const skillRegistry = await SkillRegistry.create({ skillDir: process.env.EMILY_SKILL_DIR });
  const skillHints = unique([
    ...definition.skills,
    ...readStringArray(task.metadata.skillHints),
  ]);
  const skillResolution = skillRegistry.resolveForTask({
    input: task.input,
    hints: skillHints,
    allowlist: profile.skillAllowlist,
  });
  const toolHints = unique([
    ...readStringArray(task.metadata.toolHints),
    ...skillResolution.matched.flatMap((skill) => skill.toolHints),
  ]);
  const toolResolution = toolGateway.resolveHints(toolHints);
  recordToolSkillResolution({
    taskStore,
    task,
    toolResolution,
    skillResolution,
  });
  const toolExecutor = new ToolExecutor({
    workspaceDir: process.cwd(),
    taskStore,
    registry: createDefaultToolRegistry(),
    onEvent: ({ eventId }) => {
      notify("task.changed", { taskId: task.id, eventId, leaseToken: task.leaseToken });
    },
  });
  const toolExecutionResults: ToolExecutionResult[] = [];
  for (const request of readToolRequests(task.metadata.toolRequests)) {
    toolExecutionResults.push(await toolExecutor.execute({
      tool: request.tool,
      args: request.args,
      roleDefinition: definition,
      permissionMode,
      task,
      runId: typeof task.metadata.runId === "string" ? task.metadata.runId : null,
      sessionId: String(task.metadata.sessionId || "default"),
    }));
  }
  if (typeof task.metadata.forceDelayMs === "number") {
    await sleep(task.metadata.forceDelayMs);
  }

  const relevantMemory = await memory.recall(task.input, {
    scope: profile.memoryScope,
    limit: 5,
  });

  const agent = new SubAgent({
    name: role,
    role: definition.role,
    capabilities: definition.capabilities,
    model,
    memory,
  });

  const response = await agent.run({
    input: [
      definition.instructions,
      "",
      "Output contract:",
      definition.outputContract || "Return a concise result that the main agent can summarize.",
      "",
      "Tool context:",
      ...toolGateway.renderToolContext(toolResolution),
      "",
      "Tool execution results:",
      ...renderToolExecutionResults(toolExecutionResults),
      "",
      "Skill context:",
      ...skillRegistry.renderSkillContext(skillResolution, { mode: "progressive" }),
      "",
      "Agent profile:",
      ...renderAgentProfile(profile),
      "",
      "Task:",
      task.input,
    ].join("\n"),
    sessionId: profile.sessionScope,
    relevantMemory,
    taskId: task.id,
    runId: typeof task.metadata.runId === "string" ? task.metadata.runId : undefined,
    source: "subagent-worker",
  });
  throwIfCancelled(task.id);

  const workProduct = buildRoleWorkProduct({
    role,
    task,
    providerContent: response.content,
    relevantMemory,
    toolResolution,
    skillResolution,
    canReadFiles: toolGateway.canUse("read_file"),
  });
  const memoryContent = workProduct;
  if (readNonNegativeNumber(task.metadata.maxMemoryCandidates, 1) > 0) {
    taskStore.createMemoryCandidate({
      runId: typeof task.metadata.runId === "string" ? task.metadata.runId : null,
      taskId: task.id,
      scope: String(task.metadata.sessionId || "default"),
      kind: "subagent:result",
      content: memoryContent,
      createdBy: role,
    });
  }

  return createTaskResult({
    status: "success",
    summary: workProduct,
    artifacts: [{
      type: "provider-call",
      title: `${response.provider.id}/${response.provider.model}`,
      metadata: toMetadata({
        providerId: response.provider.id,
        model: response.provider.model,
        latencyMs: response.provider.latencyMs,
        attempts: response.provider.attempts,
        finishReason: response.provider.finishReason,
        rawProvider: response.provider.rawProvider,
        usage: response.provider.usage,
        costUsd: response.provider.costUsd,
        usageRecordId: response.provider.usageRecordId,
        jsonFormat: response.provider.jsonFormat,
        jsonWarnings: response.provider.jsonWarnings,
        roleWorkProduct: {
          enhanced: workProduct !== response.content,
          role,
        },
        tools: {
          permissionMode,
          requested: toolResolution.requested,
          allowed: toolResolution.allowed.map((tool) => tool.name),
          denied: toolResolution.denied,
          unknown: toolResolution.unknown,
          executed: toolExecutionResults.map((result) => ({
            tool: result.tool,
            ok: result.ok,
            durationMs: result.durationMs,
            error: result.error || "",
          })),
        },
        skills: {
          requested: skillResolution.requested,
          matched: skillResolution.matched.map((skill) => skill.name),
          unknown: skillResolution.unknown,
          blocked: skillResolution.blocked || [],
          autoSelected: skillResolution.autoSelected || [],
        },
        profile,
      }),
    }],
    memoryCandidates: [{
      scope: String(task.metadata.sessionId || "default"),
      kind: "subagent:result",
      content: memoryContent,
    }],
  });
}

async function inspectTask({ task, taskStore }: { task: Task; taskStore: TaskStore }): Promise<TaskResult> {
  const definition = await readRoleDefinition("inspector", { roleDir: process.env.EMILY_ROLE_DIR });
  const toolGateway = new ToolGateway(definition);
  toolGateway.assertAllowed("inspect_task");
  if (typeof task.metadata.forceDelayMs === "number") {
    await sleep(task.metadata.forceDelayMs);
  }

  const targetTaskId = String(task.metadata.targetTaskId || "");
  const targetTask = taskStore.getTask(targetTaskId);
  if (!targetTask) {
    return createTaskResult({
      status: "failed",
      summary: `未找到需要检查的任务：${targetTaskId}`,
    });
  }

  if (targetTask.status === "done" && targetTask.result) {
    return createTaskResult({
      status: "success",
      summary: `检查完成：目标任务 ${targetTask.id} 已有可用结果。`,
    });
  }

  const result = [
    `检查完成：目标任务 ${targetTask.id} 没有可用完成结果。`,
    `当前状态：${targetTask.status}`,
    targetTask.error ? `错误：${targetTask.error}` : "错误：(none)",
    "建议主 agent 重新派发该任务或向用户说明失败原因。",
  ].join("\n");

  const targetEventId = taskStore.transitionTask(targetTask.id, "failed", {
    error: targetTask.error || "Task required inspection and no usable result was found.",
    reason: "inspector found no usable result",
    metadata: {
      ...targetTask.metadata,
      inspectedBy: task.id,
      inspectedAt: new Date().toISOString(),
    },
  });
  await taskStore.writeTaskMarkdown(targetTask.id);
  notify("task.changed", {
    taskId: targetTask.id,
    eventId: targetEventId,
  });

  return createTaskResult({
    status: "failed",
    summary: result,
    nextActions: ["主 agent 重新派发该任务或向用户说明失败原因。"],
  });
}

function notify(type: string, payload: { taskId: string; eventId: number | null; leaseToken?: string | null }): void {
  if (!process.connected || !process.send) return;
  try {
    process.send({
      type,
      ...payload,
    });
  } catch {
    // The SQLite task row is the source of truth; IPC is only a best-effort notification.
  }
}

function isStartMessage(message: unknown): message is StartMessage {
  return Boolean(
    message
      && typeof message === "object"
      && (message as StartMessage).type === "task.start"
      && typeof (message as StartMessage).taskId === "string",
  );
}

function safeTaskMutation(taskStore: TaskStore, taskId: string, type: string, mutate: () => number): number | null {
  try {
    return mutate();
  } catch (error) {
    if (error instanceof TaskTransitionConflictError || error instanceof IllegalTaskTransitionError) {
      return taskStore.addEvent({
        type: "task.stale_worker_ignored",
        taskId,
        payload: {
          attempted: type,
          reason: error.message,
        },
      });
    }
    throw error;
  }
}

function isCancelMessage(message: unknown): message is { type: "task.cancel"; taskId: string; reason?: string } {
  return Boolean(
    message
      && typeof message === "object"
      && (message as { type?: string }).type === "task.cancel"
      && typeof (message as { taskId?: unknown }).taskId === "string",
  );
}

function throwIfCancelled(taskId: string): void {
  const reason = cancelledTasks.get(taskId);
  if (reason) throw new TaskCancelledError(reason);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, taskId: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          cancelledTasks.set(taskId, `Task ${taskId} timed out after ${timeoutMs}ms`);
          reject(new Error(`Task ${taskId} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function readToolRequests(value: unknown): Array<{
  tool: string;
  args: Record<string, unknown>;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      tool: String(item.tool || ""),
      args: item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args as Record<string, unknown> : {},
    }))
    .filter((item) => item.tool.trim());
}

function toMetadata(input: Record<string, unknown>): Metadata {
  return JSON.parse(JSON.stringify(input)) as Metadata;
}

function renderToolExecutionResults(results: ToolExecutionResult[]): string[] {
  if (!results.length) return ["(none requested)"];
  return results.map((result) => [
    `- ${result.tool}: ${result.ok ? "ok" : "failed"} (${result.durationMs}ms)`,
    result.error ? `  error: ${result.error}` : "",
    result.output ? `  output: ${JSON.stringify(result.output).slice(0, 4000)}` : "",
  ].filter(Boolean).join("\n"));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function recordToolSkillResolution({
  taskStore,
  task,
  toolResolution,
  skillResolution,
}: {
  taskStore: TaskStore;
  task: Task;
  toolResolution: ToolHintResolution;
  skillResolution: SkillHintResolution;
}): void {
  taskStore.addEvent({
    type: "tool.hints.resolved",
    taskId: task.id,
    payload: {
      permissionMode: toolResolution.permissionMode || String(task.metadata.permissionMode || "workspace_write"),
      requested: toolResolution.requested,
      allowed: toolResolution.allowed.map((tool) => tool.name),
      denied: toolResolution.denied,
      unknown: toolResolution.unknown,
    },
  });
  taskStore.addEvent({
    type: "skill.hints.resolved",
    taskId: task.id,
    payload: {
      requested: skillResolution.requested,
      matched: skillResolution.matched.map((skill) => skill.name),
      unknown: skillResolution.unknown,
      blocked: skillResolution.blocked || [],
      autoSelected: skillResolution.autoSelected || [],
    },
  });
  if (skillResolution.matched.length) {
    taskStore.addEvent({
      type: "skill.used",
      taskId: task.id,
      payload: {
        skills: skillResolution.matched.map((skill) => skill.name),
        autoSelected: skillResolution.autoSelected || [],
      },
    });
  }

  if (toolResolution.denied.length || toolResolution.unknown.length) {
    taskStore.addEvent({
      type: "runtime.anomaly",
      taskId: task.id,
      payload: {
        severity: "warning",
        code: "tool_hints_rejected",
        message: "Some requested tool hints are unavailable for this role.",
        denied: toolResolution.denied,
        unknown: toolResolution.unknown,
        repaired: true,
      },
    });
  }
  if (skillResolution.unknown.length || skillResolution.blocked?.length) {
    taskStore.addEvent({
      type: "runtime.anomaly",
      taskId: task.id,
      payload: {
        severity: "warning",
        code: "skill_hints_unknown",
        message: "Some requested skill hints are not registered.",
        unknown: skillResolution.unknown,
        blocked: skillResolution.blocked || [],
        repaired: true,
      },
    });
  }
}

function limitTaskResult(result: TaskResult, maxChars: number): TaskResult {
  if (result.summary.length <= maxChars) return result;
  return {
    ...result,
    summary: `${result.summary.slice(0, Math.max(0, maxChars - 3))}...`,
  };
}

class TaskCancelledError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
