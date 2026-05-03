import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-recovery-"));
const runtime = await createRuntime({ dataDir });

const task = runtime.taskStore.createTask({
  role: "developer",
  title: "crash recovery",
  input: "This task intentionally crashes its worker.",
  metadata: {
    sessionId: "recovery",
    forceCrash: true,
  },
});

const finishedTask = await runtime.roleAgentManager.runTask(task, {
  timeoutMs: 10000,
});

assert.equal(finishedTask.status, "failed");
assert.equal(finishedTask.metadata.inspectionReason.includes("worker exited"), true);

const inspectionTask = runtime.taskStore.getTask(finishedTask.metadata.inspectionTaskId);
assert.equal(inspectionTask.status, "done");
assert.equal(inspectionTask.role, "inspector");

await runtime.shutdown();

console.log("recovery test passed");
