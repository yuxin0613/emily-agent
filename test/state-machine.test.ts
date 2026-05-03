import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/tasks/TaskStore.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-state-"));
const store = await TaskStore.create({ dataDir });

const task = store.createTask({
  role: "developer",
  title: "state machine",
  input: "verify strict task transitions",
  maxRetries: 1,
});

store.enqueueTask(task.id);
store.claimTask(task.id, "developer-test", { leaseMs: 1000 });

assert.throws(() => {
  store.transitionTask(task.id, "queued", {
    reason: "illegal backward transition while running",
  });
}, /Illegal task transition/);

store.failTask(task.id, {
  error: "first failure",
  agentId: "developer-test",
});

const failed = store.getTaskOrThrow(task.id);
assert.equal(failed.status, "failed");
assert.equal(failed.retryCount, 1);

store.enqueueTask(task.id);
store.claimTask(task.id, "developer-test", { leaseMs: 1000 });
store.failTask(task.id, {
  error: "second failure",
  agentId: "developer-test",
});

const deadLetter = store.getTaskOrThrow(task.id);
assert.equal(deadLetter.status, "dead_letter");
assert.equal(deadLetter.metadata.deadLetterReason, "max retries exceeded");

store.close();

console.log("state machine test passed");
