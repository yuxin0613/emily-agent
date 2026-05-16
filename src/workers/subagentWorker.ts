import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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
import { DEFAULT_ROLE_TASK_TIMEOUT_MS, normalizeRoleTaskTimeoutMs } from "../runtime/RoleTaskTimeout.ts";
import { IllegalTaskTransitionError, TaskTransitionConflictError } from "../tasks/errors.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { createTaskResult, serializeTaskResult } from "../tasks/TaskResult.ts";
import { ToolGateway } from "../tools/ToolGateway.ts";
import { ToolExecutor, type ToolApproval, type ToolExecutionResult } from "../tools/ToolExecutor.ts";
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
  roleTaskTimeoutMs?: number;
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

async function runTask({
  taskId,
  role,
  agentId,
  dataDir,
  leaseMs = 30000,
  leaseToken = null,
  roleTaskTimeoutMs = configuredRoleTaskTimeoutMs(),
}: StartMessage): Promise<void> {
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
      ? await withTimeout(inspectTask({ task, taskStore }), taskTimeoutMs(task.metadata.timeoutMs, roleTaskTimeoutMs), taskId)
      : await withTimeout(runRoleTask({ role, task, memory, providerRegistry, taskStore }), taskTimeoutMs(task.metadata.timeoutMs, roleTaskTimeoutMs), taskId);
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
  const providerFallbacks: Array<{ requestedProviderId: string; fallbackProviderId: string; reason: string }> = [];
  const model: ModelProvider = providerRegistry.createForRole(definition, {
    onFallback: (fallback) => {
      providerFallbacks.push(fallback);
    },
  });
  const providerFallback = providerFallbacks[0];
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
    toolCallTimeoutMs: providerRegistry.toolCallTimeoutSeconds * 1000,
    onEvent: ({ eventId }) => {
      notify("task.changed", { taskId: task.id, eventId, leaseToken: task.leaseToken });
    },
  });
  const toolExecutionResults: ToolExecutionResult[] = [];
  for (const request of plannedToolRequests(task, toolGateway)) {
    toolExecutionResults.push(await toolExecutor.execute({
      tool: request.tool,
      args: request.args,
      approval: request.approval,
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
      "Tool request protocol:",
      "If this task requires creating or editing files, include one JSON block with a top-level toolRequests array.",
      "Supported request shape: {\"toolRequests\":[{\"tool\":\"write_file\",\"args\":{\"path\":\"relative/or/approved/path\",\"content\":\"...\"}}]}.",
      "Use write_file for file creation or edits and run_tests for verification commands; do not describe shell commands as if they were executed.",
      "Do not claim a file was created, edited, or verified unless the tool execution results show success.",
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
  for (const request of providerToolRequests(response.content, task, toolGateway)) {
    toolExecutionResults.push(await toolExecutor.execute({
      tool: request.tool,
      args: request.args,
      approval: request.approval,
      roleDefinition: definition,
      permissionMode,
      task,
      runId: typeof task.metadata.runId === "string" ? task.metadata.runId : null,
      sessionId: String(task.metadata.sessionId || "default"),
    }));
  }
  throwIfCancelled(task.id);

  const materializationError = requiredMaterializationError({
    role,
    task,
    toolGateway,
    toolExecutionResults,
  });
  if (materializationError) throw new Error(materializationError);

  const workProduct = buildRoleWorkProduct({
    role,
    task,
    providerContent: response.content,
    relevantMemory,
    toolResolution,
    skillResolution,
    toolExecutionResults,
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

function taskTimeoutMs(value: unknown, fallbackMs: number): number {
  return normalizeRoleTaskTimeoutMs(value, fallbackMs);
}

function configuredRoleTaskTimeoutMs(): number {
  const seconds = Number(process.env.EMILY_ROLE_TASK_TIMEOUT_SECONDS);
  if (Number.isFinite(seconds) && seconds > 0) return normalizeRoleTaskTimeoutMs(seconds * 1000, DEFAULT_ROLE_TASK_TIMEOUT_MS);
  return DEFAULT_ROLE_TASK_TIMEOUT_MS;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

interface PlannedToolRequest {
  tool: string;
  args: Record<string, unknown>;
  approval?: ToolApproval;
}

function plannedToolRequests(task: Task, toolGateway: ToolGateway): PlannedToolRequest[] {
  return dedupeToolRequests([
    ...readToolRequests(task.metadata.toolRequests),
    ...automaticWebSearchToolRequests(task, toolGateway),
    ...automaticWebToolRequests(task, toolGateway),
  ]);
}

function providerToolRequests(content: string, task: Task, toolGateway: ToolGateway): PlannedToolRequest[] {
  const requests = [
    ...extractJsonCandidates(content).flatMap(readProviderToolRequests),
    ...codeFenceWriteRequests(content, task),
  ].filter((request) => toolGateway.canUse(request.tool));
  return dedupeToolRequests(requests).slice(0, 12);
}

function readToolRequests(value: unknown): PlannedToolRequest[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      tool: String(item.tool || item.name || ""),
      args: firstRecord(item.args, item.arguments, item.input),
      approval: normalizeToolApproval(item.approval),
    }))
    .filter((item) => item.tool.trim());
}

function readProviderToolRequests(value: unknown): PlannedToolRequest[] {
  if (Array.isArray(value)) return readToolRequests(value);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return readToolRequests(record.toolRequests || record.tools || record.requests);
}

function extractJsonCandidates(content: string): unknown[] {
  const candidates: string[] = [];
  const fenced = content.matchAll(/```(?:json|toolRequests|tools)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) candidates.push(match[1].trim());

  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);
  const firstObject = content.indexOf("{");
  const lastObject = content.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(content.slice(firstObject, lastObject + 1));
  const firstArray = content.indexOf("[");
  const lastArray = content.lastIndexOf("]");
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(content.slice(firstArray, lastArray + 1));

  const parsed: unknown[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Provider prose can contain non-JSON braces; invalid candidates are ignored.
    }
  }
  return parsed;
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return {};
}

function codeFenceWriteRequests(content: string, task: Task): PlannedToolRequest[] {
  if (!requiresFileMaterialization(task)) return [];
  const requests: PlannedToolRequest[] = [];
  for (const match of content.matchAll(/```([A-Za-z0-9._+-]*)[^\n]*\n([\s\S]*?)```/g)) {
    const language = (match[1] || "").toLowerCase();
    const code = match[2] || "";
    if (!code.trim()) continue;
    const path = filePathForCodeFence({ language, content, task, index: requests.length });
    if (!path) continue;
    requests.push({
      tool: "write_file",
      args: {
        path,
        content: code.replace(/\s+$/g, "") + "\n",
      },
    });
  }
  return requests;
}

function filePathForCodeFence({
  language,
  content,
  task,
  index,
}: {
  language: string;
  content: string;
  task: Task;
  index: number;
}): string {
  const text = taskMaterializationText(task);
  const explicit = extractExplicitFilePath(`${text}\n${content}`, language);
  if (explicit) return explicit;
  const outputDir = extractOutputDirectory(text);
  const name = defaultFileNameForLanguage(language, index);
  if (!name) return "";
  return outputDir ? joinToolPath(outputDir, name) : name;
}

function extractExplicitFilePath(text: string, language: string): string {
  const extensions = language === "html" || language === "javascript" || language === "js" || language === "css"
    ? "html|css|js|jsx|ts|tsx|json|md"
    : "html|css|js|jsx|ts|tsx|json|md|txt";
  const match = text.match(new RegExp(`(?:^|[\\s\`'"])(~\\/[^\\s\`'"]+\\.(?:${extensions})|\\.?\\.?\\/[^\\s\`'"]+\\.(?:${extensions})|[A-Za-z0-9_./-]+\\.(?:${extensions}))(?:[:\\s\`'",)]|$)`, "i"));
  return match?.[1] || "";
}

function extractOutputDirectory(text: string): string {
  const match = text.match(/(?:保存到|输出到|写入到|放到|存到|save\s+(?:to|under|in)|output\s+(?:to|under|in)|write\s+(?:to|under|in))\s*[:：]?\s*(~\/[^\s`'",，。；;]+|\/[^\s`'",，。；;]+|\.{1,2}\/[^\s`'",，。；;]+|[A-Za-z0-9_./-]+\/[^\s`'",，。；;]*)/i);
  if (!match?.[1]) return "";
  return match[1].replace(/[),.，。；;]+$/g, "").replace(/\/$/, "");
}

function defaultFileNameForLanguage(language: string, index: number): string {
  if (language === "html" || language === "htm") return "index.html";
  if (language === "css") return index === 0 ? "style.css" : `style-${index + 1}.css`;
  if (language === "js" || language === "javascript") return index === 0 ? "script.js" : `script-${index + 1}.js`;
  if (language === "ts" || language === "typescript") return index === 0 ? "index.ts" : `index-${index + 1}.ts`;
  if (language === "tsx") return index === 0 ? "index.tsx" : `index-${index + 1}.tsx`;
  if (language === "json") return index === 0 ? "data.json" : `data-${index + 1}.json`;
  if (language === "md" || language === "markdown") return index === 0 ? "README.md" : `notes-${index + 1}.md`;
  return "";
}

function joinToolPath(directory: string, fileName: string): string {
  return `${directory.replace(/\/+$/g, "")}/${fileName.replace(/^\/+/g, "")}`;
}

function automaticWebToolRequests(task: Task, toolGateway: ToolGateway): PlannedToolRequest[] {
  if (!toolGateway.canUse("http_fetch")) return [];
  const urls = extractHttpUrls([
    task.input,
    typeof task.metadata.planGoal === "string" ? task.metadata.planGoal : "",
    Array.isArray(task.metadata.exitCriteria) ? task.metadata.exitCriteria.join("\n") : "",
  ].join("\n"));
  return urls.slice(0, 3).map((url) => ({
    tool: "http_fetch",
    args: {
      url,
      method: "GET",
      maxBytes: 120000,
      timeoutMs: 15000,
    },
    approval: {
      approved: true,
      template: "network_read",
      reason: "explicit URL provided in assigned research task",
    },
  }));
}

function automaticWebSearchToolRequests(task: Task, toolGateway: ToolGateway): PlannedToolRequest[] {
  if (!toolGateway.canUse("web_search")) return [];
  const text = [
    task.input,
    typeof task.metadata.planGoal === "string" ? task.metadata.planGoal : "",
    Array.isArray(task.metadata.exitCriteria) ? task.metadata.exitCriteria.join("\n") : "",
  ].join("\n");
  if (!shouldAutoSearchWeb(text)) return [];
  const args: Record<string, unknown> = {
    query: searchQueryFromTask(task),
    count: 5,
    timeoutMs: 15000,
  };
  if (typeof task.metadata.webSearchProvider === "string" && task.metadata.webSearchProvider.trim()) {
    args.provider = task.metadata.webSearchProvider.trim();
  }
  if (typeof task.metadata.webSearchEndpoint === "string" && task.metadata.webSearchEndpoint.trim()) {
    args.endpoint = task.metadata.webSearchEndpoint.trim();
  }
  if (typeof task.metadata.webSearchMethod === "string" && task.metadata.webSearchMethod.trim()) {
    args.method = task.metadata.webSearchMethod.trim();
  }
  return [{
    tool: "web_search",
    args,
    approval: {
      approved: true,
      template: "network_read",
      reason: "explicit web search or current-news request in assigned research task",
    },
  }];
}

function shouldAutoSearchWeb(value: string): boolean {
  return /(?:web-search|web_search|搜索|搜一下|查找|检索|联网|新闻|最新|动态|\bsearch\b|\blatest\b|\bnews\b|\bcurrent\b)/i.test(value);
}

function searchQueryFromTask(task: Task): string {
  const input = task.input.replace(/^Goal:\s*/i, "").trim();
  const firstLine = input.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || input;
  return firstLine
    .replace(/^(?:请|帮我|麻烦你|please)\s*/i, "")
    .replace(/^(?:搜索|搜一下|查找|检索)\s*/i, "")
    .slice(0, 240)
    .trim() || input.slice(0, 240).trim() || "current news";
}

function normalizeToolApproval(value: unknown): ToolApproval | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return {
    approved: input.approved === true,
    template: typeof input.template === "string" ? input.template as ToolApproval["template"] : undefined,
    reason: typeof input.reason === "string" ? input.reason : undefined,
    approvedBy: typeof input.approvedBy === "string" ? input.approvedBy : undefined,
    expiresAt: typeof input.expiresAt === "string" ? input.expiresAt : undefined,
    scope: typeof input.scope === "string" ? input.scope : undefined,
  };
}

function extractHttpUrls(value: string): string[] {
  return unique([...String(value || "").matchAll(/https?:\/\/[^\s`"'<>]+/gi)]
    .map((match) => match[0].replace(/[),.;，。；、]+$/g, "")));
}

function dedupeToolRequests(requests: PlannedToolRequest[]): PlannedToolRequest[] {
  const seen = new Set<string>();
  const result: PlannedToolRequest[] = [];
  for (const request of requests) {
    const key = `${request.tool}:${JSON.stringify(request.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(request);
  }
  return result;
}

function requiredMaterializationError({
  role,
  task,
  toolGateway,
  toolExecutionResults,
}: {
  role: string;
  task: Task;
  toolGateway: ToolGateway;
  toolExecutionResults: ToolExecutionResult[];
}): string {
  if (role !== "developer") return "";
  if (!requiresFileMaterialization(task)) return "";
  if (!toolGateway.canUse("write_file")) {
    return "Developer task requires creating or editing files, but write_file is not allowed for this role or permission mode.";
  }
  const writeResults = toolExecutionResults.filter((result) => result.tool === "write_file");
  const requiredFiles = readStringArray(task.metadata.requiredFiles);
  if (requiredFiles.length) {
    const okWritePaths = new Set(writeResults
      .filter((result) => result.ok)
      .map((result) => outputPath(result.output))
      .filter(Boolean)
      .map(normalizeMaterializedPath));
    const missingWrites = requiredFiles.filter((file) => !okWritePaths.has(normalizeMaterializedPath(file)));
    const missingOnDisk = requiredFiles.filter((file) => !materializedFileExists(file));
    if (!missingWrites.length && !missingOnDisk.length) return "";
    return [
      "Developer task requires final artifact materialization, but required files were not all written and present.",
      missingWrites.length ? `Missing successful write_file execution for: ${missingWrites.join(", ")}` : "",
      missingOnDisk.length ? `Missing on disk: ${missingOnDisk.join(", ")}` : "",
      ...writeResults.map((result) => result.error ? `${result.tool}: ${result.error}` : `${result.tool}: ${result.ok ? "ok" : "failed"}`),
    ].filter(Boolean).join(" ");
  }
  if (writeResults.some((result) => result.ok)) return "";
  if (!writeResults.length) {
    return [
      "Developer task requires creating or editing files, but the model returned no executable write_file toolRequests.",
      "The developer response must include a JSON block like {\"toolRequests\":[{\"tool\":\"write_file\",\"args\":{\"path\":\"index.html\",\"content\":\"...\"}}]}.",
    ].join(" ");
  }
  return [
    "Developer task requires creating or editing files, but every write_file tool execution failed.",
    ...writeResults.map((result) => result.error ? `${result.tool}: ${result.error}` : `${result.tool}: failed`),
  ].join(" ");
}

function requiresFileMaterialization(task: Task): boolean {
  const text = taskMaterializationText(task);
  if (/(?:^|[\s`'"])(?:~\/|\/|\.{1,2}\/)?[A-Za-z0-9_./-]+\.(?:html|css|js|jsx|ts|tsx|json|md|txt)(?:[:\s`'",)]|$)/i.test(text)) return true;
  return /(?:保存|保存到|输出到|写入|落盘|生成|编写|写一个|写代码|创建|新建|修改|更新|编辑).{0,40}(?:文件|代码|源码|网页|页面|HTML|html|index|artifact|file|code|source)/i.test(text)
    || /(?:write|create|generate|edit|update|scaffold).{0,40}(?:file|code|source|html|page|artifact)/i.test(text);
}

function taskMaterializationText(task: Task): string {
  return [
    task.title,
    task.input,
    Array.isArray(task.metadata.acceptanceCriteria) ? task.metadata.acceptanceCriteria.join("\n") : "",
    Array.isArray(task.metadata.requiredFiles) ? task.metadata.requiredFiles.join("\n") : "",
  ].join("\n");
}

function outputPath(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const pathValue = (value as { path?: unknown }).path;
    return typeof pathValue === "string" ? pathValue : "";
  }
  return "";
}

function materializedFileExists(filePath: string): boolean {
  const resolved = normalizeMaterializedPath(filePath);
  if (!existsSync(resolved)) return false;
  try {
    return statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function normalizeMaterializedPath(filePath: string): string {
  const expanded = filePath.startsWith("~/") ? path.join(homedir(), filePath.slice(2)) : filePath;
  return path.resolve(process.cwd(), expanded);
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
