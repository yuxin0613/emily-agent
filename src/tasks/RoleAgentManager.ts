import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Task, TaskEvent } from "../types.ts";
import type { TaskStore } from "./TaskStore.ts";
import { RecoveryPolicy } from "../recovery/RecoveryPolicy.ts";
import type { LifecycleHooks } from "../runtime/LifecycleHooks.ts";

const DEFAULT_ROLES = ["planner", "developer", "researcher", "reviewer", "inspector", "memory-curator"];

interface RoleState {
  role: string;
  child: ChildProcess | null;
  activeTaskId: string | null;
  activeLeaseToken: string | null;
  agentId: string;
}

interface RuntimeEvent {
  taskId: string;
  leaseToken?: string | null;
  eventId: number | null;
  task: Task | null;
}

export class RoleAgentManager extends EventEmitter {
  dataDir: string;
  taskStore: TaskStore;
  workerPath: string;
  roleDir: string;
  skillDir: string;
  staleTaskMs: number;
  leaseMs: number;
  recoveryPolicy: RecoveryPolicy;
  hooks: LifecycleHooks | null;
  roles: Map<string, RoleState>;
  shuttingDown: boolean;
  started: boolean;
  reconciling: boolean;
  reconcileTimer: NodeJS.Timeout | null;

  constructor({
    dataDir,
    taskStore,
    workerPath,
    roleDir = process.env.EMILY_ROLE_DIR || `${process.cwd()}/agents`,
    skillDir = process.env.EMILY_SKILL_DIR || `${process.cwd()}/skills`,
    staleTaskMs = 30000,
    leaseMs = 30000,
    hooks = null,
  }: {
    dataDir: string;
    taskStore: TaskStore;
    workerPath: string;
    roleDir?: string;
    skillDir?: string;
    staleTaskMs?: number;
    leaseMs?: number;
    hooks?: LifecycleHooks | null;
  }) {
    super();
    this.dataDir = dataDir;
    this.taskStore = taskStore;
    this.workerPath = workerPath;
    this.roleDir = roleDir;
    this.skillDir = skillDir;
    this.staleTaskMs = staleTaskMs;
    this.leaseMs = leaseMs;
    this.recoveryPolicy = new RecoveryPolicy();
    this.hooks = hooks;
    this.roles = new Map();
    this.shuttingDown = false;
    this.started = false;
    this.reconciling = false;
    this.reconcileTimer = null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((error) => this.emit("error", error));
    }, Math.max(5000, Math.floor(this.staleTaskMs / 2)));
  }

  async enqueue(task: Task): Promise<void> {
    await this.hooks?.emit("beforeTaskRun", {
      task,
      payload: { role: task.role, status: task.status },
    });
    const eventId = this.taskStore.enqueueTask(task.id);
    await this.taskStore.writeTaskMarkdown(task.id);
    this.emitTaskEvent("task.changed", task.id, eventId);
    this.drainRole(task.role);
  }

  async runTask(task: Task, { timeoutMs = 60000 }: { timeoutMs?: number } = {}): Promise<Task> {
    const finished = this.waitForTask(task.id, { timeoutMs });
    await this.enqueue(task);
    try {
      return await finished;
    } catch (error) {
      await this.cancelTask(task.id, `main agent timed out after ${timeoutMs}ms`);
      throw error;
    }
  }

  async cancelTask(taskId: string, reason = "cancelled by user"): Promise<Task | null> {
    const task = this.taskStore.getTask(taskId);
    if (!task) return null;
    for (const roleState of this.roles.values()) {
      if (roleState.activeTaskId !== taskId) continue;
      roleState.activeTaskId = null;
      roleState.activeLeaseToken = null;
      if (roleState.child && !roleState.child.killed) {
        roleState.child.send?.({ type: "task.cancel", taskId, reason });
        roleState.child.disconnect();
        roleState.child.kill();
      }
    }
    const eventId = this.taskStore.cancelTask(taskId, { reason });
    await this.taskStore.writeTaskMarkdown(taskId);
    this.emitTaskEvent("task.finished", taskId, eventId);
    this.drainAllRoles();
    return this.taskStore.getTask(taskId);
  }

  async cancelRun(runId: string, reason = "cancelled by user"): Promise<void> {
    for (const task of this.taskStore.getTasksForRun(runId)) {
      if (!this.taskStore.isTerminalStatus(task.status)) {
        await this.cancelTask(task.id, reason);
      }
    }
    this.taskStore.cancelRun(runId, reason);
  }

  waitForTask(taskId: string, { timeoutMs }: { timeoutMs: number }): Promise<Task> {
    const current = this.taskStore.getTask(taskId);
    if (current && this.taskStore.isTerminalStatus(current.status)) {
      return Promise.resolve(current);
    }

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
    if (this.reconciling) {
      return { expiredLeaseTasks: [], needsInspectionTasks: [], unacknowledgedTerminalTasks: [] };
    }

    this.reconciling = true;
    try {
      const expiredLeaseTasks = this.taskStore.getExpiredLeaseTasks();
      for (const task of expiredLeaseTasks) {
        await this.recoverTask(task, "lease expired");
      }

      const needsInspectionTasks = this.taskStore.getNeedsInspectionWithoutInspector();
      for (const task of needsInspectionTasks) {
        await this.enqueueInspection(task, "needs inspection without inspector task");
      }

      const unacknowledgedTerminalTasks = this.taskStore.getUnacknowledgedTerminalTasks();
      for (const task of unacknowledgedTerminalTasks) {
        this.emitTaskEvent("task.changed", task.id, null);
      }

      this.taskStore.refreshTaskGraphStatuses();
      this.drainAllRoles();

      return { expiredLeaseTasks, needsInspectionTasks, unacknowledgedTerminalTasks };
    } finally {
      this.reconciling = false;
    }
  }

  getRoleState(role: string): RoleState {
    if (!this.roles.has(role)) {
      this.roles.set(role, {
        role,
        child: null,
        activeTaskId: null,
        activeLeaseToken: null,
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
    roleState.activeLeaseToken = task.leaseToken;
    this.taskStore.upsertAgent({
      id: roleState.agentId,
      role: roleState.role,
      status: "running",
      currentTaskId: task.id,
    });

    if (!child.connected || !child.send) {
      roleState.activeTaskId = null;
      roleState.activeLeaseToken = null;
      this.recoverTask(task, "worker IPC send failed").then(() => {
        this.drainAllRoles();
      }).catch((error) => this.emit("error", error));
      return;
    }

    try {
      child.send({
        type: "task.start",
        taskId: task.id,
        role,
        agentId: roleState.agentId,
        dataDir: this.dataDir,
        leaseMs: this.leaseMs,
        leaseToken: task.leaseToken,
      });
    } catch (error) {
      roleState.activeTaskId = null;
      roleState.activeLeaseToken = null;
      this.recoverTask(task, `worker IPC send threw: ${error instanceof Error ? error.message : String(error)}`).then(() => {
        this.drainAllRoles();
      }).catch((innerError) => this.emit("error", innerError));
    }
  }

  drainAllRoles(): void {
    const roles = new Set([...DEFAULT_ROLES, ...this.roles.keys(), ...this.taskStore.getQueuedRoles()]);
    for (const role of roles) {
      this.drainRole(role);
    }
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
        EMILY_ROLE_DIR: this.roleDir,
        EMILY_SKILL_DIR: this.skillDir,
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
    const payload = message as { type?: string; taskId?: string; eventId?: number; leaseToken?: string | null };

    if (payload.type === "task.changed" && payload.taskId) {
      await this.taskStore.writeTaskMarkdown(payload.taskId);
      this.emitTaskEvent("task.changed", payload.taskId, payload.eventId ?? null);
    }

    if (payload.type === "task.finished" && payload.taskId) {
      const task = this.taskStore.getTask(payload.taskId);
      const sameActiveLease = roleState.activeLeaseToken ? payload.leaseToken === roleState.activeLeaseToken : true;
      if (roleState.activeTaskId === payload.taskId && sameActiveLease) {
        roleState.activeTaskId = null;
        roleState.activeLeaseToken = null;
        this.taskStore.upsertAgent({
          id: roleState.agentId,
          role: roleState.role,
          status: "idle",
        });
      }
      await this.taskStore.writeTaskMarkdown(payload.taskId);
      this.emitTaskEvent("task.finished", payload.taskId, payload.eventId ?? null);
      await this.hooks?.emit("afterTaskRun", {
        task: this.taskStore.getTask(payload.taskId),
        payload: { role: roleState.role, eventId: payload.eventId ?? 0 },
      });
      if (task?.status && this.taskStore.isTerminalStatus(task.status)) {
        this.taskStore.completeQueueItem(payload.taskId, task.status === "done" ? "done" : task.status === "cancelled" ? "cancelled" : "failed");
      }
      this.drainAllRoles();
    }

    if (payload.type === "agent.heartbeat") {
      this.taskStore.heartbeatAgent({
        id: roleState.agentId,
        role: roleState.role,
        currentTaskId: roleState.activeTaskId,
        leaseToken: payload.leaseToken ?? null,
        leaseMs: this.leaseMs,
      });
      if (roleState.activeTaskId) {
        this.emitTaskEvent("agent.heartbeat", roleState.activeTaskId, null);
      }
    }
  }

  async handleWorkerExit(roleState: RoleState, { code, signal }: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    if (this.shuttingDown) return;

    const activeTaskId = roleState.activeTaskId;
    const activeLeaseToken = roleState.activeLeaseToken;
    roleState.child = null;
    roleState.activeTaskId = null;
    roleState.activeLeaseToken = null;

    this.taskStore.upsertAgent({
      id: roleState.agentId,
      role: roleState.role,
      status: "exited",
    });

    if (activeTaskId) {
      const task = this.taskStore.getTask(activeTaskId);
      if (task && task.status === "running" && (!task.leaseToken || task.leaseToken === activeLeaseToken)) {
        await this.recoverTask(task, `worker exited before completion: code=${code ?? "null"} signal=${signal ?? "null"}`);
      }
    }

    this.drainAllRoles();
  }

  async recoverTask(task: Task, reason: string): Promise<void> {
    const decision = this.recoveryPolicy.decideWorkerExit(task, reason);

    if (decision.action === "finish") {
      const eventId = this.taskStore.finishTask(task.id, {
        result: task.result || "",
        agentId: task.assignedAgentId || undefined,
        bypassLease: true,
      });
      await this.taskStore.writeTaskMarkdown(task.id);
      this.emitTaskEvent("task.finished", task.id, eventId);
      return;
    }

    if (decision.action === "retry") {
      this.taskStore.failTask(task.id, {
        error: decision.reason,
        agentId: task.assignedAgentId || undefined,
        bypassLease: true,
      });
      const latest = this.taskStore.getTask(task.id);
      if (latest && latest.status === "failed") {
        await this.enqueue(latest);
      }
      return;
    }

    if (decision.action === "dead_letter") {
      const eventId = this.taskStore.failTask(task.id, {
        error: decision.reason,
        agentId: task.assignedAgentId || undefined,
        bypassLease: true,
      });
      await this.taskStore.writeTaskMarkdown(task.id);
      this.emitTaskEvent("task.finished", task.id, eventId);
      return;
    }

    await this.enqueueInspection(task, decision.reason);
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
    this.started = false;
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
