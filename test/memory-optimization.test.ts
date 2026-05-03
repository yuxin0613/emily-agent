import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/memory/MemorySystem.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-memory-opt-"));
const memory = await MemorySystem.create({ dataDir });

await memory.remember({
  scope: "project",
  kind: "decision",
  content: "Use SQLite leases, worker heartbeats, and inspector recovery when a subagent exits without IPC notification.",
  metadata: {
    importance: 0.95,
    confidence: 0.92,
  },
});
await memory.remember({
  scope: "project",
  kind: "decision",
  content: "Use SQLite leases, worker heartbeats, and inspector recovery when a subagent exits without IPC notification.",
  metadata: {
    importance: 0.95,
    confidence: 0.92,
  },
});
await memory.remember({
  scope: "project",
  kind: "project_fact",
  content: "Provider observability records usage, cost, JSON fallback, and quota events in SQLite.",
  metadata: {
    importance: 0.7,
    confidence: 0.8,
  },
});
await memory.remember({
  scope: "project",
  kind: "note",
  content: "Tiny note that should stay in file memory but is less important.",
});

const before = await memory.recall("sqlite lease inspector recovery", {
  scope: "project",
  limit: 3,
});
assert.match(before.semantic[0]?.content || "", /SQLite leases/);

const compacted = await memory.compact({
  maxFileRecords: 3,
  maxVectorRecords: 1,
});
assert.ok(compacted.file.removed >= 1);
assert.ok(compacted.vector.removed >= 1);
assert.equal(compacted.vector.algorithm, "scalar-int8");

const after = await memory.recall("subagent exits without ipc notification", {
  scope: "project",
  limit: 3,
});
assert.ok(after.semantic.length <= 1);
assert.match(after.semantic[0]?.content || "", /SQLite leases/);

console.log("memory optimization test passed");
