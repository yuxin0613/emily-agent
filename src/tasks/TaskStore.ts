import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentStatus, MemoryCandidate, Metadata, Run, RuntimeAnomaly, Session, SessionMessage, SessionMessageRole, SessionStatus, Task, TaskDependency, TaskEvent, TaskGraph, TaskStatus, Timeline } from "../types.ts";
import { SchemaMigrator } from "../storage/SchemaMigrator.ts";
import { openSqliteDatabase, runSqliteWithRetry, type SqliteDatabase } from "../storage/Sqlite.ts";
import { IllegalTaskTransitionError, TaskTransitionConflictError } from "./errors.ts";
import { RuntimeEventFactory } from "../events/RuntimeEventFactory.ts";

const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed", "blocked", "cancelled", "dead_letter"]);

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["queued", "running", "blocked", "cancelled", "dead_letter"],
  queued: ["running", "pending", "cancelled", "dead_letter"],
  running: ["done", "failed", "blocked", "needs_inspection", "cancelled", "dead_letter"],
  blocked: ["pending", "queued", "cancelled", "dead_letter"],
  needs_inspection: ["queued", "running", "done", "failed", "cancelled", "dead_letter"],
  done: [],
  failed: ["queued", "dead_letter"],
  cancelled: [],
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

interface CreateSessionInput {
  id?: string;
  title?: string;
  source?: string;
  metadata?: Metadata;
}

interface AddSessionMessageInput {
  sessionId: string;
  runId?: string | null;
  role: SessionMessageRole;
  content: string;
  delegatedTo?: string[];
  metadata?: Metadata;
}

export class TaskStore {
  dataDir: string;
  taskDir: string;
  db: SqliteDatabase;

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
    this.db = openSqliteDatabase(dbPath);
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
              lease_token TEXT,
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
      {
        version: 4,
        name: "add_task_lease_token",
        up: () => {
          this.ensureColumn("tasks", "lease_token", "TEXT");
        },
      },
      {
        version: 5,
        name: "create_sessions",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              status TEXT NOT NULL,
              source TEXT NOT NULL,
              run_count INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              last_active_at TEXT,
              hidden_at TEXT,
              trashed_at TEXT,
              delete_after TEXT,
              archive_summary TEXT,
              metadata TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_delete_after ON sessions(status, delete_after);
          `);
        },
      },
      {
        version: 6,
        name: "create_session_messages",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_messages (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              run_id TEXT,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              delegated_to TEXT NOT NULL,
              metadata TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, created_at ASC);
            CREATE INDEX IF NOT EXISTS idx_session_messages_run ON session_messages(run_id);
          `);
        },
      },
    ]);

    this.ensureColumn("tasks", "retry_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "max_retries", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("tasks", "lease_owner", "TEXT");
    this.ensureColumn("tasks", "lease_token", "TEXT");
    this.ensureColumn("tasks", "lease_expires_at", "TEXT");
    this.ensureColumn("tasks", "heartbeat_at", "TEXT");
    this.ensureColumn("tasks", "main_ack_at", "TEXT");
  }

  ensureColumn(table: string, column: string, definition: string): void {
    runSqliteWithRetry(() => {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (rows.some((row) => row.name === column)) return;
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      } catch (error) {
        if (isDuplicateColumnError(error) && this.columnExists(table, column)) return;
        throw error;
      }
    });
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
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
      leaseToken: null,
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
          parent_task_id, metadata, retry_count, max_retries, lease_owner, lease_token,
          lease_expires_at, heartbeat_at, main_ack_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        task.leaseToken,
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

  createSession({
    id = randomUUID(),
    title = "New session",
    source = "runtime",
    metadata = {},
  }: CreateSessionInput = {}): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id,
      title: normalizeSessionTitle(title),
      status: "active",
      source,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: null,
      hiddenAt: null,
      trashedAt: null,
      deleteAfter: null,
      archiveSummary: null,
      metadata,
    };
    this.db
      .prepare(`
        INSERT INTO sessions (
          id, title, status, source, run_count, created_at, updated_at, last_active_at,
          hidden_at, trashed_at, delete_after, archive_summary, metadata
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.id,
        session.title,
        session.status,
        session.source,
        session.runCount,
        session.createdAt,
        session.updatedAt,
        session.lastActiveAt,
        session.hiddenAt,
        session.trashedAt,
        session.deleteAfter,
        session.archiveSummary,
        JSON.stringify(session.metadata),
      );
    this.addEvent({
      type: "session.created",
      payload: { sessionId: session.id, title: session.title, source: session.source },
    });
    return session;
  }

  ensureSession({ id, title, source = "runtime", metadata = {} }: CreateSessionInput & { id: string }): Session {
    const existing = this.getSession(id);
    if (existing) {
      if (existing.status === "deleted") {
        throw new Error(`Session has been deleted: ${id}`);
      }
      return existing;
    }
    return this.createSession({ id, title: title || "New session", source, metadata });
  }

  touchSession(sessionId: string, { userInput = "", source = "runtime" }: { userInput?: string; source?: string } = {}): Session {
    const existing = this.ensureSession({
      id: sessionId,
      title: titleFromUserInput(userInput),
      source,
    });
    this.assertActiveSession(existing, "touch");
    const now = new Date().toISOString();
    const nextTitle = shouldReplaceSessionTitle(existing.title)
      ? titleFromUserInput(userInput, existing.title)
      : existing.title;
    this.db
      .prepare(`
        UPDATE sessions
        SET title = ?,
            source = CASE WHEN source = 'runtime' THEN ? ELSE source END,
            run_count = run_count + 1,
            updated_at = ?,
            last_active_at = ?
        WHERE id = ?
      `)
      .run(nextTitle, source, now, now, sessionId);
    const touched = this.getSession(sessionId);
    if (!touched) throw new Error(`Session not found after touch: ${sessionId}`);
    this.addEvent({
      type: "session.updated",
      payload: { sessionId, title: touched.title, source, runCount: touched.runCount },
    });
    return touched;
  }

  getSession(sessionId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as unknown as SessionRow | undefined;
    return row ? parseSession(row) : null;
  }

  listSessions({
    status,
    includeHidden = false,
    includeTrashed = false,
    includeDeleted = false,
    limit = 50,
  }: {
    status?: SessionStatus;
    includeHidden?: boolean;
    includeTrashed?: boolean;
    includeDeleted?: boolean;
    limit?: number;
  } = {}): Session[] {
    const statuses = status
      ? [status]
      : [
        "active",
        ...(includeHidden ? ["hidden"] : []),
        ...(includeTrashed ? ["trashed"] : []),
        ...(includeDeleted ? ["deleted"] : []),
      ];
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT * FROM sessions
        WHERE status IN (${placeholders})
        ORDER BY COALESCE(last_active_at, updated_at, created_at) DESC
        LIMIT ?
      `)
      .all(...statuses, limit) as unknown as SessionRow[];
    return rows.map(parseSession);
  }

  hideSession(sessionId: string, reason = "cleared by user"): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "deleted") throw new Error(`Session has been deleted: ${sessionId}`);
    if (session.status !== "active") {
      throw new Error(`Session must be active before hide: ${sessionId} is ${session.status}`);
    }
    const now = new Date().toISOString();
    const summary = this.buildSessionArchiveSummary(sessionId);
    this.db
      .prepare(`
        UPDATE sessions
        SET status = 'hidden',
            hidden_at = ?,
            updated_at = ?,
            archive_summary = ?,
            metadata = ?
        WHERE id = ? AND status != 'deleted'
      `)
      .run(now, now, summary, JSON.stringify({ ...session.metadata, hiddenReason: reason }), sessionId);
    const hidden = this.getSession(sessionId);
    if (!hidden) throw new Error(`Session not found after hide: ${sessionId}`);
    this.addEvent({
      type: "session.hidden",
      payload: { sessionId, reason },
    });
    return hidden;
  }

  restoreSession(sessionId: string): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "deleted") throw new Error(`Session has been deleted: ${sessionId}`);
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE sessions
        SET status = 'active',
            hidden_at = NULL,
            trashed_at = NULL,
            delete_after = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(now, sessionId);
    const restored = this.getSession(sessionId);
    if (!restored) throw new Error(`Session not found after restore: ${sessionId}`);
    this.addEvent({
      type: "session.restored",
      payload: { sessionId },
    });
    return restored;
  }

  trashSession(sessionId: string, { deleteAfterDays = 30, reason = "archived" }: { deleteAfterDays?: number; reason?: string } = {}): Session {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === "deleted") throw new Error(`Session has been deleted: ${sessionId}`);
    const now = new Date();
    const deleteAfter = new Date(now.getTime() + deleteAfterDays * 24 * 60 * 60 * 1000).toISOString();
    const summary = session.archiveSummary || this.buildSessionArchiveSummary(sessionId);
    this.db
      .prepare(`
        UPDATE sessions
        SET status = 'trashed',
            trashed_at = ?,
            delete_after = ?,
            updated_at = ?,
            archive_summary = ?,
            metadata = ?
        WHERE id = ? AND status != 'deleted'
      `)
      .run(now.toISOString(), deleteAfter, now.toISOString(), summary, JSON.stringify({ ...session.metadata, trashReason: reason }), sessionId);
    const trashed = this.getSession(sessionId);
    if (!trashed) throw new Error(`Session not found after trash: ${sessionId}`);
    this.addEvent({
      type: "session.trashed",
      payload: { sessionId, reason, deleteAfter },
    });
    return trashed;
  }

  archiveHiddenSessions({ deleteAfterDays = 30, limit = 50 }: { deleteAfterDays?: number; limit?: number } = {}): Session[] {
    const hidden = this.listSessions({ status: "hidden", limit });
    return hidden.map((session) => this.trashSession(session.id, {
      deleteAfterDays,
      reason: "memory_skill_archive_complete",
    }));
  }

  pruneTrashedSessions({ olderThanDays = 30 }: { olderThanDays?: number } = {}): number {
    const nowIso = new Date().toISOString();
    const fallbackCutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(`
        SELECT id FROM sessions
        WHERE status = 'trashed'
          AND (
            (delete_after IS NOT NULL AND delete_after <= ?)
            OR (delete_after IS NULL AND trashed_at IS NOT NULL AND trashed_at <= ?)
          )
      `)
      .all(nowIso, fallbackCutoff) as Array<{ id: string }>;
    for (const row of rows) {
      this.db
        .prepare("UPDATE sessions SET status = 'deleted', updated_at = ? WHERE id = ?")
        .run(now, row.id);
      this.addEvent({
        type: "session.deleted",
        payload: { sessionId: row.id },
      });
    }
    return rows.length;
  }

  buildSessionArchiveSummary(sessionId: string): string {
    const runs = this.getRunsForSession(sessionId, { includeHidden: true, limit: 20 });
    if (!runs.length) return "No runs were recorded in this session.";
    const statusCounts = runs.reduce<Record<string, number>>((acc, run) => {
      acc[run.status] = (acc[run.status] || 0) + 1;
      return acc;
    }, {});
    const recentInputs = runs.slice(0, 5).map((run) => `- ${truncateText(run.userInput, 96)}`).join("\n");
    return [
      `Runs: ${runs.length}`,
      `Statuses: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(", ")}`,
      "Recent inputs:",
      recentInputs,
    ].join("\n");
  }

  addSessionMessage({
    sessionId,
    runId = null,
    role,
    content,
    delegatedTo = [],
    metadata = {},
  }: AddSessionMessageInput): SessionMessage {
    const session = this.ensureSession({
      id: sessionId,
      title: role === "user" ? titleFromUserInput(content) : "New session",
      source: typeof metadata.source === "string" ? metadata.source : "runtime",
    });
    this.assertActiveSession(session, "add message");
    const now = new Date().toISOString();
    const message: SessionMessage = {
      id: randomUUID(),
      sessionId,
      runId,
      role,
      content,
      delegatedTo,
      metadata,
      createdAt: now,
    };
    this.db
      .prepare(`
        INSERT INTO session_messages (
          id, session_id, run_id, role, content, delegated_to, metadata, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.sessionId,
        message.runId,
        message.role,
        message.content,
        JSON.stringify(message.delegatedTo),
        JSON.stringify(message.metadata),
        message.createdAt,
      );
    this.addEvent({
      type: "session.message.created",
      payload: {
        sessionId,
        runId: runId || "",
        messageId: message.id,
        role,
      },
    });
    return message;
  }

  listSessionMessages({ sessionId, limit = 100 }: { sessionId: string; limit?: number }): SessionMessage[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM (
          SELECT rowid, * FROM session_messages
          WHERE session_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        )
        ORDER BY created_at ASC, rowid ASC
      `)
      .all(sessionId, limit) as unknown as SessionMessageRow[];
    return rows.map(parseSessionMessage);
  }

  createRun({ sessionId, source, userInput }: CreateRunInput): Run {
    this.touchSession(sessionId, { userInput, source });
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

  private assertActiveSession(session: Session, operation: string): void {
    if (session.status === "active") return;
    if (session.status === "deleted") throw new Error(`Session has been deleted: ${session.id}`);
    throw new Error(`Session is ${session.status}; restore it before ${operation}: ${session.id}`);
  }

  completeRun(runId: string, status: Run["status"] = "done"): number {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?")
      .run(status, now, runId);
    return this.addEvent(RuntimeEventFactory.runCompleted(runId, status));
  }

  updateRunStatus(runId: string, status: Run["status"]): number {
    this.db
      .prepare("UPDATE runs SET status = ?, completed_at = CASE WHEN ? IN ('done', 'failed', 'blocked', 'partially_done', 'waiting_user', 'cancelled') THEN ? ELSE completed_at END WHERE id = ?")
      .run(status, status, new Date().toISOString(), runId);
    return this.addEvent({
      type: "run.status",
      payload: { runId, status },
    });
  }

  getRun(runId: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as unknown as RunRow | undefined;
    return row ? parseRun(row) : null;
  }

  getRunsForSession(sessionId: string, { limit = 50 }: { includeHidden?: boolean; limit?: number } = {}): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(sessionId, limit) as unknown as RunRow[];
    return rows.map(parseRun);
  }

  getActiveRuns({ olderThanMs = 0 }: { olderThanMs?: number } = {}): Run[] {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const rows = this.db
      .prepare(`
        SELECT * FROM runs
        WHERE status IN ('running', 'reviewing', 'recovering')
          AND started_at <= ?
        ORDER BY started_at ASC
      `)
      .all(cutoff) as unknown as RunRow[];
    return rows.map(parseRun);
  }

  recoverStaleRuns({ olderThanMs = 5 * 60 * 1000 }: { olderThanMs?: number } = {}): Run[] {
    const recovered: Run[] = [];
    for (const run of this.getActiveRuns({ olderThanMs })) {
      const tasks = this.getTasksForRun(run.id);
      const status = recoverableRunStatusFromTasks(tasks);
      if (!status) continue;
      this.completeRun(run.id, status);
      const refreshed = this.getRun(run.id);
      if (refreshed) recovered.push(refreshed);
    }
    return recovered;
  }

  cancelRun(runId: string, reason = "cancelled by user"): number {
    for (const task of this.getTasksForRun(runId)) {
      if (!this.isTerminalStatus(task.status)) {
        this.cancelTask(task.id, { reason });
      }
    }
    return this.completeRun(runId, "cancelled");
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

  replaceTaskDependencies(taskId: string, dependencies: Array<{
    dependsOnTaskId: string;
    dependencyType?: TaskDependency["dependencyType"];
  }>, {
    reason = "dependencies replaced",
  }: {
    reason?: string;
  } = {}): void {
    const task = this.getTaskOrThrow(taskId);
    if (task.status !== "pending" && task.status !== "blocked") {
      throw new IllegalTaskTransitionError(`Task dependencies can only be edited before execution; ${taskId} is ${task.status}`);
    }
    this.db.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    for (const dependency of dependencies) {
      this.addTaskDependency(taskId, dependency.dependsOnTaskId, dependency.dependencyType || "success");
    }
    this.addEvent({
      type: "task.dependencies.updated",
      taskId,
      payload: {
        reason,
        dependencies: dependencies.map((dependency) => ({
          dependsOnTaskId: dependency.dependsOnTaskId,
          dependencyType: dependency.dependencyType || "success",
        })),
      },
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

  getTaskGraph(graphId: string): TaskGraph | null {
    const row = this.db
      .prepare("SELECT * FROM task_graphs WHERE id = ?")
      .get(graphId) as unknown as TaskGraphRow | undefined;
    return row ? parseTaskGraph(row) : null;
  }

  getOpenTaskGraphs(): TaskGraph[] {
    const rows = this.db
      .prepare("SELECT * FROM task_graphs WHERE status IN ('pending', 'running') ORDER BY created_at ASC")
      .all() as unknown as TaskGraphRow[];
    return rows.map(parseTaskGraph);
  }

  getRecentTaskGraphs({ limit = 20 }: { limit?: number } = {}): TaskGraph[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(`
        SELECT * FROM task_graphs
        ORDER BY COALESCE(completed_at, created_at) DESC, created_at DESC
        LIMIT ?
      `)
      .all(safeLimit) as unknown as TaskGraphRow[];
    return rows.map(parseTaskGraph);
  }

  refreshTaskGraphStatuses(): TaskGraph[] {
    const updated: TaskGraph[] = [];
    for (const graph of this.getOpenTaskGraphs()) {
      const tasks = this.getTasksForGraph(graph.id);
      const nextStatus = graphStatusFromTasks(tasks);
      if (nextStatus === graph.status) continue;
      if (nextStatus === "done" || nextStatus === "failed") {
        this.completeTaskGraph(graph.id, nextStatus);
      } else {
        this.db
          .prepare("UPDATE task_graphs SET status = ?, completed_at = NULL WHERE id = ?")
          .run(nextStatus, graph.id);
        this.addEvent({
          type: "task_graph.status",
          payload: { graphId: graph.id, status: nextStatus },
        });
      }
      const refreshed = this.getTaskGraph(graph.id);
      if (refreshed) updated.push(refreshed);
    }
    return updated;
  }

  getDependencies(taskId: string): TaskDependency[] {
    const rows = this.db
      .prepare("SELECT * FROM task_dependencies WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as unknown as TaskDependencyRow[];
    return rows.map(parseDependency);
  }

  getDependents(taskId: string): Task[] {
    const rows = this.db
      .prepare(`
        SELECT t.* FROM tasks t
        JOIN task_dependencies d ON d.task_id = t.id
        WHERE d.depends_on_task_id = ?
      `)
      .all(taskId) as unknown as TaskRow[];
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
    const rows = this.db
      .prepare(
        "SELECT * FROM role_queues WHERE role = ? AND status = 'queued' ORDER BY priority DESC, id ASC LIMIT 10",
      )
      .all(role) as Array<{ task_id: string }>;

    for (const row of rows) {
      const task = this.getTask(row.task_id);
      if (!task) {
        this.completeQueueItem(row.task_id, "failed");
        continue;
      }
      if (task.status !== "queued") {
        this.completeQueueItem(row.task_id, queueStatusForTask(task));
        continue;
      }

      try {
        this.claimTask(row.task_id, agentId, { leaseMs });
      } catch (error) {
        if (error instanceof IllegalTaskTransitionError || error instanceof TaskTransitionConflictError) {
          const latest = this.getTask(row.task_id);
          if (latest) this.completeQueueItem(row.task_id, queueStatusForTask(latest));
          continue;
        }
        throw error;
      }

      this.db
        .prepare("UPDATE role_queues SET status = 'running', updated_at = ? WHERE task_id = ?")
        .run(new Date().toISOString(), row.task_id);
      return this.getTask(row.task_id);
    }

    return null;
  }

  completeQueueItem(taskId: string, status: "done" | "failed" | "cancelled" | "dead_letter" = "done"): void {
    this.db
      .prepare("UPDATE role_queues SET status = ?, updated_at = ? WHERE task_id = ?")
      .run(status, new Date().toISOString(), taskId);
  }

  claimTask(taskId: string, agentId: string, {
    leaseMs = 30000,
    leaseToken = randomUUID(),
  }: {
    leaseMs?: number;
    leaseToken?: string;
  } = {}): number {
    const task = this.getTaskOrThrow(taskId);
    if (task.status === "running") {
      this.assertLeaseMatches(task, { agentId, leaseToken });
    }
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    return this.transitionTask(taskId, "running", {
      agentId,
      reason: "claimed by worker",
      expectedLease: task.status === "running" ? { owner: agentId, token: leaseToken } : undefined,
      patch: {
        assignedAgentId: agentId,
        leaseOwner: agentId,
        leaseToken,
        leaseExpiresAt,
        heartbeatAt: now.toISOString(),
        metadata: task.metadata,
      },
    });
  }

  heartbeatTask(taskId: string, agentId: string, {
    leaseMs = 30000,
    leaseToken = null,
  }: {
    leaseMs?: number;
    leaseToken?: string | null;
  } = {}): number {
    const task = this.getTaskOrThrow(taskId);
    if (task.status !== "running") {
      return this.addEvent({
        type: "task.heartbeat_ignored",
        taskId,
        agentId,
        payload: { status: task.status },
      });
    }
    if (!this.leaseMatches(task, { agentId, leaseToken })) {
      return this.addEvent({
        type: "task.heartbeat_ignored",
        taskId,
        agentId,
        payload: { status: task.status, reason: "lease token mismatch" },
      });
    }

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        "UPDATE tasks SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND lease_owner IS ? AND lease_token IS ?",
      )
      .run(now.toISOString(), leaseExpiresAt, now.toISOString(), taskId, agentId, leaseToken);
    if (result.changes === 0) {
      return this.addEvent({
        type: "task.heartbeat_ignored",
        taskId,
        agentId,
        payload: { status: "running", reason: "lease changed before heartbeat update" },
      });
    }

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
      expectedLease?: { owner: string | null; token: string | null };
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
            lease_token = ?,
            lease_expires_at = ?,
            heartbeat_at = ?,
            main_ack_at = ?,
            updated_at = ?
        WHERE id = ? AND status = ?
          AND (? = 0 OR lease_owner IS ?)
          AND (? = 0 OR lease_token IS ?)
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
        terminal ? null : (patch.leaseToken ?? task.leaseToken),
        terminal ? null : (patch.leaseExpiresAt ?? task.leaseExpiresAt),
        patch.heartbeatAt ?? task.heartbeatAt,
        patch.mainAckAt ?? task.mainAckAt,
        now,
        taskId,
        task.status,
        options.expectedLease ? 1 : 0,
        options.expectedLease?.owner ?? null,
        options.expectedLease ? 1 : 0,
        options.expectedLease?.token ?? null,
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

  finishTask(taskId: string, {
    result,
    agentId,
    leaseToken = null,
    bypassLease = false,
  }: {
    result: string;
    agentId?: string | null;
    leaseToken?: string | null;
    bypassLease?: boolean;
  }): number {
    const task = this.getTaskOrThrow(taskId);
    this.assertTerminalMutationAllowed(task, { agentId, leaseToken, bypassLease });
    const eventId = this.transitionTask(taskId, "done", {
      agentId,
      result,
      error: null,
      reason: "worker completed",
      expectedLease: expectedLeaseFor(task, { agentId, leaseToken, bypassLease }),
    });
    this.completeQueueItem(taskId, "done");
    this.releaseReadyDependents(taskId);
    return eventId;
  }

  failTask(
    taskId: string,
    {
      error,
      result,
      agentId,
      leaseToken = null,
      bypassLease = false,
    }: {
      error: string;
      result?: string | null;
      agentId?: string | null;
      leaseToken?: string | null;
      bypassLease?: boolean;
    },
  ): number {
    const task = this.getTaskOrThrow(taskId);
    this.assertTerminalMutationAllowed(task, { agentId, leaseToken, bypassLease });
    const retryCount = task.retryCount + 1;
    const nextStatus: TaskStatus = retryCount > task.maxRetries ? "dead_letter" : "failed";
    const eventId = this.transitionTask(taskId, nextStatus, {
      agentId,
      result: result ?? task.result,
      error,
      reason: nextStatus === "dead_letter" ? "max retries exceeded" : "worker failed",
      expectedLease: expectedLeaseFor(task, { agentId, leaseToken, bypassLease }),
      patch: {
        retryCount,
        metadata: {
          ...task.metadata,
          lastError: error,
          deadLetterReason: nextStatus === "dead_letter" ? "max retries exceeded" : null,
        },
      },
    });
    this.completeQueueItem(taskId, nextStatus);
    this.releaseReadyDependents(taskId);
    return eventId;
  }

  cancelTask(taskId: string, {
    reason = "cancelled",
    agentId = null,
    leaseToken = null,
    bypassLease = false,
  }: {
    reason?: string;
    agentId?: string | null;
    leaseToken?: string | null;
    bypassLease?: boolean;
  } = {}): number {
    const task = this.getTaskOrThrow(taskId);
    if (this.isTerminalStatus(task.status)) {
      return this.addEvent({
        type: "task.cancel_ignored",
        taskId,
        agentId,
        payload: { status: task.status, reason },
      });
    }
    this.assertTerminalMutationAllowed(task, { agentId, leaseToken, bypassLease });
    const eventId = this.transitionTask(taskId, "cancelled", {
      agentId,
      error: reason,
      reason,
      expectedLease: expectedLeaseFor(task, { agentId, leaseToken, bypassLease }),
      metadata: {
        ...task.metadata,
        cancelledAt: new Date().toISOString(),
        cancelReason: reason,
      },
    });
    this.completeQueueItem(taskId, "cancelled");
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
    return this.decidePendingMemoryCandidate(candidateId, status).candidate;
  }

  decidePendingMemoryCandidate(candidateId: string, status: "approved" | "rejected"): {
    candidate: MemoryCandidate;
    changed: boolean;
  } {
    const result = this.db
      .prepare("UPDATE memory_candidates SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, new Date().toISOString(), candidateId);
    const candidate = this.getMemoryCandidate(candidateId);
    if (!candidate) throw new Error(`Memory candidate not found: ${candidateId}`);
    if (result.changes === 0) {
      return { candidate, changed: false };
    }
    this.addEvent({
      type: status === "approved" ? "memory.candidate.approved" : "memory.candidate.rejected",
      taskId: candidate.taskId,
      payload: RuntimeEventFactory.candidateLifecycle(candidateId, candidate.runId, status),
    });
    return { candidate, changed: true };
  }

  getPendingMemoryCandidates({ runId, limit = 20 }: { runId?: string; limit?: number } = {}): MemoryCandidate[] {
    const rows = runId
      ? this.db
        .prepare("SELECT * FROM memory_candidates WHERE status = 'pending' AND run_id = ? ORDER BY created_at ASC LIMIT ?")
        .all(runId, limit) as unknown as MemoryCandidateRow[]
      : this.db
        .prepare("SELECT * FROM memory_candidates WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?")
        .all(limit) as unknown as MemoryCandidateRow[];
    return rows.map(parseMemoryCandidate);
  }

  getMemoryCandidate(candidateId: string): MemoryCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM memory_candidates WHERE id = ?")
      .get(candidateId) as unknown as MemoryCandidateRow | undefined;
    return row ? parseMemoryCandidate(row) : null;
  }

  getMemoryCandidatesForRun(runId: string): MemoryCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_candidates WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as unknown as MemoryCandidateRow[];
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

  heartbeatAgent({
    id,
    role,
    currentTaskId = null,
    leaseToken = null,
    leaseMs = 30000,
  }: {
    id: string;
    role: string;
    currentTaskId?: string | null;
    leaseToken?: string | null;
    leaseMs?: number;
  }): void {
    this.upsertAgent({
      id,
      role,
      status: "running",
      currentTaskId,
    });
    if (currentTaskId) {
      this.heartbeatTask(currentTaskId, id, { leaseToken, leaseMs });
    }
  }

  getTask(taskId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as unknown as TaskRow | undefined;
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
      .all(agentId) as unknown as TaskRow[];
    return rows.map(parseTask);
  }

  getExpiredLeaseTasks(): Task[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?")
      .all(now) as unknown as TaskRow[];
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
      .all() as unknown as TaskRow[];
    return rows.map(parseTask);
  }

  getUnacknowledgedTerminalTasks(): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE status IN ('done', 'failed', 'blocked', 'cancelled', 'dead_letter') AND main_ack_at IS NULL",
      )
      .all() as unknown as TaskRow[];
    return rows.map(parseTask);
  }

  getQueuedRoles(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT role FROM role_queues WHERE status = 'queued' ORDER BY role ASC")
      .all() as Array<{ role: string }>;
    return rows.map((row) => row.role);
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
        WHERE status IN ('done', 'failed', 'cancelled', 'dead_letter')
          AND updated_at >= ?
          AND updated_at < ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(start, end, limit) as unknown as TaskRow[];
    return rows.map(parseTask);
  }

  getLatestEvents({ limit = 20, afterId = 0 }: { limit?: number; afterId?: number } = {}): TaskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit) as unknown as EventRow[];
    return rows.map(parseEvent);
  }

  getTimeline({ runId }: { runId: string }): Timeline {
    const run = this.getRun(runId);
    const tasks = this.getTasksForRun(runId);
    const taskIds = new Set(tasks.map((task) => task.id));
    const rows = this.db
      .prepare("SELECT * FROM events ORDER BY id ASC")
      .all() as unknown as EventRow[];
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
      .all(taskId) as unknown as EventRow[];
    return {
      run,
      tasks: task ? [task] : [],
      events: rows.map(parseEvent),
    };
  }

  updateTaskMetadata(taskId: string, metadata: Metadata, {
    reason = "metadata updated",
  }: {
    reason?: string;
  } = {}): number {
    const task = this.getTaskOrThrow(taskId);
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(metadata), now, taskId);
    if (result.changes === 0) {
      throw new TaskTransitionConflictError(`Task metadata update conflict: ${taskId}`);
    }
    return this.addEvent({
      type: "task.metadata.updated",
      taskId,
      agentId: task.assignedAgentId,
      payload: { reason },
    });
  }

  updateUnstartedTask(taskId: string, patch: {
    role?: string;
    title?: string;
    input?: string;
    maxRetries?: number;
    metadata?: Metadata;
    reopenBlocked?: boolean;
  }, {
    reason = "unstarted task updated",
  }: {
    reason?: string;
  } = {}): Task {
    const task = this.getTaskOrThrow(taskId);
    if (task.status !== "pending" && task.status !== "blocked") {
      throw new IllegalTaskTransitionError(`Task can only be edited before execution; ${taskId} is ${task.status}`);
    }
    const nextStatus = task.status === "blocked" && patch.reopenBlocked !== false ? "pending" : task.status;
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`
        UPDATE tasks
        SET role = ?,
            status = ?,
            title = ?,
            input = ?,
            metadata = ?,
            max_retries = ?,
            error = ?,
            updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        patch.role ?? task.role,
        nextStatus,
        patch.title ?? task.title,
        patch.input ?? task.input,
        JSON.stringify(patch.metadata ?? task.metadata),
        patch.maxRetries ?? task.maxRetries,
        nextStatus === "pending" ? null : task.error,
        now,
        taskId,
        task.status,
      );
    if (result.changes === 0) {
      throw new TaskTransitionConflictError(`Task update conflict: ${taskId} expected ${task.status}`);
    }
    const updated = this.getTaskOrThrow(taskId);
    this.addEvent({
      type: "task.updated",
      taskId,
      agentId: updated.assignedAgentId,
      payload: {
        reason,
        reopened: task.status === "blocked" && updated.status === "pending",
      },
    });
    return updated;
  }

  getTasksForRun(runId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE json_extract(metadata, '$.runId') = ? ORDER BY created_at ASC")
      .all(runId) as unknown as TaskRow[];
    return rows.map(parseTask);
  }

  getTasksForGraph(graphId: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE json_extract(metadata, '$.graphId') = ? ORDER BY created_at ASC")
      .all(graphId) as unknown as TaskRow[];
    return rows.map(parseTask);
  }

  diagnostics({ repair = false, emit = true }: { repair?: boolean; emit?: boolean } = {}): RuntimeAnomaly[] {
    const anomalies: RuntimeAnomaly[] = [];
    const add = (input: Omit<RuntimeAnomaly, "id" | "repaired"> & { repaired?: boolean }) => {
      const anomaly: RuntimeAnomaly = {
        id: randomUUID(),
        repaired: Boolean(input.repaired),
        ...input,
      };
      anomalies.push(anomaly);
      if (emit) {
        this.addEvent({
          type: "runtime.anomaly",
          taskId: anomaly.taskId || null,
          payload: {
            anomalyId: anomaly.id,
            severity: anomaly.severity,
            code: anomaly.code,
            message: anomaly.message,
            runId: anomaly.runId || "",
            graphId: anomaly.graphId || "",
            repaired: anomaly.repaired,
          },
        });
      }
    };

    const queuedWithoutQueue = this.db
      .prepare(`
        SELECT t.* FROM tasks t
        LEFT JOIN role_queues q ON q.task_id = t.id AND q.status = 'queued'
        WHERE t.status = 'queued' AND q.task_id IS NULL
      `)
      .all() as unknown as TaskRow[];
    for (const row of queuedWithoutQueue) {
      const task = parseTask(row);
      if (repair) this.enqueueTask(task.id);
      add({
        severity: "warning",
        code: "queued_task_missing_queue_item",
        message: `Queued task ${task.id} has no queued role_queues row.`,
        taskId: task.id,
        repaired: repair,
      });
    }

    const runningWithoutLease = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_owner IS NULL)")
      .all() as unknown as TaskRow[];
    for (const row of runningWithoutLease) {
      const task = parseTask(row);
      add({
        severity: "critical",
        code: "running_task_missing_lease",
        message: `Running task ${task.id} is missing lease metadata.`,
        taskId: task.id,
      });
    }

    const terminalRunningQueue = this.db
      .prepare(`
        SELECT t.* FROM tasks t
        JOIN role_queues q ON q.task_id = t.id
        WHERE t.status IN ('done', 'failed', 'blocked', 'cancelled', 'dead_letter')
          AND q.status = 'running'
      `)
      .all() as unknown as TaskRow[];
    for (const row of terminalRunningQueue) {
      const task = parseTask(row);
      if (repair) this.completeQueueItem(task.id, queueStatusForTask(task));
      add({
        severity: "warning",
        code: "terminal_task_running_queue_item",
        message: `Terminal task ${task.id} still has a running queue item.`,
        taskId: task.id,
        repaired: repair,
      });
    }

    for (const graph of this.getOpenTaskGraphs()) {
      const expected = graphStatusFromTasks(this.getTasksForGraph(graph.id));
      if (expected !== graph.status) {
        if (repair) this.refreshTaskGraphStatuses();
        add({
          severity: "info",
          code: "task_graph_status_drift",
          message: `Task graph ${graph.id} status is ${graph.status}, expected ${expected}.`,
          graphId: graph.id,
          repaired: repair,
        });
      }
    }

    for (const run of this.getActiveRuns({ olderThanMs: 0 })) {
      const expected = recoverableRunStatusFromTasks(this.getTasksForRun(run.id));
      if (expected) {
        if (repair) this.completeRun(run.id, expected);
        add({
          severity: "warning",
          code: "recoverable_active_run",
          message: `Run ${run.id} is active but all tasks imply ${expected}.`,
          runId: run.id,
          repaired: repair,
        });
      }
    }

    return anomalies;
  }

  maintenance({
    maxEvents = 10000,
    pruneDecidedMemoryCandidatesOlderThanDays = 30,
  }: {
    maxEvents?: number;
    pruneDecidedMemoryCandidatesOlderThanDays?: number;
  } = {}): { checkpoint: unknown; analysis: unknown; vacuum: unknown; prunedEvents: number; prunedMemoryCandidates: number } {
    const prunedEvents = this.pruneEvents({ maxEvents });
    const prunedMemoryCandidates = this.pruneDecidedMemoryCandidates({
      olderThanDays: pruneDecidedMemoryCandidatesOlderThanDays,
    });
    const checkpoint = safeDbOperation(() => this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all());
    const analysis = safeDbOperation(() => {
      this.db.exec("PRAGMA optimize");
      return this.db.prepare("PRAGMA analysis_limit = 400").get();
    });
    const vacuum = safeDbOperation(() => {
      this.db.exec("VACUUM");
      return { ok: true };
    });
    this.addEvent({
      type: "runtime.maintenance",
      payload: { checkpointed: true, optimized: true, vacuumed: true, prunedEvents, prunedMemoryCandidates },
    });
    return { checkpoint, analysis, vacuum, prunedEvents, prunedMemoryCandidates };
  }

  pruneEvents({ maxEvents = 10000 }: { maxEvents?: number } = {}): number {
    const row = this.db.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?").get(maxEvents) as { id: number } | undefined;
    if (!row) return 0;
    const result = this.db.prepare("DELETE FROM events WHERE id < ?").run(row.id);
    return Number(result.changes);
  }

  pruneDecidedMemoryCandidates({ olderThanDays = 30 }: { olderThanDays?: number } = {}): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare("DELETE FROM memory_candidates WHERE status IN ('approved', 'rejected') AND decided_at IS NOT NULL AND decided_at < ?")
      .run(cutoff);
    return Number(result.changes);
  }

  health(): {
    pendingTasks: number;
    runningTasks: number;
    activeRuns: number;
    expiredLeases: number;
    unacknowledgedTerminalTasks: number;
    pendingMemoryCandidates: number;
    queuedRoles: string[];
    openTaskGraphs: number;
    diagnostics: number;
    activeSessions: number;
    hiddenSessions: number;
    trashedSessions: number;
  } {
    return {
      pendingTasks: count(this.db, "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('pending', 'queued')"),
      runningTasks: count(this.db, "SELECT COUNT(*) AS count FROM tasks WHERE status = 'running'"),
      activeRuns: count(this.db, "SELECT COUNT(*) AS count FROM runs WHERE status IN ('running', 'reviewing', 'recovering')"),
      expiredLeases: this.getExpiredLeaseTasks().length,
      unacknowledgedTerminalTasks: this.getUnacknowledgedTerminalTasks().length,
      pendingMemoryCandidates: count(this.db, "SELECT COUNT(*) AS count FROM memory_candidates WHERE status = 'pending'"),
      queuedRoles: this.getQueuedRoles(),
      openTaskGraphs: count(this.db, "SELECT COUNT(*) AS count FROM task_graphs WHERE status IN ('pending', 'running')"),
      diagnostics: this.diagnostics({ repair: false, emit: false }).length,
      activeSessions: count(this.db, "SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'"),
      hiddenSessions: count(this.db, "SELECT COUNT(*) AS count FROM sessions WHERE status = 'hidden'"),
      trashedSessions: count(this.db, "SELECT COUNT(*) AS count FROM sessions WHERE status = 'trashed'"),
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
      `Lease Token: ${task.leaseToken || "(none)"}`,
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

  private assertTerminalMutationAllowed(
    task: Task,
    {
      agentId = null,
      leaseToken = null,
      bypassLease = false,
    }: {
      agentId?: string | null;
      leaseToken?: string | null;
      bypassLease?: boolean;
    },
  ): void {
    if (bypassLease || task.status !== "running" || !agentId) return;
    this.assertLeaseMatches(task, { agentId, leaseToken });
  }

  private assertLeaseMatches(task: Task, {
    agentId,
    leaseToken,
  }: {
    agentId: string;
    leaseToken?: string | null;
  }): void {
    if (!this.leaseMatches(task, { agentId, leaseToken })) {
      throw new TaskTransitionConflictError(`Task lease token mismatch: ${task.id}`);
    }
  }

  private leaseMatches(task: Task, {
    agentId,
    leaseToken,
  }: {
    agentId: string;
    leaseToken?: string | null;
  }): boolean {
    if (task.leaseOwner && task.leaseOwner !== agentId) return false;
    if (task.leaseToken && task.leaseToken !== leaseToken) return false;
    return true;
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
  lease_token: string | null;
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

interface SessionRow {
  id: string;
  title: string;
  status: SessionStatus;
  source: string;
  run_count: number;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
  hidden_at: string | null;
  trashed_at: string | null;
  delete_after: string | null;
  archive_summary: string | null;
  metadata: string;
}

interface SessionMessageRow {
  id: string;
  session_id: string;
  run_id: string | null;
  role: SessionMessageRole;
  content: string;
  delegated_to: string;
  metadata: string;
  created_at: string;
}

interface TaskGraphRow {
  id: string;
  run_id: string | null;
  status: TaskGraph["status"];
  created_at: string;
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
    leaseToken: row.lease_token,
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

function parseSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    source: row.source,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
    hiddenAt: row.hidden_at,
    trashedAt: row.trashed_at,
    deleteAfter: row.delete_after,
    archiveSummary: row.archive_summary,
    metadata: JSON.parse(row.metadata || "{}") as Metadata,
  };
}

function parseSessionMessage(row: SessionMessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    content: row.content,
    delegatedTo: JSON.parse(row.delegated_to || "[]") as unknown as string[],
    metadata: JSON.parse(row.metadata || "{}") as Metadata,
    createdAt: row.created_at,
  };
}

function parseTaskGraph(row: TaskGraphRow): TaskGraph {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    createdAt: row.created_at,
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

function queueStatusForTask(task: Task): "done" | "failed" | "cancelled" | "dead_letter" {
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "dead_letter") return "dead_letter";
  return "failed";
}

function expectedLeaseFor(
  task: Task,
  {
    agentId = null,
    leaseToken = null,
    bypassLease = false,
  }: {
    agentId?: string | null;
    leaseToken?: string | null;
    bypassLease?: boolean;
  },
): { owner: string | null; token: string | null } | undefined {
  if (bypassLease || task.status !== "running" || !agentId) return undefined;
  return { owner: agentId, token: leaseToken };
}

function graphStatusFromTasks(tasks: Task[]): TaskGraph["status"] {
  const activeTasks = tasks.filter((task) => !isReplanSupersededTerminal(task));
  if (!activeTasks.length) return tasks.length ? "done" : "pending";
  if (activeTasks.some((task) => task.status === "failed" || task.status === "dead_letter" || task.status === "blocked" || task.status === "cancelled")) {
    return "failed";
  }
  if (activeTasks.every((task) => task.status === "done")) return "done";
  if (activeTasks.some((task) => task.status === "queued" || task.status === "running" || task.status === "needs_inspection")) {
    return "running";
  }
  return "pending";
}

function recoverableRunStatusFromTasks(tasks: Task[]): Run["status"] | null {
  const activeTasks = tasks.filter((task) => !isReplanSupersededTerminal(task));
  if (!activeTasks.length) return tasks.length ? "done" : "failed";
  if (activeTasks.some((task) => task.status === "pending" || task.status === "queued" || task.status === "running" || task.status === "needs_inspection")) {
    return null;
  }
  if (activeTasks.every((task) => task.status === "done")) return "done";
  if (activeTasks.some((task) => task.status === "cancelled")) return "cancelled";
  if (activeTasks.some((task) => task.status === "blocked")) return "blocked";
  if (activeTasks.some((task) => task.status === "done")) return "partially_done";
  return "failed";
}

function isReplanSupersededTerminal(task: Task): boolean {
  return Boolean(task.metadata.replanSupersededAt)
    && (task.status === "failed" || task.status === "dead_letter" || task.status === "blocked" || task.status === "cancelled");
}

function normalizeSessionTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  return truncateText(normalized || "New session", 64);
}

function shouldReplaceSessionTitle(title: string): boolean {
  return title === "New session" || /^Session \d{4}-\d{2}-\d{2}/.test(title);
}

function titleFromUserInput(input: string, fallback = "New session"): string {
  const firstLine = input.split(/\r?\n/).find((line) => line.trim()) || "";
  return normalizeSessionTitle(firstLine || fallback);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function count(db: SqliteDatabase, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  return row.count;
}

function safeDbOperation<T>(operation: () => T): T | { ok: false; error: string } {
  try {
    return operation();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message);
}
