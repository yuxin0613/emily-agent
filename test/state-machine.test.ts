import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/tasks/TaskStore.ts";
import { createTaskGraph } from "../src/tasks/TaskGraph.ts";

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

const stale = store.getTaskOrThrow(task.id);
store.transitionTask(task.id, "done", {
  result: "completed once",
  agentId: "developer-test",
});
assert.throws(() => {
  store.transitionTask(stale.id, "failed", {
    error: "late writer should lose",
    patch: { metadata: stale.metadata },
  });
}, /Illegal task transition|Task transition conflict/);

const graph = createTaskGraph({
  taskStore: store,
  baseMetadata: { runId: "graph-test" },
  spec: {
    tasks: [
      {
        key: "a",
        role: "planner",
        title: "graph a",
        input: "first",
      },
      {
        key: "b",
        role: "developer",
        title: "graph b",
        input: "second",
        dependsOn: ["a"],
      },
    ],
  },
});
store.enqueueTask(graph.b.id);
assert.equal(store.getTaskOrThrow(graph.b.id).status, "pending");
store.enqueueTask(graph.a.id);
store.claimTask(graph.a.id, "planner-test", { leaseMs: 1000 });
store.finishTask(graph.a.id, {
  result: "a done",
  agentId: "planner-test",
});
assert.equal(store.getTaskOrThrow(graph.b.id).status, "queued");

const retryTask = store.createTask({
  role: "developer",
  title: "retry state machine",
  input: "verify strict task transitions",
  maxRetries: 1,
});

store.enqueueTask(retryTask.id);
store.claimTask(retryTask.id, "developer-test", { leaseMs: 1000 });
store.failTask(retryTask.id, {
  error: "first failure",
  agentId: "developer-test",
});

const failed = store.getTaskOrThrow(retryTask.id);
assert.equal(failed.status, "failed");
assert.equal(failed.retryCount, 1);

store.enqueueTask(retryTask.id);
store.claimTask(retryTask.id, "developer-test", { leaseMs: 1000 });
store.failTask(retryTask.id, {
  error: "second failure",
  agentId: "developer-test",
});

const deadLetter = store.getTaskOrThrow(retryTask.id);
assert.equal(deadLetter.status, "dead_letter");
assert.equal(deadLetter.metadata.deadLetterReason, "max retries exceeded");

store.close();

console.log("state machine test passed");
