import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { parseTaskResult } from "../src/tasks/TaskResult.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-core-"));
const runtime = await createRuntime({ dataDir });

const cancellable = runtime.taskStore.createTask({
  role: "developer",
  title: "cancel queued task",
  input: "This task should be cancelled before execution.",
  metadata: {
    sessionId: "core-hardening",
  },
});
runtime.taskStore.enqueueTask(cancellable.id);
await runtime.cancelTask(cancellable.id, "test cancellation");
assert.equal(runtime.taskStore.getTaskOrThrow(cancellable.id).status, "cancelled");

const slow = runtime.taskStore.createTask({
  role: "developer",
  title: "timeout task",
  input: "This task should timeout inside the worker.",
  metadata: {
    sessionId: "core-hardening",
    timeoutMs: 10,
    forceDelayMs: 60,
  },
});
const timedOut = await runtime.roleAgentManager.runTask(slow, {
  timeoutMs: 5000,
});
assert.equal(timedOut.status, "failed");
assert.match(timedOut.error || "", /timed out/);
assert.equal(parseTaskResult(timedOut.result)?.status, "failed");

const response = await runtime.handleUserMessage("帮我检查 runtime diagnostics", {
  sessionId: "core-hardening",
  source: "test",
});
assert.ok(response.runId);
const timeline = runtime.getTimeline({ runId: response.runId });
assert.ok(timeline.tasks.every((task) => typeof task.metadata.graphId === "string"));

const diagnostics = runtime.diagnostics();
assert.ok(Array.isArray(diagnostics));
const maintenance = await runtime.maintenance({
  staleRunMs: 0,
  maxEvents: 1000,
});
assert.ok(maintenance.database);
assert.ok(maintenance.diagnostics);

await runtime.shutdown();

console.log("core hardening test passed");
