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
const taskLeaseToken = store.getTaskOrThrow(task.id).leaseToken;

assert.throws(() => {
  store.transitionTask(task.id, "queued", {
    reason: "illegal backward transition while running",
  });
}, /Illegal task transition/);

const stale = store.getTaskOrThrow(task.id);
store.transitionTask(task.id, "done", {
  result: "completed once",
  agentId: "developer-test",
  patch: {
    leaseToken: taskLeaseToken,
  },
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
const graphALeaseToken = store.getTaskOrThrow(graph.a.id).leaseToken;
store.finishTask(graph.a.id, {
  result: "a done",
  agentId: "planner-test",
  leaseToken: graphALeaseToken,
});
assert.equal(store.getTaskOrThrow(graph.b.id).status, "queued");
const graphId = String(graph.a.metadata.graphId);
const runningGraphs = store.refreshTaskGraphStatuses();
assert.ok(runningGraphs.some((item) => item.id === graphId && item.status === "running"));
store.claimTask(graph.b.id, "developer-test", { leaseMs: 1000 });
const graphBLeaseToken = store.getTaskOrThrow(graph.b.id).leaseToken;
store.finishTask(graph.b.id, {
  result: "b done",
  agentId: "developer-test",
  leaseToken: graphBLeaseToken,
});
const completedGraphs = store.refreshTaskGraphStatuses();
assert.ok(completedGraphs.some((item) => item.id === graphId && item.status === "done"));
assert.equal(store.getTaskGraph(graphId)?.completedAt !== null, true);

const retryTask = store.createTask({
  role: "developer",
  title: "retry state machine",
  input: "verify strict task transitions",
  maxRetries: 1,
});

store.enqueueTask(retryTask.id);
store.claimTask(retryTask.id, "developer-test", { leaseMs: 1000 });
const retryFirstLeaseToken = store.getTaskOrThrow(retryTask.id).leaseToken;
store.failTask(retryTask.id, {
  error: "first failure",
  agentId: "developer-test",
  leaseToken: retryFirstLeaseToken,
});

const failed = store.getTaskOrThrow(retryTask.id);
assert.equal(failed.status, "failed");
assert.equal(failed.retryCount, 1);

store.enqueueTask(retryTask.id);
store.claimTask(retryTask.id, "developer-test", { leaseMs: 1000 });
const retrySecondLeaseToken = store.getTaskOrThrow(retryTask.id).leaseToken;
assert.notEqual(retryFirstLeaseToken, retrySecondLeaseToken);
assert.throws(() => {
  store.finishTask(retryTask.id, {
    result: "late stale result",
    agentId: "developer-test",
    leaseToken: retryFirstLeaseToken,
  });
}, /lease token mismatch/);
store.failTask(retryTask.id, {
  error: "second failure",
  agentId: "developer-test",
  leaseToken: retrySecondLeaseToken,
});

const deadLetter = store.getTaskOrThrow(retryTask.id);
assert.equal(deadLetter.status, "dead_letter");
assert.equal(deadLetter.metadata.deadLetterReason, "max retries exceeded");

const staleRun = store.createRun({
  sessionId: "state-machine",
  source: "test",
  userInput: "recover stale run",
});
const staleRunTask = store.createTask({
  role: "developer",
  title: "stale run task",
  input: "finish before run completion",
  metadata: {
    runId: staleRun.id,
  },
});
store.enqueueTask(staleRunTask.id);
store.claimTask(staleRunTask.id, "developer-test", { leaseMs: 1000 });
const staleRunLeaseToken = store.getTaskOrThrow(staleRunTask.id).leaseToken;
store.finishTask(staleRunTask.id, {
  result: "run task done",
  agentId: "developer-test",
  leaseToken: staleRunLeaseToken,
});
const recoveredRuns = store.recoverStaleRuns({ olderThanMs: 0 });
assert.ok(recoveredRuns.some((run) => run.id === staleRun.id && run.status === "done"));
assert.equal(store.getRun(staleRun.id)?.completedAt !== null, true);

store.close();

console.log("state machine test passed");
