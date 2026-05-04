import { createRequire } from "node:module";
import type DatabaseConstructor from "better-sqlite3";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof DatabaseConstructor;

export type SqliteDatabase = ReturnType<typeof Database>;

export function openSqliteDatabase(dbPath: string, { timeout = 5000 }: { timeout?: number } = {}): SqliteDatabase {
  const db = new Database(dbPath, { timeout });
  db.pragma(`busy_timeout = ${timeout}`);
  runSqliteWithRetry(() => db.pragma("journal_mode = WAL"), { timeoutMs: timeout });
  db.pragma("foreign_keys = ON");
  return db;
}

export function runSqliteWithRetry<T>(
  operation: () => T,
  { timeoutMs = 5000, minDelayMs = 20, maxDelayMs = 250 }: { timeoutMs?: number; minDelayMs?: number; maxDelayMs?: number } = {},
): T {
  const deadline = Date.now() + timeoutMs;
  let delayMs = minDelayMs;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() + delayMs > deadline) throw error;
      sleepSync(delayMs);
      delayMs = Math.min(maxDelayMs, Math.floor(delayMs * 1.6));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && ((error as { code?: string }).code === "SQLITE_BUSY" || (error as { code?: string }).code === "SQLITE_LOCKED"));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
