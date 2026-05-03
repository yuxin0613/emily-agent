import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AgentStatus, MemoryCandidate, Metadata, Run, Task, TaskDependency, TaskEvent, TaskGraph, TaskStatus, Timeline } from "../types.ts";
import { SchemaMigrator } from "../storage/SchemaMigrator.ts";
import { IllegalTaskTransitionError, TaskTransitionConflictError } from "./errors.ts";
import { RuntimeEventFactory } from "../events/RuntimeEventFactory.ts";

const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed", "blocked", "dead_letter"]);

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["queued", "running", "blocked", "dead_letter"],
  queued: ["running", "pending", "dead_letter"],
  running: ["done", "failed", "blocked", "needs_inspection", "dead_letter"],
  blocked: ["pending", "queued", "dead_letter"],
  needs_inspection: ["queued", "running", "done", "failed", "dead_letter"],
  done: [],
  failed: ["queued", "dead_letter"],
  dead_letter: [],
};

interface CreateTaskInput {
  role: string;
  title: string;
  input: string;
  parentTaskId?: string | null;
  metadata?: Metadata;
  maxRetries?: number;
}

interface CreateRunInput {
  sessionId: string;
  source: string;
  userInput: string;
}

export class TaskStore {
  dataDir: string;
  taskDir: string;
  db: DatabaseSync;

  static async create({ dataDir }: { dataDir: string }): Promise<TaskStore> {
    const taskDir = path.join(dataDir, "tasks");
    await mkdir(taskDir, { recursive: true });

    const store = new TaskStore({
      dataDir,
      taskDir,
      dbPath: path.join(dataDir, "emily.sqlite"),
    });
    store.migrate();
    return store;
  }

  constructor({ dataDir, taskDir, dbPath }: { dataDir: string; taskDir: string; dbPath: string }) {
    this.dataDir = dataDir;
    this.taskDir = taskDir;
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }

  migrate(): void {
    new SchemaMigrator({ db: this.db, namespace: "task" }).apply([
      {
        version: 1,
        name: "create_task_runtime_tables",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS agents (
              id TEXT PRIMARY KEY,
              role TEXT NOT NULL,
              status TEXT NOT NULL,
              current_task_id TEXT,
              heartbeat_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_role ON agents(role);

            CREATE TABLE IF NOT EXISTS tasks (
              id TEXT PRIMARY KEY,
              role TEXT NOT NULL,
              status TEXT NOT NULL,
              title TEXT NOT NULL,
              input TEXT NOT NULL,
              result TEXT,
              error TEXT,
              assigned_agent_id TEXT,
              parent_task_id TEXT,
              metadata TEXT NOT NULL,
              retry_count INTEGER NOT NULL DEFAULT 0,
              max_retries INTEGER NOT NULL DEFAULT 1,
              lease_owner TEXT,
              lease_expires_at TEXT,
              heartbeat_at TEXT,
              main_ack_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_tasks_role_status ON tasks(role, status);
            CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(assigned_agent_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_expires_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_ack ON tasks(status, main_ack_at);

            CREATE TABLE IF NOT EXISTS role_queues (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              role TEXT NOT NULL,
              task_id TEXT NOT NULL UNIQUE,
              priority INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_role_queues_next ON role_queues(role, status, priority DESC, id ASC);

            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL,
              task_id TEXT,
              agent_id TEXT,
              payload TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
          `);
        },
      },
      {
        version: 2,
        name: "create_runs_dependencies_memory_candidates",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS runs (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              source TEXT NOT NULL,
              user_input TEXT NOT NULL,
              status TEXT NOT NULL,
              started_at TEXT NOT NULL,
              completed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at DESC);

            CREATE TABLE IF NOT EXISTS task_dependencies (
              task_id TEXT NOT NULL,
              depends_on_task_id TEXT NOT NULL,
              dependency_type TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (task_id, depends_on_task_id)
            );

            CREATE INDEX IF NOT EXISTS idx_task_dependencies_depends ON task_dependencies(depends_on_task_id);

            CREATE TABLE IF NOT EXISTS memory_candidates (
              id TEXT PRIMARY KEY,
              run_id TEXT,
              task_id TEXT,
              scope TEXT NOT NULL,
              kind TEXT NOT NULL,
              content TEXT NOT NULL,
              status TEXT NOT NULL,
              created_by TEXT NOT NULL,
              created_at TEXT NOT NULL,
              decided_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_memory_candidates_status ON memory_candidates(status, run_id, task_id);
          `);
        },
      },
      {
        version: 3,
        name: "create_task_graphs",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS task_graphs (
              id TEXT PRIMARY KEY,
              run_id TEXT,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              completed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_task_graphs_run ON task_graphs(run_id, status);
          `);
        },
      },
    ]);

    this.ensureColumn("tasks", "retry_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "max_retries", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("tasks", "lease_owner", "TEXT");
    this.ensureColumn("tasks", "lease_expires_at", "TEXT");
    this.ensureColumn("tasks", "heartbeat_at", "TEXT");
    this.ensureColumn("tasks", "main_ack_at", "TEXT");
  }

  ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createTask({
    role,
    title,
    input,
    parentTaskId = null,
    metadata = {},
    maxRetries = 1,
  }: CreateTaskInput): Task & { eventId: number } {
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      role,
      status: "pending",
      title,
      input,
      result: null,
      error: null,
      assignedAgentId: null,
      parentTaskId,
      metadata,
      retryCount: 0,
      maxRetries,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      mainAckAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(`
        INSERT INTO tasks (
          id, role, status, title, input, result, error, assigned_agent_id,
          parent_task_id, metadata, retry_count, max_retries, lease_owner,
          lease_expires_at, heartbeat_at, main_ack_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.role,
        task.status,
        task.title,
        task.input,
        task.result,
        task.error,
        task.assignedAgentId,
        task.parentTaskId,
        JSON.stringify(task.metadata),
        task.retryCount,
        task.maxRetries,
        task.leaseOwner,
        task.leaseExpiresAt,
        task.heartbeatAt,
        task.mainAckAt,
        task.createdAt,
        task.updatedAt,
      );

    const eventId = this.addEvent({
      type: "task.created",
      taskId: task.id,
      payload: { role, title },
    });

    return { ...task, eventId };
  }

  createRun({ sessionId, source, userInput }: CreateRunInput): Run {
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      sessionId,
      source,
      userInput,
      status: "running",
      startedAt: now,
      completedAt: null,
    };
    this.db
      .prepare("INSERT INTO runs (id, session_id, source, user_input, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, run.sessionId, run.source, run.userInput, run.status, run.startedAt, run.completedAt);
    this.addEvent(RuntimeEventFactory.runStarted(run));
    return run;
  }

  completeRun(runId: string, status: Run["status"] = "done"): number {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?")
      .run(status, now, runId);
    return this.addEvent(RuntimeEventFactory.runCompleted(runId, status));
  }

  getRun(runId: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    return row ? parseRun(row) : null;
  }

  addTaskDependency(taskId: string, dependsOnTaskId: string, dependencyType: TaskDependency["dependencyType"] = "success"): void {
    this.db
      .prepare("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, dependency_type, created_at) VALUES (?, ?, ?, ?)")
      .run(taskId, dependsOnTaskId, dependencyType, new Date().toISOString());
    this.addEvent({
      type: "task.dependency.created",
      taskId,
      payload: { dependsOnTaskId, dependencyType },
    });
  }

  createTaskGraph({ runId = null }: { runId?: string | null } = {}): TaskGraph {
    const graph: TaskGraph = {
      id: randomUUID(),
      runId,
      status: "pending",
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.db
      .prepare("INSERT INTO task_graphs (id, run_id, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?)")
      .run(graph.id, graph.runId, graph.status, graph.createdAt, graph.completedAt);
    this.addEvent({
      type: "task_graph.created",
      payload: { graphId: graph.id, runId },
    });
    return graph;
  }

  completeTaskGraph(graphId: string, status: TaskGraph["status"] = "done"): void {
    this.db
      .prepare("UPDATE task_graphs SET status = ?, completed_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), graphId);
    this.addEvent({
      type: "task_graph.completed",
      payload: { graphId, status },
    });
  }

  getDependencies(taskId: string): TaskDependency[] {
    const rows = this.db
      .prepare("SELECT * FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as TaskDependencyRow[];
    return rows.map(parseDependency);
  }

  getDependents(taskId: string): Task[] {
    const rows = this.db
      .prepare(`
        SELECT t.* FROM tasks t
        JOIN task_dependencies d ON d.task_id = t.id
        WHERE d.depends_on_task_id = ?
      `)
      .all(taskId) as TaskRow[];
    return rows.map(parseTask);
  }

  dependenciesSatisfied(taskId: string): boolean {
    const rows = this.db
      .prepare(`
        SELECT d.dependency_type, t.status
        FROM task_dependencies d
        JOIN tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = ?
      `)
      .all(taskId) as Array<{ dependency_type: TaskDependency["dependencyType"]; status: TaskStatus }>;
    return rows.every((row) => row.dependency_type === "finished"
      ? TERMINAL_STATUSES.has(row.status)
      : row.status === "done");
  }

  enqueueTask(taskId: string, { priority = 0 }: { priority?: number } = {}): number {
    const task = this.getTaskOrThrow(taskId);
    if (!this.dependenciesSatisfied(taskId)) {
      return this.addEvent({
        type: "task.waiting",
        taskId,
        agentId: task.assignedAgentId,
        payload: { reason: "dependencies not satisfied" },
      });
    }
    const eventId = this.transitionTask(taskId, "queued", {
      reason: "queued for role worker",
      metadata: task.metadata,
    });
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO role_queues (role, task_id, priority, status, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          priority = excluded.priority,
          status = 'queued',
          updated_at = excluded.updated_at
      `)
      .run(task.role, taskId, priority, now, now);
    return eventId;
  }

  claimNextQueuedTask(role: string, agentId: string, leaseMs: number): Task | null {
    const row = this.db
      .prepare(
        "SELECT * FROM role_queues WHERE role = ? AND status = 'queued' ORDER BY priority DESC, id ASC LIMIT 1",
      )
      .get(role) as { task_id: string } | undefined;
    if (!row) return null;

    const queueUpdate = this.db
      .prepare("UPDATE role_queues SET status = 'running', updated_at = ? WHERE task_id = ?")
      .run(new Date().toISOString(), row.task_id);
    if (queueUpdate.changes === 0) return null;
    this.claimTask(row.task_id, agentId, { leaseMs });
    return this.getTask(row.task_id);
  }

  completeQueueItem(taskId: string, status: "done" | "failed" | "dead_letter" = "done"): void {
    this.db
      .prepare("UPDATE role_queues SET status = ?, updated_at = ? WHERE task_id = ?")
      .run(status, new Date().toISOString(), taskId);
  }

  claimTask(taskId: string, agentId: string, { leaseMs = 30000 }: { leaseMs?: number } = {}): number {
    const task = this.getTaskOrThrow(taskId);
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    return this.transitionTask(taskId, "running", {
      agentId,
      reason: "claimed by worker",
      patch: {
        assignedAgentId: agentId,
        leaseOwner: agentId,
        leaseExpiresAt,
        heartbeatAt: now.toISOString(),
        metadata: task.metadata,
      },
    });
  }

  heartbeatTask(taskId: string, agentId: string, { leaseMs = 30000 }: { leaseMs?: number } = {}): number {
    const task = this.getTaskOrThrow(taskId);
    if (task.status !== "running") {
      return this.addEvent({
        type: "task.heartbeat_ignored",
        taskId,
        agentId,
        payload: { status: task.status },
      });
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    this.db
      .prepare(
        "UPDATE tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now.toISOString(), leaseExpiresAt, now.toISOString(), taskId);

    return this.addEvent({
      type: "task.heartbeat",
      taskId,
      agentId,
      payload: { leaseExpiresAt },
    });
  }

  transitionTask(
    taskId: string,
    nextStatus: TaskStatus,
    options: {
      agentId?: string | null;
      reason?: string;
      result?: string | null;
      error?: string | null;
      patch?: Partial<Task>;
      metadata?: Metadata;
    } = {},
  ): number {
    const task = this.getTaskOrThrow(taskId);
    if (!ALLOWED_TRANSITIONS[task.status].includes(nextStatus) && task.status !== nextStatus) {
      throw new IllegalTaskTransitionError(`Illegal task transition: ${task.status} -> ${nextStatus}`);
    }

    const now = new Date().toISOString();
    const patch = options.patch || {};
    const terminal = TERMINAL_STATUSES.has(nextStatus);
    const retryCount = patch.retryCount ?? task.retryCount;

    const result = this.db
      .prepare(`
        UPDATE tasks
        SET status = ?,
            result = ?,
            error = ?,
            assigned_agent_id = ?,
            metadata = ?,
            retry_count = ?,
            max_retries = ?,
            lease_owner = ?,
            lease_expires_at = ?,
            heartbeat_at = ?,
            main_ack_at = ?,
            updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        nextStatus,
        options.result ?? patch.result ?? task.result,
        options.error ?? patch.error ?? task.error,
        patch.assignedAgentId ?? task.assignedAgentId,
        JSON.stringify(options.metadata ?? patch.metadata ?? task.metadata),
        retryCount,
        patch.maxRetries ?? task.maxRetries,
        terminal ? null : (patch.leaseOwner ?? task.leaseOwner),
        terminal ? null : (patch.leaseExpiresAt ?? task.leaseExpiresAt),
        patch.heartbeatAt ?? task.heartbeatAt,
        patch.mainAckAt ?? task.mainAckAt,
        now,
        taskId,
        task.status,
      );
    if (result.changes === 0) {
      throw new TaskTransitionConflictError(`Task transition conflict: ${taskId} expected ${task.status}`);
    }

    return this.addEvent({
      type: `task.${nextStatus}`,
      taskId,
      agentId: options.agentId ?? patch.assignedAgentId ?? task.assignedAgentId,
      payload: {
        ...RuntimeEventFactory.taskTransition(task.status, nextStatus, options.reason || null),
      },
    });
  }

  finishTask(taskId: string, { result, agentId }: { result: string; agentId?: string | null }): number {
    this.completeQueueItem(taskId, "done");
    const eventId = this.transitionTask(taskId, "done", {
      agentId,
      result,
      error: null,
      reason: "worker completed",
    });
    this.releaseReadyDependents(taskId);
    return eventId;
  }

  failTask(
    taskId: string,
    { error, result, agentId }: { error: string; result?: string | null; agentId?: string | null },
  ): number {
    const task = this.getTaskOrThrow(taskId);
    const retryCount = task.retryCount + 1;
    const nextStatus: TaskStatus = retryCount > task.maxRetries ? "dead_letter" : "failed";
    this.completeQueueItem(taskId, nextStatus);
    const eventId = this.transitionTask(taskId, nextStatus, {
      agentId,
      result: result ?? task.result,
      error,
      reason: nextStatus === "dead_letter" ? "max retries exceeded" : "worker failed",
      patch: {
        retryCount,
        metadata: {
          ...task.metadata,
          lastError: error,
          deadLetterReason: nextStatus === "dead_letter" ? "max retries exceeded" : null,
        },
      },
    });
    this.releaseReadyDependents(taskId);
    return eventId;
  }

  releaseReadyDependents(taskId: string): string[] {
    const released: string[] = [];
    for (const dependent of this.getDependents(taskId)) {
      if (dependent.status !== "pending" && dependent.status !== "blocked") continue;
      if (!this.dependenciesSatisfied(dependent.id)) continue;
      this.enqueueTask(dependent.id);
      released.push(dependent.id);
    }
    return released;
  }

  createMemoryCandidate({
    runId = null,
    taskId = null,
    scope,
    kind,
    content,
    createdBy,
  }: {
    runId?: string | null;
    taskId?: string | null;
    scope: string;
    kind: string;
    content: string;
    createdBy: string;
  }): MemoryCandidate {
    const candidate: MemoryCandidate = {
      id: randomUUID(),
      runId,
      taskId,
      scope,
      kind,
      content,
      status: "pending",
      createdBy,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    this.db
      .prepare(`
        INSERT INTO memory_candidates (id, run_id, task_id, scope, kind, content, status, created_by, created_at, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(candidate.id, candidate.runId, candidate.taskId, candidate.scope, candidate.kind, candidate.content, candidate.status, candidate.createdBy, candidate.createdAt, candidate.decidedAt);
    this.addEvent({
      type: "memory.candidate.created",
      taskId,
      payload: RuntimeEventFactory.memoryCandidate(candidate.id, runId, scope, kind, createdBy),
    });
    return candidate;
  }

  decideMemoryCandidate(candidateId: string, status: "approved" | "rejected"): MemoryCandidate {
    this.db
      .prepare("UPDATE memory_candidates SET status = ?, decided_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), candidateId);
    const candidate = this.getMemoryCandidate(candidateId);
    if (!candidate) throw new Error(`Memory candidate not found: ${candidateId}`);
    this.addEvent({
      type: status === "approved" ? "memory.candidate.approved" : "memory.candidate.rejected",
      taskId: candidate.taskId,
      payload: RuntimeEventFactory.candidateLifecycle(candidateId, candidate.runId, status),
    });
    return candidate;
  }

  getPendingMemoryCandidates({ runId, limit = 20 }: { runId?: string; limit?: number } = {}): MemoryCandidate[] {
    const rows = runId
      ? this.db
        .prepare("SELECT * FROM memory_candidates WHERE status = 'pending' AND run_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(runId, limit) as MemoryCandidateRow[]
      : this.db
        .prepare("SELECT * FROM memory_candidates WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
        .all(limit) as MemoryCandidateRow[];
    return rows.map(parseMemoryCandidate);
  }

  getMemoryCandidate(candidateId: string): MemoryCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM memory_candidates WHERE id = ?")
      .get(candidateId) as MemoryCandidateRow | undefined;
    return row ? parseMemoryCandidate(row) : null;
  }

  getMemoryCandidatesForRun(runId: string): MemoryCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_candidates WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as MemoryCandidateRow[];
    return rows.map(parseMemoryCandidate);
  }

  markNeedsInspection(taskId: string, reason: string, metadata: Metadata = {}): number {
    const task = this.getTaskOrThrow(taskId);
    return this.transitionTask(taskId, "needs_inspection", {
      reason,
      metadata: {
        ...task.metadata,
        ...metadata,
        inspectionReason: reason,
      },
    });
  }

  acknowledgeTask(taskId: string): number {
    const task = this.getTaskOrThrow(taskId);
    this.db
      .prepare("UPDATE tasks SET main_ack_at = ?, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), new Date().toISOString(), taskId);
    return this.addEvent({
      type: "task.acknowledged",
      taskId,
      agentId: task.assignedAgentId,
      payload: { by: "main-agent" },
    });
  }

  addEvent({
    type,
    taskId = null,
    agentId = null,
    payload = {},
  }: {
    type: string;
    taskId?: string | null;
    agentId?: string | null;
    payload?: Metadata;
  }): number {
    const result = this.db
      .prepare(
        "INSERT INTO events (type, task_id, agent_id, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(type, taskId, agentId, JSON.stringify(payload), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  upsertAgent({
    id,
    role,
    status,
    currentTaskId = null,
  }: {
    id: string;
    role: string;
    status: AgentStatus;
    currentTaskId?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO agents (id, role, status, current_task_id, heartbeat_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(role) DO UPDATE SET
          id = excluded.id,
          status = excluded.status,
          current_task_id = excluded.current_task_id,
          heartbeat_at = excluded.heartbeat_at,
          updated_at = excluded.updated_at
      `)
      .run(id, role, status, currentTaskId, now, now, now);
  }

  heartbeatAgent({ id, role, currentTaskId = null }: { id: string; role: string; currentTaskId?: string | null }): void {
    this.upsertAgent({
      id,
      role,
      status: "running",
      currentTaskId,
    });
    if (currentTaskId) {
      this.heartbeatTask(currentTaskId, id);
    }
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    return row ? parseTask(row) : null;
  }

  getTaskOrThrow(taskId: string): Task {
    const task = this.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  getTasksByIds(taskIds: string[]): Task[] {
    return taskIds.map((taskId) => this.getTask(taskId)).filter((task): task is Task => Boolean(task));
  }

  getRunningTasksForAgent(agentId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE assigned_agent_id = ? AND status = 'running'")
      .all(agentId) as TaskRow[];
    return rows.map(parseTask);
  }

  getExpiredLeaseTasks(): Task[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
      .all(now) as TaskRow[];
    return rows.map(parseTask);
  }

  getNeedsInspectionWithoutInspector(): Task[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM tasks
        WHERE status = 'needs_inspection'
          AND (
            json_extract(metadata, '$.inspectionTaskId') IS NULL
            OR json_extract(metadata, '$.inspectionTaskId') = ''
          )
      `)
      .all() as TaskRow[];
    return rows.map(parseTask);
  }

  getUnacknowledgedTerminalTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status IN ('done', 'failed', 'blocked', 'dead_letter') AND main_ack_at IS NULL",
      )
      .all() as TaskRow[];
    return rows.map(parseTask);
  }

  getTerminalTasksBetween({
    start,
    end,
    limit = 100,
  }: {
    start: string;
    end: string;
    limit?: number;
  }): Task[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM tasks
        WHERE status IN ('done', 'failed', 'dead_letter')
          AND updated_at >= ?
          AND updated_at < ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(start, end, limit) as TaskRow[];
    return rows.map(parseTask);
  }

  getLatestEvents({ limit = 20, afterId = 0 }: { limit?: number; afterId?: number } = {}): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit) as EventRow[];
    return rows.map(parseEvent);
  }

  getTimeline({ runId }: { runId: string }): Timeline {
    const run = this.getRun(runId);
    const tasks = this.getTasksForRun(runId);
    const taskIds = new Set(tasks.map((task) => task.id));
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY id ASC")
      .all() as EventRow[];
    const events = rows
      .map(parseEvent)
      .filter((event) => event.payload.runId === runId || (event.taskId && taskIds.has(event.taskId)));
    return { run, tasks, events };
  }

  getTaskTrace(taskId: string): Timeline {
    const task = this.getTask(taskId);
    const runId = typeof task?.metadata.runId === "string" ? task.metadata.runId : "";
    const run = runId ? this.getRun(runId) : null;
    const rows = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id ASC")
      .all(taskId) as EventRow[];
    return {
      run,
      tasks: task ? [task] : [],
      events: rows.map(parseEvent),
    };
  }

  getTasksForRun(runId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE json_extract(metadata, '$.runId') = ? ORDER BY created_at ASC")
      .all(runId) as TaskRow[];
    return rows.map(parseTask);
  }

  health(): {
    pendingTasks: number;
    runningTasks: number;
    expiredLeases: number;
    unacknowledgedTerminalTasks: number;
    pendingMemoryCandidates: number;
  } {
    return {
      pendingTasks: count(this.db, "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('pending', 'queued')"),
      runningTasks: count(this.db, "SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'"),
      expiredLeases: this.getExpiredLeaseTasks().length,
      unacknowledgedTerminalTasks: this.getUnacknowledgedTerminalTasks().length,
      pendingMemoryCandidates: count(this.db, "SELECT COUNT(*) AS count FROM memory_candidates WHERE status = 'pending'"),
    };
  }

  async writeTaskMarkdown(taskId: string): Promise<string | null> {
    const task = this.getTask(taskId);
    if (!task) return null;

    const filePath = this.taskMarkdownPath(taskId);
    const body = [
      `# Task: ${task.title}`,
      "",
      `Status: ${task.status}`,
      `Role: ${task.role}`,
      `Assigned Agent: ${task.assignedAgentId || "(none)"}`,
      `Retry: ${task.retryCount}/${task.maxRetries}`,
      `Lease Owner: ${task.leaseOwner || "(none)"}`,
      `Lease Expires At: ${task.leaseExpiresAt || "(none)"}`,
      `Heartbeat At: ${task.heartbeatAt || "(none)"}`,
      `Created At: ${task.createdAt}`,
      `Updated At: ${task.updatedAt}`,
      "",
      "## Input",
      "",
      task.input,
      "",
      "## Result",
      "",
      task.result || "(none)",
      "",
      "## Error",
      "",
      task.error || "(none)",
      "",
      "## Metadata",
      "",
      "```json",
      JSON.stringify(task.metadata, null, 2),
      "```",
      "",
    ].join("\n");

    await writeFile(filePath, body, "utf8");
    return filePath;
  }

  taskMarkdownPath(taskId: string): string {
    return path.join(this.taskDir, `task-${taskId}.md`);
  }

  isTerminalStatus(status: TaskStatus): boolean {
    return TERMINAL_STATUSES.has(status);
  }

  close(): void {
    this.db.close();
  }
}

interface TaskRow {
  id: string;
  role: string;
  status: TaskStatus;
  title: string;
  input: string;
  result: string | null;
  error: string | null;
  assigned_agent_id: string | null;
  parent_task_id: string | null;
  metadata: string;
  retry_count: number;
  max_retries: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  main_ack_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: string;
  session_id: string;
  source: string;
  user_input: string;
  status: Run["status"];
  started_at: string;
  completed_at: string | null;
}

interface TaskDependencyRow {
  task_id: string;
  depends_on_task_id: string;
  dependency_type: TaskDependency["dependencyType"];
  created_at: string;
}

interface MemoryCandidateRow {
  id: string;
  run_id: string | null;
  task_id: string | null;
  scope: string;
  kind: string;
  content: string;
  status: MemoryCandidate["status"];
  created_by: string;
  created_at: string;
  decided_at: string | null;
}

interface EventRow {
  id: number;
  type: string;
  task_id: string | null;
  agent_id: string | null;
  payload: string;
  created_at: string;
}

function parseTask(row: TaskRow): Task {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    title: row.title,
    input: row.input,
    result: row.result,
    error: row.error,
    assignedAgentId: row.assigned_agent_id,
    parentTaskId: row.parent_task_id,
    metadata: JSON.parse(row.metadata || "{}") as Metadata,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    mainAckAt: row.main_ack_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    type: row.type,
    taskId: row.task_id,
    agentId: row.agent_id,
    payload: JSON.parse(row.payload || "{}") as Metadata,
    createdAt: row.created_at,
  };
}

function parseRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    userInput: row.user_input,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseDependency(row: TaskDependencyRow): TaskDependency {
  return {
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    dependencyType: row.dependency_type,
    createdAt: row.created_at,
  };
}

function parseMemoryCandidate(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    scope: row.scope,
    kind: row.kind,
    content: row.content,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}
