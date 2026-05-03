import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
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

const concurrentDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-memory-concurrent-"));
const memoryA = await MemorySystem.create({ dataDir: concurrentDir });
const memoryB = await MemorySystem.create({ dataDir: concurrentDir });
await Promise.all([
  memoryA.remember({
    scope: "project",
    kind: "decision",
    content: "Concurrent vector write alpha keeps SQLite lease token memory safe when one process updates the index.",
  }),
  memoryB.remember({
    scope: "project",
    kind: "decision",
    content: "Concurrent vector write beta keeps memory candidate approval safe when another process updates the index.",
  }),
]);
const memoryC = await MemorySystem.create({ dataDir: concurrentDir });
const concurrentRecall = await memoryC.recall("concurrent vector write memory", {
  scope: "project",
  limit: 10,
});
assert.ok(concurrentRecall.semantic.some((item) => item.content.includes("alpha")));
assert.ok(concurrentRecall.semantic.some((item) => item.content.includes("beta")));
assert.ok(concurrentRecall.files.some((item) => item.content.includes("alpha")));
assert.ok(concurrentRecall.files.some((item) => item.content.includes("beta")));

const corruptDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-memory-corrupt-"));
const corruptMemory = await MemorySystem.create({ dataDir: corruptDir });
await corruptMemory.remember({
  scope: "project",
  kind: "decision",
  content: "Clean file memory survives corrupt jsonl lines during recall.",
});
const eventsPath = path.join(corruptDir, "memory", "events.jsonl");
await appendFile(eventsPath, "{not json}\n", "utf8");
const corruptRecall = await corruptMemory.recall("clean corrupt jsonl recall", {
  scope: "project",
  limit: 5,
});
assert.ok(corruptRecall.files.some((item) => item.content.includes("Clean file memory")));
assert.doesNotMatch(await readFile(eventsPath, "utf8"), /not json/);
assert.match(await readFile(`${eventsPath}.corrupt.jsonl`, "utf8"), /not json/);

console.log("memory optimization test passed");
