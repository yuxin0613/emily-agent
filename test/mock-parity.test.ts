import assert from "node:assert/strict";
import { createMockParityHarness, assertEventSequence, assertHasEvent } from "./harness/MockParityHarness.ts";

const harness = await createMockParityHarness("mock-parity");

try {
  const doctor = await harness.gateway("doctor.run", { deep: false });
  assert.equal(doctor.ok, true);
  assert.ok(doctor.result && typeof doctor.result === "object");
  assert.equal((doctor.result as { vectorMemory?: { kind?: string } }).vectorMemory?.kind, "file");

  const commands = await harness.gateway("commands.list");
  assert.equal(commands.ok, true);
  assert.ok(Array.isArray(commands.result));
  assert.ok(commands.result.some((command) => command.name === "tool.execute" && command.permission === "write"));

  const tool = await harness.gateway("tools.execute", {
    tool: "read_file",
    role: "developer",
    args: { path: "README.md", maxBytes: 240 },
    sessionId: "mock-parity",
  });
  assert.equal(tool.ok, true);
  assert.equal((tool.result as { ok?: boolean }).ok, true);
  assert.match(String((tool.result as { output?: { content?: string } }).output?.content || ""), /Emily AgentOS/);
  assertHasEvent(harness.runtime.taskStore.getLatestEvents({ limit: 50 }), "tool.execution.completed");

  const run = await harness.chat("POC 实现一个可扩展 agent 应用", "mock-parity");
  assert.ok(run.response.runId);
  assert.ok(run.timeline);
  assertEventSequence(run.timeline!.events, [
    "task_graph.expansion_planned",
    "task_graph.expanded",
    "task_graph.quality",
  ]);
  assertHasEvent(run.timeline!.events, "task_graph.quality", (event) => typeof event.payload.score === "number");

  const crash = await harness.runWorkerCrashRecovery();
  assert.equal(crash.status, "failed");
  assert.ok(String(crash.metadata.inspectionTaskId || ""));

  const cancelled = await harness.cancelDelayedWorker();
  assert.equal(cancelled.status, "cancelled");

  const candidate = harness.createMemoryCandidate();
  const maintenance = await harness.runtime.maintenance();
  assert.equal(harness.runtime.taskStore.getMemoryCandidate(candidate.id)?.status, "approved");
  assert.ok((maintenance as { memoryCandidates?: { approved?: number } }).memoryCandidates?.approved);

  const memory = await harness.runtime.memory.recall("agent memory durable workflow", {
    scope: "mock-parity",
    limit: 5,
  });
  assert.ok(memory.semantic.some((item) => item.content.includes("memory candidate approval")));

  const replan = await harness.runMultiRoundReplanBenchmark();
  assertHasEvent(replan.timeline.events, "task_graph.failure_clustered", (event) => event.payload.cluster === "timeout");
  assertHasEvent(replan.timeline.events, "task_graph.failure_clustered", (event) => event.payload.cluster === "provider");
  assertHasEvent(replan.timeline.events, "task_graph.replan_quality", (event) => typeof event.payload.score === "number");
  assert.ok(replan.timeline.events.filter((event) => event.type === "task_graph.replanned").length >= 2);
  assert.ok(replan.result.quality.failureClusters.timeout >= 1);
  assert.equal(harness.runtime.taskStore.getTaskGraph(replan.result.graphId!)?.status, "done");
} finally {
  await harness.close();
}

console.log("mock parity test passed");
