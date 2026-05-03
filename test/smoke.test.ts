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
assert.ok(response.delegatedTo.includes("planner"));
assert.ok(response.delegatedTo.includes("developer"));
assert.ok(response.plan);
assert.equal(response.plan.deliveryLevel, "poc");
assert.ok(response.subResults?.some((result) => result.role === "reviewer"));
assert.equal(response.reviewerVerdict?.verdict, "pass");

const memory = await runtime.memory.recall("Node 多 agent 架构", {
  sessionId: "smoke",
  scope: "smoke",
  limit: 3,
});

assert.ok(memory.shortTerm.length > 0);
assert.ok(memory.files.length > 0);
assert.ok(memory.semantic.length > 0);

const events = runtime.taskStore.getLatestEvents({ limit: 200 });
assert.ok(events.some((event) => event.type === "task.done"));
assert.ok(events.some((event) => event.type === "run.completed"));
assert.ok(response.runId);
const candidates = runtime.taskStore.getMemoryCandidatesForRun(response.runId);
assert.ok(candidates.length > 0);
assert.ok(candidates.some((candidate) => candidate.status === "approved"));

const reviewer = response.subResults?.filter((result) => result.role === "reviewer").at(-1);
assert.ok(reviewer);
const reviewerTask = runtime.taskStore.getTask(reviewer.taskId);
assert.equal(reviewerTask?.status, "done");
const trace = runtime.getTaskTrace(reviewer.taskId);
assert.ok(trace.tasks.some((task) => task.id === reviewer.taskId && task.status === "done"));
const timeline = runtime.getTimeline({ runId: response.runId });
assert.equal(timeline.run?.status, "done");
assert.ok(timeline.tasks.length >= 3);
assert.ok(timeline.events.some((event) => event.type === "run.started"));
assert.ok(runtime.renderTimeline(response.runId).includes("run done"));
const health = runtime.health();
assert.equal(health.runningTasks, 0);
const maintenance = await runtime.maintenance();
assert.ok(maintenance.health.activeExperiences >= 0);

await runtime.shutdown();

console.log("smoke test passed");
