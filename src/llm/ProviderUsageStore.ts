import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelCompleteInput, ModelCompleteResult, ModelUsage, ProviderConfig } from "./ModelProvider.ts";
import { ProviderCallError } from "./ModelProvider.ts";
import { SchemaMigrator } from "../storage/SchemaMigrator.ts";
import { openSqliteDatabase, type SqliteDatabase } from "../storage/Sqlite.ts";

export interface ProviderUsageRecord {
  id: string;
  providerId: string;
  model: string;
  agent: string;
  role: string;
  taskId: string | null;
  runId: string | null;
  status: "success" | "failed" | "blocked";
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
  attempts: number;
  createdAt: string;
}

export interface ProviderUsageTotals {
  calls: number;
  success: number;
  failed: number;
  blocked: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface ProviderUsageProviderSummary extends ProviderUsageTotals {
  providerId: string;
  model: string;
}

export interface ProviderUsageSummary {
  since: string;
  until: string;
  totals: ProviderUsageTotals;
  providers: ProviderUsageProviderSummary[];
  recent: ProviderUsageRecord[];
}

interface ProviderUsageRow {
  id: string;
  provider_id: string;
  model: string;
  agent: string;
  role: string;
  task_id: string | null;
  run_id: string | null;
  status: ProviderUsageRecord["status"];
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  latency_ms: number;
  attempts: number;
  created_at: string;
}

export class ProviderUsageStore {
  dataDir: string;
  db: SqliteDatabase;

  static async create({ dataDir }: { dataDir: string }): Promise<ProviderUsageStore> {
    await mkdir(dataDir, { recursive: true });
    const store = new ProviderUsageStore({
      dataDir,
      dbPath: path.join(dataDir, "emily.sqlite"),
    });
    store.migrate();
    return store;
  }

  constructor({ dataDir, dbPath }: { dataDir: string; dbPath: string }) {
    this.dataDir = dataDir;
    this.db = openSqliteDatabase(dbPath);
  }

  migrate(): void {
    new SchemaMigrator({ db: this.db, namespace: "provider" }).apply([
      {
        version: 1,
        name: "create_provider_usage",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS provider_usage (
              id TEXT PRIMARY KEY,
              provider_id TEXT NOT NULL,
              model TEXT NOT NULL,
              agent TEXT NOT NULL,
              role TEXT NOT NULL,
              task_id TEXT,
              run_id TEXT,
              status TEXT NOT NULL,
              error_code TEXT,
              input_tokens INTEGER NOT NULL DEFAULT 0,
              output_tokens INTEGER NOT NULL DEFAULT 0,
              total_tokens INTEGER NOT NULL DEFAULT 0,
              cost_usd REAL NOT NULL DEFAULT 0,
              latency_ms INTEGER NOT NULL DEFAULT 0,
              attempts INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_provider_usage_time ON provider_usage(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_provider_usage_provider_time ON provider_usage(provider_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_provider_usage_run ON provider_usage(run_id, created_at DESC);
          `);
        },
      },
    ]);
  }

  assertWithinLimits(config: ProviderConfig, input: ModelCompleteInput, now = new Date()): void {
    const limits = config.config || {};
    if (!limits.maxCallsPerMinute && !limits.maxCallsPerDay && !limits.maxTokensPerDay && !limits.maxCostUsdPerDay) return;

    const minuteStart = new Date(now.getTime() - 60 * 1000).toISOString();
    const dayStart = startOfUtcDay(now).toISOString();
    if (limits.maxCallsPerMinute !== undefined && this.countCalls(config.id, minuteStart) >= limits.maxCallsPerMinute) {
      throw quotaError(config.id, `Provider ${config.id} exceeded maxCallsPerMinute=${limits.maxCallsPerMinute}`);
    }
    if (limits.maxCallsPerDay !== undefined && this.countCalls(config.id, dayStart) >= limits.maxCallsPerDay) {
      throw quotaError(config.id, `Provider ${config.id} exceeded maxCallsPerDay=${limits.maxCallsPerDay}`);
    }

    const dayUsage = this.usageSince(config.id, dayStart);
    const estimatedInputTokens = estimateTokens(input.prompt);
    if (limits.maxTokensPerDay !== undefined && dayUsage.totalTokens + estimatedInputTokens > limits.maxTokensPerDay) {
      throw quotaError(config.id, `Provider ${config.id} exceeded maxTokensPerDay=${limits.maxTokensPerDay}`);
    }
    const estimatedInputCost = estimateCostUsd(config, { inputTokens: estimatedInputTokens, outputTokens: 0, totalTokens: estimatedInputTokens });
    if (limits.maxCostUsdPerDay !== undefined && dayUsage.costUsd + estimatedInputCost > limits.maxCostUsdPerDay) {
      throw quotaError(config.id, `Provider ${config.id} exceeded maxCostUsdPerDay=${limits.maxCostUsdPerDay}`);
    }
  }

  recordSuccess(config: ProviderConfig, input: ModelCompleteInput, result: ModelCompleteResult): ProviderUsageRecord {
    const usage = completeUsage(input, result);
    return this.insertRecord({
      config,
      input,
      status: "success",
      errorCode: null,
      usage,
      costUsd: estimateCostUsd(config, usage),
      latencyMs: result.latencyMs || 0,
      attempts: result.attempts || 1,
    });
  }

  recordFailure(config: ProviderConfig, input: ModelCompleteInput, error: ProviderCallError, latencyMs: number, attempts: number): ProviderUsageRecord {
    const usage = { inputTokens: estimateTokens(input.prompt), outputTokens: 0, totalTokens: estimateTokens(input.prompt) };
    return this.insertRecord({
      config,
      input,
      status: error.code === "quota_exceeded" ? "blocked" : "failed",
      errorCode: error.code,
      usage,
      costUsd: 0,
      latencyMs,
      attempts,
    });
  }

  summary({ since, until = new Date(), providerId, limit = 20 }: { since?: Date; until?: Date; providerId?: string; limit?: number } = {}): ProviderUsageSummary {
    const start = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
    const where = providerId ? "created_at >= ? AND created_at <= ? AND provider_id = ?" : "created_at >= ? AND created_at <= ?";
    const params = providerId ? [start.toISOString(), until.toISOString(), providerId] : [start.toISOString(), until.toISOString()];
    const rows = this.db
      .prepare(`
        SELECT provider_id, model,
          COUNT(*) AS calls,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(total_tokens) AS totalTokens,
          SUM(cost_usd) AS costUsd,
          AVG(latency_ms) AS avgLatencyMs
        FROM provider_usage
        WHERE ${where}
        GROUP BY provider_id, model
        ORDER BY costUsd DESC, calls DESC
      `)
      .all(...params) as Array<{
        provider_id: string;
        model: string;
        calls: number;
        success: number;
        failed: number;
        blocked: number;
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
        costUsd: number | null;
        avgLatencyMs: number | null;
      }>;
    const providers = rows.map((row) => ({
      providerId: row.provider_id,
      model: row.model,
      calls: row.calls,
      success: row.success,
      failed: row.failed,
      blocked: row.blocked,
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      totalTokens: row.totalTokens || 0,
      costUsd: row.costUsd || 0,
      avgLatencyMs: Math.round(row.avgLatencyMs || 0),
    }));
    const totals = providers.reduce((acc, item) => ({
      calls: acc.calls + item.calls,
      success: acc.success + item.success,
      failed: acc.failed + item.failed,
      blocked: acc.blocked + item.blocked,
      inputTokens: acc.inputTokens + item.inputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
      totalTokens: acc.totalTokens + item.totalTokens,
      costUsd: acc.costUsd + item.costUsd,
      avgLatencyMs: acc.avgLatencyMs + item.avgLatencyMs * item.calls,
    }), emptyTotals());
    if (totals.calls) totals.avgLatencyMs = Math.round(totals.avgLatencyMs / totals.calls);
    return {
      since: start.toISOString(),
      until: until.toISOString(),
      totals,
      providers,
      recent: this.recent({ since: start, until, providerId, limit }),
    };
  }

  summaryForRuns(runIds: string[], { limit = 20 }: { limit?: number } = {}): ProviderUsageSummary {
    const ids = unique(runIds.map(String).filter(Boolean));
    const now = new Date();
    if (!ids.length) {
      return {
        since: now.toISOString(),
        until: now.toISOString(),
        totals: emptyTotals(),
        providers: [],
        recent: [],
      };
    }
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT provider_id, model,
          COUNT(*) AS calls,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(total_tokens) AS totalTokens,
          SUM(cost_usd) AS costUsd,
          AVG(latency_ms) AS avgLatencyMs
        FROM provider_usage
        WHERE run_id IN (${placeholders})
        GROUP BY provider_id, model
        ORDER BY costUsd DESC, calls DESC
      `)
      .all(...ids) as Array<{
        provider_id: string;
        model: string;
        calls: number;
        success: number;
        failed: number;
        blocked: number;
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
        costUsd: number | null;
        avgLatencyMs: number | null;
      }>;
    const providers = rows.map((row) => ({
      providerId: row.provider_id,
      model: row.model,
      calls: row.calls,
      success: row.success,
      failed: row.failed,
      blocked: row.blocked,
      inputTokens: row.inputTokens || 0,
      outputTokens: row.outputTokens || 0,
      totalTokens: row.totalTokens || 0,
      costUsd: row.costUsd || 0,
      avgLatencyMs: Math.round(row.avgLatencyMs || 0),
    }));
    const totals = providers.reduce((acc, item) => ({
      calls: acc.calls + item.calls,
      success: acc.success + item.success,
      failed: acc.failed + item.failed,
      blocked: acc.blocked + item.blocked,
      inputTokens: acc.inputTokens + item.inputTokens,
      outputTokens: acc.outputTokens + item.outputTokens,
      totalTokens: acc.totalTokens + item.totalTokens,
      costUsd: acc.costUsd + item.costUsd,
      avgLatencyMs: acc.avgLatencyMs + item.avgLatencyMs * item.calls,
    }), emptyTotals());
    if (totals.calls) totals.avgLatencyMs = Math.round(totals.avgLatencyMs / totals.calls);
    return {
      since: "",
      until: now.toISOString(),
      totals,
      providers,
      recent: this.recentForRuns(ids, { limit }),
    };
  }

  recentForRuns(runIds: string[], { limit = 20 }: { limit?: number } = {}): ProviderUsageRecord[] {
    const ids = unique(runIds.map(String).filter(Boolean));
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM provider_usage WHERE run_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
      .all(...ids, limit) as unknown as ProviderUsageRow[];
    return rows.map(parseProviderUsage);
  }

  recent({ since, until = new Date(), providerId, limit = 20 }: { since?: Date; until?: Date; providerId?: string; limit?: number } = {}): ProviderUsageRecord[] {
    const start = since || new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = providerId
      ? this.db
        .prepare("SELECT * FROM provider_usage WHERE created_at >= ? AND created_at <= ? AND provider_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(start.toISOString(), until.toISOString(), providerId, limit) as unknown as ProviderUsageRow[]
      : this.db
        .prepare("SELECT * FROM provider_usage WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?")
        .all(start.toISOString(), until.toISOString(), limit) as unknown as ProviderUsageRow[];
    return rows.map(parseProviderUsage);
  }

  close(): void {
    this.db.close();
  }

  private insertRecord({
    config,
    input,
    status,
    errorCode,
    usage,
    costUsd,
    latencyMs,
    attempts,
  }: {
    config: ProviderConfig;
    input: ModelCompleteInput;
    status: ProviderUsageRecord["status"];
    errorCode: string | null;
    usage: Required<ModelUsage>;
    costUsd: number;
    latencyMs: number;
    attempts: number;
  }): ProviderUsageRecord {
    const record: ProviderUsageRecord = {
      id: randomUUID(),
      providerId: config.id,
      model: config.model || "",
      agent: input.agent,
      role: input.role,
      taskId: input.taskId || null,
      runId: input.runId || null,
      status,
      errorCode,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      costUsd,
      latencyMs,
      attempts,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`
        INSERT INTO provider_usage (
          id, provider_id, model, agent, role, task_id, run_id, status, error_code,
          input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, attempts, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.providerId,
        record.model,
        record.agent,
        record.role,
        record.taskId,
        record.runId,
        record.status,
        record.errorCode,
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        record.costUsd,
        record.latencyMs,
        record.attempts,
        record.createdAt,
      );
    return record;
  }

  private countCalls(providerId: string, since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM provider_usage WHERE provider_id = ? AND created_at >= ?")
      .get(providerId, since) as { count: number };
    return row.count;
  }

  private usageSince(providerId: string, since: string): { totalTokens: number; costUsd: number } {
    const row = this.db
      .prepare("SELECT SUM(total_tokens) AS totalTokens, SUM(cost_usd) AS costUsd FROM provider_usage WHERE provider_id = ? AND created_at >= ?")
      .get(providerId, since) as { totalTokens: number | null; costUsd: number | null };
    return {
      totalTokens: row.totalTokens || 0,
      costUsd: row.costUsd || 0,
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function estimateCostUsd(config: ProviderConfig, usage: Required<ModelUsage>): number {
  const inputRate = config.config?.costPer1KInputTokens || 0;
  const outputRate = config.config?.costPer1KOutputTokens || 0;
  return roundUsd((usage.inputTokens / 1000) * inputRate + (usage.outputTokens / 1000) * outputRate);
}

function completeUsage(input: ModelCompleteInput, result: ModelCompleteResult): Required<ModelUsage> {
  const inputTokens = result.usage?.inputTokens ?? estimateTokens(input.prompt);
  const outputTokens = result.usage?.outputTokens ?? estimateTokens(result.content);
  return {
    inputTokens,
    outputTokens,
    totalTokens: result.usage?.totalTokens ?? inputTokens + outputTokens,
  };
}

function parseProviderUsage(row: ProviderUsageRow): ProviderUsageRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    model: row.model,
    agent: row.agent,
    role: row.role,
    taskId: row.task_id,
    runId: row.run_id,
    status: row.status,
    errorCode: row.error_code,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

function emptyTotals(): ProviderUsageTotals {
  return {
    calls: 0,
    success: 0,
    failed: 0,
    blocked: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    avgLatencyMs: 0,
  };
}

function quotaError(providerId: string, message: string): ProviderCallError {
  return new ProviderCallError({
    providerId,
    code: "quota_exceeded",
    message,
  });
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
