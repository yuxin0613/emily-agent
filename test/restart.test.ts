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
prebootStore.close();

const runtime = await createRuntime({ dataDir });
const finished = await runtime.roleAgentManager.waitForTask(queued.id, {
  timeoutMs: 10000,
});

assert.equal(finished.status, "done");
const trace = runtime.getTaskTrace(queued.id);
assert.ok(trace.events.some((event) => event.type === "task.done"));

await runtime.shutdown();

console.log("restart test passed");
