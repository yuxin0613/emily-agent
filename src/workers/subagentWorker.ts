import { SubAgent } from "../agents/SubAgent.ts";
import type { ModelProvider } from "../llm/ModelProvider.ts";
import { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import { readRoleDefinition } from "../roles/RoleDefinitionLoader.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { createTaskResult, serializeTaskResult } from "../tasks/TaskResult.ts";
import { ToolGateway } from "../tools/ToolGateway.ts";
import type { Task, TaskResult } from "../types.ts";

interface StartMessage {
  type: "task.start";
  taskId: string;
  role: string;
  agentId: string;
  dataDir: string;
  leaseMs?: number;
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

async function runTask({ taskId, role, agentId, dataDir, leaseMs = 30000 }: StartMessage): Promise<void> {
  const taskStore = await TaskStore.create({ dataDir });
  const memory = await MemorySystem.create({ dataDir });
  const providerRegistry = await ProviderRegistry.create({ dataDir, persist: false });
  let eventId: number | null = null;

  const heartbeat = setInterval(() => {
    process.send?.({
      type: "agent.heartbeat",
      taskId,
      role,
      agentId,
    });
  }, Math.max(1000, Math.floor(leaseMs / 3)));

  try {
    eventId = taskStore.claimTask(taskId, agentId, { leaseMs });
    await taskStore.writeTaskMarkdown(taskId);
    notify("task.changed", { taskId, eventId });

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
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    if (error instanceof TaskCancelledError) {
      eventId = taskStore.cancelTask(taskId, {
        reason: error.message,
        agentId,
      });
    } else {
      eventId = taskStore.failTask(taskId, {
        error: message,
        result: serializeTaskResult(createTaskResult({
          status: "failed",
          summary: `任务执行失败：${error instanceof Error ? error.message : String(error)}`,
        })),
        agentId,
      });
    }
  } finally {
    clearInterval(heartbeat);

    const finalTask = taskStore.getTask(taskId);
    if (finalTask?.status === "running") {
      eventId = taskStore.failTask(taskId, {
        error: "Worker reached finally without a terminal status.",
        result: "任务没有产生明确结果，已由 worker finally 兜底标记失败。",
        agentId,
      });
    }

    await taskStore.writeTaskMarkdown(taskId);
    notify("task.changed", { taskId, eventId });
    notify("task.finished", { taskId, eventId });
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
  const toolGateway = new ToolGateway(definition);
  toolGateway.assertAllowed("read_file");
  if (typeof task.metadata.forceDelayMs === "number") {
    await sleep(task.metadata.forceDelayMs);
  }

  const relevantMemory = await memory.recall(task.input, {
    scope: String(task.metadata.sessionId || "default"),
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
      `Allowed tools: ${toolGateway.listAllowed().join(", ") || "(none)"}`,
      "",
      "Task:",
      task.input,
    ].join("\n"),
    sessionId: String(task.metadata.sessionId || "default"),
    relevantMemory,
  });
  throwIfCancelled(task.id);

  const memoryContent = response.content;
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
    summary: response.content,
    artifacts: [{
      type: "provider-call",
      title: `${response.provider.id}/${response.provider.model}`,
      metadata: {
        providerId: response.provider.id,
        model: response.provider.model,
        latencyMs: response.provider.latencyMs,
      },
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

function notify(type: string, payload: { taskId: string; eventId: number | null }): void {
  process.send?.({
    type,
    ...payload,
  });
}

function isStartMessage(message: unknown): message is StartMessage {
  return Boolean(
    message
      && typeof message === "object"
      && (message as StartMessage).type === "task.start"
      && typeof (message as StartMessage).taskId === "string",
  );
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
