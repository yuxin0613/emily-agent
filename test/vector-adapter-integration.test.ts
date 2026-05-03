import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/memory/MemorySystem.ts";
import { vectorStoreConfigFromEnv } from "../src/memory/VectorStoreAdapter.ts";

if (process.env.EMILY_VECTOR_INTEGRATION !== "true") {
  console.log("vector adapter integration test skipped; set EMILY_VECTOR_INTEGRATION=true with test/fixtures/vector/docker-compose.yml");
  process.exit(0);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-vector-integration-"));
const vectorStore = {
  ...vectorStoreConfigFromEnv(process.env),
  fallbackToFile: process.env.EMILY_VECTOR_FALLBACK !== "false",
};
let pgPool: { query: (sql: string, params?: unknown[]) => Promise<unknown>; end: () => Promise<void> } | null = null;
if (vectorStore.kind === "pgvector") {
  const connectionString = process.env[vectorStore.connectionStringEnv || "DATABASE_URL"];
  assert.ok(connectionString, `pgvector integration requires ${vectorStore.connectionStringEnv || "DATABASE_URL"}`);
  const pg = await import("pg").catch((error) => {
    throw new Error(`pgvector integration requires host app dependency "pg": ${error instanceof Error ? error.message : String(error)}`);
  });
  pgPool = new pg.Pool({ connectionString });
  vectorStore.pgDriver = {
    query: (sql, params) => pgPool!.query(sql, params),
  };
}

const memory = await MemorySystem.create({
  dataDir,
  vectorStore,
});

const health = await memory.vectorHealth();
assert.equal(health.ok, true, `vector store health failed: ${health.message || "unknown"}`);

await memory.remember({
  scope: "vector-integration",
  kind: "note",
  content: "External vector adapter parity memory record for AgentOS recall.",
  metadata: {
    importance: 0.9,
    confidence: 0.9,
  },
});

const recalled = await memory.recall("AgentOS external vector parity recall", {
  scope: "vector-integration",
  limit: 3,
});
assert.ok(recalled.semantic.some((item) => item.content.includes("External vector adapter parity")));

await pgPool?.end();
console.log("vector adapter integration test passed");
