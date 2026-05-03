import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { parseGraphPatchSpec, validateGraphPatchSpec } from "../src/planning/PlanSpec.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-planner-graph-"));
const runtime = await createRuntime({ dataDir });

const clarification = await runtime.handleUserMessage("我要做一个应用，支持用户注册登录", {
  sessionId: "planner-graph",
  source: "test",
});
assert.match(clarification.content, /准出标准/);
assert.deepEqual(clarification.delegatedTo, []);
assert.equal(runtime.taskStore.getRun(clarification.runId!)?.status, "waiting_user");

const response = await runtime.handleUserMessage("我要做一个应用，支持用户注册登录，先达到 POC，跑通核心链路即可", {
  sessionId: "planner-graph",
  source: "test",
});

assert.ok(response.plan);
assert.equal(response.plan.deliveryLevel, "poc");
assert.equal(response.plan.planningMode, "rolling");
assert.ok(response.plan.taskCount >= 2);
assert.ok(response.delegatedTo.includes("planner"));
assert.ok(response.delegatedTo.includes("developer"));
assert.ok(response.delegatedTo.includes("reviewer"));
assert.ok(response.subResults?.some((result) => result.role === "researcher"));
assert.ok(response.subResults?.some((result) => result.role === "developer" && result.status === "done"));
assert.equal(response.reviewerVerdict?.verdict, "pass");

const timeline = runtime.getTimeline({ runId: response.runId! });
const plannedTasks = timeline.tasks.filter((task) => typeof task.metadata.acceptanceCriteria !== "undefined");
assert.ok(plannedTasks.length >= 4);
assert.ok(plannedTasks.every((task) => Array.isArray(task.metadata.acceptanceCriteria)));
assert.ok(timeline.tasks.some((task) => task.metadata.planningMode === "rolling"));
assert.ok(timeline.tasks.some((task) => typeof task.metadata.expandedFromTaskId === "string"));
assert.ok(timeline.tasks.some((task) => task.metadata.planPhase === "graph_expansion" && task.status === "done"));
assert.ok(timeline.events.some((event) => event.type === "task_graph.expansion_planned"));
assert.ok(timeline.events.some((event) => event.type === "task_graph.expanded" && event.payload.source === "planner"));

const wrappedPatch = parseGraphPatchSpec(JSON.stringify({
  content: JSON.stringify({
    reason: "wrapped patch",
    parentKey: "architecture",
    stop: false,
    needsUserInput: false,
    questions: [],
    tasks: [{
      key: "api_slice",
      role: "developer",
      title: "api slice",
      input: "Implement the API slice.",
      dependsOn: ["architecture"],
      acceptanceCriteria: ["API slice is concrete."],
    }],
  }),
}), { parentKey: "architecture" });
assert.ok(wrappedPatch);
assert.equal(validateGraphPatchSpec(wrappedPatch, {
  parentKey: "architecture",
  existingKeys: new Set(["scope", "architecture"]),
}).ok, true);

await runtime.shutdown();

console.log("planner graph test passed");
