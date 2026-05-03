import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

const rejectedMemoryTask = runtime.taskStore.createTask({
  role: "qa-memory",
  title: "rejected memory candidate",
  input: "Return an echo-provider result that should be rejected by memory policy.",
  metadata: {
    sessionId: "memory-gate",
  },
});
const rejectedMemoryFinished = await runtime.roleAgentManager.runTask(rejectedMemoryTask, {
  timeoutMs: 10000,
});
assert.equal(rejectedMemoryFinished.status, "done");
const rejectedCandidate = runtime.taskStore.getPendingMemoryCandidates({ limit: 100 })
  .find((candidate) => candidate.taskId === rejectedMemoryTask.id);
assert.ok(rejectedCandidate);
await runtime.maintenance();
assert.equal(runtime.taskStore.getMemoryCandidate(rejectedCandidate.id)?.status, "rejected");
const leakedMemory = await runtime.memory.recall("EchoModelProvider", {
  scope: "memory-gate",
  limit: 10,
});
assert.equal([
  ...leakedMemory.files,
  ...leakedMemory.semantic,
].some((item) => item.content.includes("EchoModelProvider")), false);

await runtime.shutdown();

const plannerFailDataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-planner-fail-"));
const plannerFailRoleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-planner-fail-roles-"));
await mkdir(path.join(plannerFailRoleDir, "planner"), { recursive: true });
await writeFile(path.join(plannerFailRoleDir, "planner", "agent.md"), [
  "---",
  "name: \"planner\"",
  "role: \"Planner without read permission for failure test.\"",
  "allowed_tools:",
  "forbidden_tools:",
  "capabilities:",
  "  - planning",
  "---",
  "This role intentionally cannot read context.",
  "",
].join("\n"), "utf8");
const plannerFailRuntime = await createRuntime({
  dataDir: plannerFailDataDir,
  roleDir: plannerFailRoleDir,
});
const plannerFailResponse = await plannerFailRuntime.handleUserMessage("实现一个 planner 失败时不等待依赖任务的测试", {
  sessionId: "planner-fail",
  source: "test",
});
const blockedDeveloper = plannerFailResponse.subResults?.find((result) => result.role === "developer");
assert.equal(blockedDeveloper?.status, "blocked");
assert.ok(plannerFailResponse.subResults?.some((result) => result.role === "planner" && result.status !== "done"));
await plannerFailRuntime.shutdown();

console.log("core hardening test passed");
