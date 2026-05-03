import assert from "node:assert/strict";
import {
  createVectorStoreAdapter,
  type PgVectorDriver,
  type VectorStoreItem,
} from "../src/memory/VectorStoreAdapter.ts";
import type { MemoryRecord } from "../src/types.ts";

function item(id: string, scope: string, content: string, embedding: number[]): VectorStoreItem {
  const record: MemoryRecord = {
    id,
    scope,
    kind: "note",
    content,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    id,
    record,
    vector: {
      algorithm: "test",
      dimensions: embedding.length,
      payload: embedding,
    },
    embedding,
    contentHash: id,
    updatedAt: record.createdAt,
    hits: id === "mem-a" ? 2 : 0,
  };
}

class FakePgVectorDriver implements PgVectorDriver {
  private readonly rows = new Map<string, {
    id: string;
    collection: string;
    scope: string;
    record: MemoryRecord;
    embedding: number[];
    updatedAt: string;
    hits: number;
  }>();

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const normalized = sql.toLowerCase();
    if (normalized.includes("insert into")) {
      this.rows.set(String(params[0]), {
        id: String(params[0]),
        collection: String(params[1]),
        scope: String(params[2]),
        record: JSON.parse(String(params[5])) as MemoryRecord,
        embedding: parseVectorLiteral(String(params[7])),
        updatedAt: String(params[9]),
        hits: Number(params[10] || 0),
      });
      return { rows: [] };
    }
    if (normalized.includes("select count")) {
      const collection = String(params[0]);
      return {
        rows: [{
          count: [...this.rows.values()].filter((row) => row.collection === collection).length,
        }],
      };
    }
    if (normalized.includes("select") && normalized.includes("record_json")) {
      const collection = String(params[0]);
      const queryEmbedding = parseVectorLiteral(String(params[1]));
      const scope = String(params[2]);
      const limit = Number(params[3] || 10);
      return {
        rows: [...this.rows.values()]
          .filter((row) => row.collection === collection && row.scope === scope)
          .map((row) => ({
            record: row.record,
            score: 1 / (1 + cosineDistance(queryEmbedding, row.embedding)),
          }))
          .sort((left, right) => Number(right.score) - Number(left.score))
          .slice(0, limit),
      };
    }
    if (normalized.includes("delete from")) {
      const collection = String(params[0]);
      const maxItems = Number(params[1] || 0);
      const keep = new Set([...this.rows.values()]
        .filter((row) => row.collection === collection)
        .sort((left, right) => right.hits - left.hits || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
        .slice(0, maxItems)
        .map((row) => row.id));
      for (const row of this.rows.values()) {
        if (row.collection === collection && !keep.has(row.id)) this.rows.delete(row.id);
      }
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function parseVectorLiteral(input: string): number[] {
  return input.replace(/^\[|\]$/g, "").split(",").filter(Boolean).map(Number);
}

function cosineDistance(left: number[], right: number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] || 0), 0);
  const leftMagnitude = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0)) || 1;
  const rightMagnitude = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0)) || 1;
  return 1 - dot / (leftMagnitude * rightMagnitude);
}

const driver = new FakePgVectorDriver();
const adapter = createVectorStoreAdapter({
  kind: "pgvector",
  collection: "agentos_test",
  pgDriver: driver,
  tableName: "agentos_memory_vectors_test",
  fallbackToFile: false,
});

assert.ok(adapter);
assert.equal(adapter.kind, "pgvector");

await adapter.upsert([
  item("mem-a", "project", "agent memory durable workflow", [1, 0, 0]),
  item("mem-b", "project", "unrelated provider routing", [0, 1, 0]),
  item("mem-c", "other", "agent memory in another scope", [1, 0, 0]),
]);

const health = await adapter.health();
assert.equal(health.ok, true);
assert.match(String(health.message || ""), /indexed records/);

const results = await adapter.search({
  query: "agent memory",
  queryEmbedding: [1, 0, 0],
  scope: "project",
  limit: 2,
});
assert.equal(results[0].id, "mem-a");
assert.ok(results.every((record) => record.scope === "project"));

const compact = await adapter.compact({ maxItems: 1 });
assert.equal(compact.before, 3);
assert.equal(compact.after, 1);
assert.equal(compact.removed, 2);

console.log("vector adapter test passed");
