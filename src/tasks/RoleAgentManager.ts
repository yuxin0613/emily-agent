import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Task, TaskEvent } from "../types.ts";
import type { TaskStore } from "./TaskStore.ts";

interface RoleState {
  role: string;
  child: ChildProcess | null;
  activeTaskId: string | null;
  agentId: string;
}

interface RuntimeEvent {
  taskId: string;
  eventId: number | null;
  task: Task | null;
}

export class RoleAgentManager extends EventEmitter {
  dataDir: string;
  taskStore: TaskStore;
  workerPath: string;
  staleTaskMs: number;
  leaseMs: number;
  roles: Map<string, RoleState>;
  shuttingDown: boolean;
  reconcileTimer: NodeJS.Timeout | null;

  constructor({
    dataDir,
    taskStore,
    workerPath,
    staleTaskMs = 30000,
    leaseMs = 30000,
  }: {
    dataDir: string;
    taskStore: TaskStore;
    workerPath: string;
    staleTaskMs?: number;
    leaseMs?: number;
  }) {
    super();
    this.dataDir = dataDir;
    this.taskStore = taskStore;
    this.workerPath = workerPath;
    this.staleTaskMs = staleTaskMs;
    this.leaseMs = leaseMs;
    this.roles = new Map();
    this.shuttingDown = false;
    this.reconcileTimer = null;
  }

  async start(): Promise<void> {
    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((error) => this.emit("error", error));
    }, Math.max(5000, Math.floor(this.staleTaskMs / 2)));
  }

  async enqueue(task: Task): Promise<void> {
    const eventId = this.taskStore.enqueueTask(task.id);
    await this.taskStore.writeTaskMarkdown(task.id);
    this.emitTaskEvent("task.changed", task.id, eventId);
    this.drainRole(task.role);
  }

  async runTask(task: Task, { timeoutMs = 60000 }: { timeoutMs?: number } = {}): Promise<Task> {
    const finished = this.waitForTask(task.id, { timeoutMs });
    await this.enqueue(task);
    return finished;
  }

  waitForTask(taskId: string, { timeoutMs }: { timeoutMs: number }): Promise<Task> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for task ${taskId}`));
      }, timeoutMs);

      const onEvent = (event: RuntimeEvent) => {
        if (event.taskId !== taskId) return;
        const task = this.taskStore.getTask(taskId);
        if (!task || !this.taskStore.isTerminalStatus(task.status)) return;
        cleanup();
        resolve(task);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off("task.finished", onEvent);
        this.off("task.changed", onEvent);
        this.off("error", onError);
      };

      this.on("task.finished", onEvent);
      this.on("task.changed", onEvent);
      this.on("error", onError);
    });
  }

  async enqueueInspection(targetTask: Task, reason: string): Promise<Task | null> {
    if (targetTask.role === "inspector") return null;
    if (typeof targetTask.metadata.inspectionTaskId === "string") return null;

    const inspectionTask = this.taskStore.createTask({
      role: "inspector",
      title: `Inspect task ${targetTask.id}`,
      input: [
        `Inspect task ${targetTask.id}.`,
        `Reason: ${reason}`,
        "Check the database row and task markdown, then mark whether it has a usable result.",
      ].join("\n"),
      parentTaskId: targetTask.id,
      metadata: {
        targetTaskId: targetTask.id,
        reason,
      },
      maxRetries: 0,
    });

    this.taskStore.markNeedsInspection(targetTask.id, reason, {
      inspectionTaskId: inspectionTask.id,
    });
    this.taskStore.completeQueueItem(targetTask.id, "failed");

    await this.taskStore.writeTaskMarkdown(targetTask.id);
    await this.enqueue(inspectionTask);
    return inspectionTask;
  }

  async reconcile(): Promise<{
    expiredLeaseTasks: Task[];
    needsInspectionTasks: Task[];
    unacknowledgedTerminalTasks: Task[];
  }> {
    const expiredLeaseTasks = this.taskStore.getExpiredLeaseTasks();
    for (const task of expiredLeaseTasks) {
      await this.enqueueInspection(task, "lease expired");
    }

    const needsInspectionTasks = this.taskStore.getNeedsInspectionWithoutInspector();
    for (const task of needsInspectionTasks) {
      await this.enqueueInspection(task, "needs inspection without inspector task");
    }

    const unacknowledgedTerminalTasks = this.taskStore.getUnacknowledgedTerminalTasks();
    for (const task of unacknowledgedTerminalTasks) {
      this.emitTaskEvent("task.changed", task.id, null);
    }

    for (const role of ["planner", "developer", "researcher", "inspector", "memory-curator"]) {
      this.drainRole(role);
    }

    return { expiredLeaseTasks, needsInspectionTasks, unacknowledgedTerminalTasks };
  }

  getRoleState(role: string): RoleState {
    if (!this.roles.has(role)) {
      this.roles.set(role, {
        role,
        child: null,
        activeTaskId: null,
        agentId: `${role}-${process.pid}`,
      });
    }
    return this.roles.get(role)!;
  }

  drainRole(role: string): void {
    const roleState = this.getRoleState(role);
    if (roleState.activeTaskId) return;

    const task = this.taskStore.claimNextQueuedTask(role, roleState.agentId, this.leaseMs);
    if (!task) return;

    const child = this.ensureWorker(roleState);
    roleState.activeTaskId = task.id;
    child.send?.({
      type: "task.start",
      taskId: task.id,
      role,
      agentId: roleState.agentId,
      dataDir: this.dataDir,
      leaseMs: this.leaseMs,
    });
  }

  ensureWorker(roleState: RoleState): ChildProcess {
    if (roleState.child && !roleState.child.killed && roleState.child.connected) {
      return roleState.child;
    }

    const child = fork(this.workerPath, [], {
      cwd: process.cwd(),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        EMILY_DATA_DIR: this.dataDir,
      },
    });

    roleState.child = child;
    this.taskStore.upsertAgent({
      id: roleState.agentId,
      role: roleState.role,
      status: "idle",
    });

    child.on("message", (message) => {
      this.handleWorkerMessage(roleState, message).catch((error) => {
        this.emit("error", error);
      });
    });

    child.on("exit", (code, signal) => {
      this.handleWorkerExit(roleState, { code, signal }).catch((error) => {
        this.emit("error", error);
      });
    });

    return child;
  }

  async handleWorkerMessage(roleState: RoleState, message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return;
    const payload = message as { type?: string; taskId?: string; eventId?: number };

    if (payload.type === "task.changed" && payload.taskId) {
      await this.taskStore.writeTaskMarkdown(payload.taskId);
      this.emitTaskEvent("task.changed", payload.taskId, payload.eventId ?? null);
    }

    if (payload.type === "task.finished" && payload.taskId) {
      const task = this.taskStore.getTask(payload.taskId);
      roleState.activeTaskId = null;
      this.taskStore.upsertAgent({
        id: roleState.agentId,
        role: roleState.role,
        status: "idle",
      });
      await this.taskStore.writeTaskMarkdown(payload.taskId);
      this.emitTaskEvent("task.finished", payload.taskId, payload.eventId ?? null);
      if (task?.status && this.taskStore.isTerminalStatus(task.status)) {
        this.taskStore.completeQueueItem(payload.taskId, task.status === "done" ? "done" : "failed");
      }
      this.drainRole(roleState.role);
    }

    if (payload.type === "agent.heartbeat") {
      this.taskStore.heartbeatAgent({
        id: roleState.agentId,
        role: roleState.role,
        currentTaskId: roleState.activeTaskId,
      });
      if (roleState.activeTaskId) {
        this.emitTaskEvent("agent.heartbeat", roleState.activeTaskId, null);
      }
    }
  }

  async handleWorkerExit(roleState: RoleState, { code, signal }: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    if (this.shuttingDown) return;

    const activeTaskId = roleState.activeTaskId;
    roleState.child = null;
    roleState.activeTaskId = null;

    this.taskStore.upsertAgent({
      id: roleState.agentId,
      role: roleState.role,
      status: "exited",
    });

    if (activeTaskId) {
      const task = this.taskStore.getTask(activeTaskId);
      if (task && task.status === "running") {
        await this.enqueueInspection(
          task,
          `worker exited before completion: code=${code ?? "null"} signal=${signal ?? "null"}`,
        );
      }
    }

    this.drainRole(roleState.role);
  }

  emitTaskEvent(type: string, taskId: string, eventId: number | null): void {
    const task = this.taskStore.getTask(taskId);
    this.emit(type, {
      taskId,
      eventId,
      task,
    } satisfies RuntimeEvent);

    const latestEvent: TaskEvent | null = eventId ? this.taskStore.getLatestEvents({ afterId: eventId - 1, limit: 1 })[0] ?? null : null;
    this.emit("event", {
      type,
      taskId,
      eventId,
      task,
      event: latestEvent,
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    const exits: Array<Promise<unknown>> = [];

    for (const roleState of this.roles.values()) {
      if (roleState.child && !roleState.child.killed) {
        roleState.child.removeAllListeners("message");
        roleState.child.removeAllListeners("exit");
        exits.push(waitForExit(roleState.child));
        roleState.child.disconnect();
        roleState.child.kill();
      }
    }

    await Promise.allSettled(exits);
  }
}

function waitForExit(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}
