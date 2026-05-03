import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { TaskStore } from "../tasks/TaskStore.ts";

export type CronJobStatus = "active" | "paused";

export type CronJobAction =
  | {
    type: "chat";
    message: string;
    sessionId: string;
    source: string;
    permissionMode?: unknown;
  }
  | {
    type: "command";
    command: string;
    args: string[];
    input: Record<string, unknown>;
    format: "json" | "text";
  };

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  status: CronJobStatus;
  action: CronJobAction;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CronJobInput {
  name: string;
  schedule: string;
  message?: string;
  command?: string;
  action?: CronJobAction;
  args?: string[];
  input?: Record<string, unknown>;
  format?: "json" | "text";
  sessionId?: string;
  source?: string;
  permissionMode?: unknown;
  status?: CronJobStatus;
}

export interface CronRunResult {
  job: CronJob;
  ok: boolean;
  manual: boolean;
  startedAt: string;
  finishedAt: string;
  result?: unknown;
  error?: string;
}

interface CronFile {
  version: 1;
  jobs: CronJob[];
}

export class CronScheduler {
  private readonly filePath: string;
  private readonly taskStore: TaskStore;
  private readonly execute: (job: CronJob) => Promise<unknown>;
  private jobs = new Map<string, CronJob>();
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  static async create({
    dataDir,
    taskStore,
    execute,
  }: {
    dataDir: string;
    taskStore: TaskStore;
    execute: (job: CronJob) => Promise<unknown>;
  }): Promise<CronScheduler> {
    const scheduler = new CronScheduler({
      filePath: path.join(dataDir, "cron.json"),
      taskStore,
      execute,
    });
    await scheduler.load();
    return scheduler;
  }

  constructor({
    filePath,
    taskStore,
    execute,
  }: {
    filePath: string;
    taskStore: TaskStore;
    execute: (job: CronJob) => Promise<unknown>;
  }) {
    this.filePath = filePath;
    this.taskStore = taskStore;
    this.execute = execute;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleTimer();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  list({ includePaused = true }: { includePaused?: boolean } = {}): CronJob[] {
    return [...this.jobs.values()]
      .filter((job) => includePaused || job.status === "active")
      .sort((a, b) => (a.nextRunAt || "").localeCompare(b.nextRunAt || "") || a.name.localeCompare(b.name))
      .map(cloneJob);
  }

  get(id: string): CronJob | null {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : null;
  }

  async createJob(input: CronJobInput): Promise<CronJob> {
    const now = new Date().toISOString();
    const action = normalizeAction(input);
    const schedule = normalizeSchedule(input.schedule);
    assertValidSchedule(schedule);
    const status = input.status === "paused" ? "paused" : "active";
    const job: CronJob = {
      id: crypto.randomUUID(),
      name: requiredString(input.name, "name"),
      schedule,
      status,
      action,
      nextRunAt: status === "active" ? nextCronRun(schedule, new Date()).toISOString() : null,
      lastRunAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: null,
      runCount: 0,
      errorCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    await this.save();
    this.addEvent("cron.created", job);
    this.scheduleTimer();
    return cloneJob(job);
  }

  async updateJob(id: string, input: Partial<CronJobInput>): Promise<CronJob> {
    const job = this.getMutable(id);
    if (input.name !== undefined) job.name = requiredString(input.name, "name");
    if (input.schedule !== undefined) {
      job.schedule = normalizeSchedule(input.schedule);
      assertValidSchedule(job.schedule);
    }
    if (input.action || input.message !== undefined || input.command !== undefined) {
      job.action = normalizeAction({
        name: job.name,
        schedule: job.schedule,
        ...input,
      } as CronJobInput);
    }
    if (input.status === "active" || input.status === "paused") job.status = input.status;
    job.nextRunAt = job.status === "active" ? nextCronRun(job.schedule, new Date()).toISOString() : null;
    job.updatedAt = new Date().toISOString();
    await this.save();
    this.addEvent("cron.updated", job);
    this.scheduleTimer();
    return cloneJob(job);
  }

  async pauseJob(id: string): Promise<CronJob> {
    const job = this.getMutable(id);
    job.status = "paused";
    job.nextRunAt = null;
    job.updatedAt = new Date().toISOString();
    await this.save();
    this.addEvent("cron.paused", job);
    this.scheduleTimer();
    return cloneJob(job);
  }

  async resumeJob(id: string): Promise<CronJob> {
    const job = this.getMutable(id);
    job.status = "active";
    job.nextRunAt = nextCronRun(job.schedule, new Date()).toISOString();
    job.updatedAt = new Date().toISOString();
    await this.save();
    this.addEvent("cron.resumed", job);
    this.scheduleTimer();
    return cloneJob(job);
  }

  async deleteJob(id: string): Promise<CronJob> {
    const job = this.getMutable(id);
    this.jobs.delete(id);
    await this.save();
    this.addEvent("cron.deleted", job);
    this.scheduleTimer();
    return cloneJob(job);
  }

  async runJob(id: string, { manual = true }: { manual?: boolean } = {}): Promise<CronRunResult> {
    const job = this.getMutable(id);
    return this.executeJob(job, { manual });
  }

  async runDue(now = new Date()): Promise<CronRunResult[]> {
    const due = [...this.jobs.values()]
      .filter((job) => job.status === "active" && job.nextRunAt && new Date(job.nextRunAt).getTime() <= now.getTime())
      .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
    const results: CronRunResult[] = [];
    for (const job of due) {
      results.push(await this.executeJob(job, { manual: false }));
    }
    return results;
  }

  private async executeJob(job: CronJob, { manual }: { manual: boolean }): Promise<CronRunResult> {
    if (this.running.has(job.id)) {
      return {
        job: cloneJob(job),
        ok: false,
        manual,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: "cron job is already running",
      };
    }
    this.running.add(job.id);
    const startedAt = new Date().toISOString();
    job.lastRunAt = startedAt;
    job.updatedAt = startedAt;
    this.addEvent("cron.started", job, { manual });
    try {
      const result = await this.execute(cloneJob(job));
      const finishedAt = new Date().toISOString();
      job.runCount += 1;
      job.lastSuccessAt = finishedAt;
      job.lastError = null;
      job.updatedAt = finishedAt;
      job.nextRunAt = job.status === "active" ? nextCronRun(job.schedule, new Date()).toISOString() : null;
      await this.save();
      this.addEvent("cron.completed", job, { manual });
      return { job: cloneJob(job), ok: true, manual, startedAt, finishedAt, result };
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      job.errorCount += 1;
      job.lastErrorAt = finishedAt;
      job.lastError = message;
      job.updatedAt = finishedAt;
      job.nextRunAt = job.status === "active" ? nextCronRun(job.schedule, new Date()).toISOString() : null;
      await this.save();
      this.addEvent("cron.failed", job, { manual, error: message });
      return { job: cloneJob(job), ok: false, manual, startedAt, finishedAt, error: message };
    } finally {
      this.running.delete(job.id);
      this.scheduleTimer();
    }
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<CronFile>;
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      for (const job of jobs) {
        const normalized = normalizeStoredJob(job);
        if (normalized) this.jobs.set(normalized.id, normalized);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const file: CronFile = { version: 1, jobs: this.list() };
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(tmp, this.filePath);
  }

  private getMutable(id: string): CronJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown cron job: ${id}`);
    return job;
  }

  private addEvent(type: "cron.created" | "cron.updated" | "cron.deleted" | "cron.paused" | "cron.resumed" | "cron.started" | "cron.completed" | "cron.failed", job: CronJob, extra: Record<string, unknown> = {}): void {
    this.taskStore.addEvent({
      type,
      payload: {
        cronJobId: job.id,
        name: job.name,
        schedule: job.schedule,
        status: job.status,
        actionType: job.action.type,
        nextRunAt: job.nextRunAt,
        ...extra,
      },
    });
  }

  private scheduleTimer(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    const next = this.list({ includePaused: false })
      .map((job) => job.nextRunAt ? new Date(job.nextRunAt).getTime() : 0)
      .filter((time) => time > 0)
      .sort((a, b) => a - b)[0];
    if (!next) {
      this.timer = null;
      return;
    }
    const delay = Math.max(1000, Math.min(next - Date.now(), 60_000));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runDue().catch((error) => {
        this.taskStore.addEvent({
          type: "runtime.anomaly",
          payload: {
            severity: "warning",
            code: "cron_scheduler_error",
            message: error instanceof Error ? error.message : String(error),
            repaired: false,
          },
        });
      }).finally(() => this.scheduleTimer());
    }, delay);
    this.timer.unref?.();
  }
}

export function nextCronRun(expression: string, after: Date): Date {
  const parsed = parseCronExpression(expression);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const maxMinutes = 366 * 24 * 60 * 2;
  for (let i = 0; i < maxMinutes; i += 1) {
    if (matchesCron(parsed, candidate)) return new Date(candidate.getTime());
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`Cron expression has no run within two years: ${expression}`);
}

function parseCronExpression(expression: string): {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
} {
  const normalized = normalizeSchedule(expression);
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron schedule must have 5 fields: minute hour day-of-month month day-of-week");
  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 7, (value) => value === 7 ? 0 : value),
  };
}

function matchesCron(parsed: ReturnType<typeof parseCronExpression>, date: Date): boolean {
  return parsed.minutes.has(date.getMinutes())
    && parsed.hours.has(date.getHours())
    && parsed.daysOfMonth.has(date.getDate())
    && parsed.months.has(date.getMonth() + 1)
    && parsed.daysOfWeek.has(date.getDay());
}

function parseField(field: string, min: number, max: number, mapValue: (value: number) => number = (value) => value): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) throw new Error(`Invalid cron field: ${field}`);
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-").map(Number);
      start = rawStart;
      end = rawEnd;
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`Invalid cron range: ${part}`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(mapValue(value));
    }
  }
  return values;
}

function normalizeSchedule(schedule: string): string {
  const value = requiredString(schedule, "schedule").replace(/\s+/g, " ");
  const aliases: Record<string, string> = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
  };
  return aliases[value] || value;
}

function assertValidSchedule(schedule: string): void {
  nextCronRun(schedule, new Date());
}

function normalizeAction(input: CronJobInput): CronJobAction {
  if (input.action) return input.action;
  if (input.command) {
    return {
      type: "command",
      command: requiredString(input.command, "command"),
      args: Array.isArray(input.args) ? input.args.map(String) : [],
      input: input.input && typeof input.input === "object" && !Array.isArray(input.input) ? input.input : {},
      format: input.format === "text" ? "text" : "json",
    };
  }
  return {
    type: "chat",
    message: requiredString(input.message, "message"),
    sessionId: input.sessionId || "cron",
    source: input.source || "cron",
    permissionMode: input.permissionMode,
  };
}

function normalizeStoredJob(value: unknown): CronJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = value as Partial<CronJob>;
  if (typeof job.id !== "string" || typeof job.name !== "string" || typeof job.schedule !== "string") return null;
  if (!job.action || typeof job.action !== "object") return null;
  const status = job.status === "paused" ? "paused" : "active";
  const normalized: CronJob = {
    id: job.id,
    name: job.name,
    schedule: normalizeSchedule(job.schedule),
    status,
    action: job.action as CronJobAction,
    nextRunAt: status === "active" ? (typeof job.nextRunAt === "string" ? job.nextRunAt : nextCronRun(job.schedule, new Date()).toISOString()) : null,
    lastRunAt: typeof job.lastRunAt === "string" ? job.lastRunAt : null,
    lastSuccessAt: typeof job.lastSuccessAt === "string" ? job.lastSuccessAt : null,
    lastErrorAt: typeof job.lastErrorAt === "string" ? job.lastErrorAt : null,
    lastError: typeof job.lastError === "string" ? job.lastError : null,
    runCount: Number.isInteger(job.runCount) ? Number(job.runCount) : 0,
    errorCount: Number.isInteger(job.errorCount) ? Number(job.errorCount) : 0,
    createdAt: typeof job.createdAt === "string" ? job.createdAt : new Date().toISOString(),
    updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : new Date().toISOString(),
  };
  try {
    assertValidSchedule(normalized.schedule);
    return normalized;
  } catch {
    return null;
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Cron ${label} is required`);
  return value.trim();
}

function cloneJob(job: CronJob): CronJob {
  return JSON.parse(JSON.stringify(job)) as CronJob;
}
