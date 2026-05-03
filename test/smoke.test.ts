import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-"));
const runtime = await createRuntime({ dataDir });

const response = await runtime.handleUserMessage("帮我设计一个 Node 多 agent 架构", {
  sessionId: "smoke",
  source: "test",
});

assert.equal(response.agent, "emily");
assert.ok(response.content.includes("EchoModelProvider"));
assert.deepEqual(response.delegatedTo, ["planner", "developer"]);

const memory = await runtime.memory.recall("Node 多 agent 架构", {
  sessionId: "smoke",
  scope: "smoke",
  limit: 3,
});

assert.ok(memory.shortTerm.length > 0);
assert.ok(memory.files.length > 0);
assert.ok(memory.semantic.length > 0);

const events = runtime.taskStore.getLatestEvents({ limit: 10 });
assert.ok(events.some((event) => event.type === "task.done"));

await runtime.shutdown();

console.log("smoke test passed");
