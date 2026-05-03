import { SubAgent } from "../agents/SubAgent.ts";
import { EchoModelProvider } from "../llm/EchoModelProvider.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import { readRoleDefinition } from "../roles/RoleDefinitionLoader.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { ToolGateway } from "../tools/ToolGateway.ts";
import type { Task } from "../types.ts";

interface StartMessage {
  type: "task.start";
  taskId: string;
  role: string;
  agentId: string;
  dataDir: string;
  leaseMs?: number;
}

process.on("message", (message: unknown) => {
  if (!isStartMessage(message)) return;
  runTask(message).catch((error: Error) => {
    process.stderr.write(`worker fatal error: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
});

async function runTask({ taskId, role, agentId, dataDir, leaseMs = 30000 }: StartMessage): Promise<void> {
  const taskStore = await TaskStore.create({ dataDir });
  const memory = await MemorySystem.create({ dataDir });
  const model = new EchoModelProvider();
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
    if (task.metadata.forceCrash) {
      process.exit(70);
    }

    const result = role === "inspector"
      ? await inspectTask({ task, taskStore })
      : await runRoleTask({ role, task, memory, model });

    eventId = taskStore.finishTask(taskId, {
      result,
      agentId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    eventId = taskStore.failTask(taskId, {
      error: message,
      result: `任务执行失败：${error instanceof Error ? error.message : String(error)}`,
      agentId,
    });
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
  model,
}: {
  role: string;
  task: Task;
  memory: MemorySystem;
  model: EchoModelProvider;
}): Promise<string> {
  const definition = await readRoleDefinition(role);
  const toolGateway = new ToolGateway(definition);
  toolGateway.assertAllowed("read_file");

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
      `Allowed tools: ${toolGateway.listAllowed().join(", ") || "(none)"}`,
      "",
      "Task:",
      task.input,
    ].join("\n"),
    sessionId: String(task.metadata.sessionId || "default"),
    relevantMemory,
  });

  return response.content;
}

async function inspectTask({ task, taskStore }: { task: Task; taskStore: TaskStore }): Promise<string> {
  const definition = await readRoleDefinition("inspector");
  const toolGateway = new ToolGateway(definition);
  toolGateway.assertAllowed("inspect_task");

  const targetTaskId = String(task.metadata.targetTaskId || "");
  const targetTask = taskStore.getTask(targetTaskId);
  if (!targetTask) {
    return `未找到需要检查的任务：${targetTaskId}`;
  }

  if (targetTask.status === "done" && targetTask.result) {
    return `检查完成：目标任务 ${targetTask.id} 已有可用结果。`;
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

  return result;
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
