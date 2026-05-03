import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { TaskStore } from "../src/tasks/TaskStore.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-restart-"));
const prebootStore = await TaskStore.create({ dataDir });
const queued = prebootStore.createTask({
  role: "developer",
  title: "queued before restart",
  input: "Verify queued tasks drain after runtime restart.",
  metadata: {
    sessionId: "restart",
  },
});
prebootStore.enqueueTask(queued.id);
const dynamicQueued = prebootStore.createTask({
  role: "qa",
  title: "dynamic role queued before restart",
  input: "Verify a role outside the default list can drain after runtime restart.",
  metadata: {
    sessionId: "restart",
  },
});
prebootStore.enqueueTask(dynamicQueued.id);
prebootStore.close();

const runtime = await createRuntime({ dataDir });
const finished = await runtime.roleAgentManager.waitForTask(queued.id, {
  timeoutMs: 10000,
});
const dynamicFinished = await runtime.roleAgentManager.waitForTask(dynamicQueued.id, {
  timeoutMs: 10000,
});

assert.equal(finished.status, "done");
assert.equal(dynamicFinished.status, "done");
const trace = runtime.getTaskTrace(queued.id);
assert.ok(trace.events.some((event) => event.type === "task.done"));
assert.ok(runtime.taskStore.getQueuedRoles().length === 0);

await runtime.shutdown();

console.log("restart test passed");
