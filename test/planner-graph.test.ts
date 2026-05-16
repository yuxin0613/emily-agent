import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import {
  assessTaskComplexity,
  parseGraphPatchSpec,
  requiresDeliveryLevelClarification,
  validateGraphPatchSpec,
} from "../src/planning/PlanSpec.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-planner-graph-"));
const previousPrivateEgress = process.env.EMILY_HTTP_ALLOW_PRIVATE;
const previousSearchProvider = process.env.EMILY_WEB_SEARCH_PROVIDER;
const previousSearchEndpoint = process.env.EMILY_WEB_SEARCH_ENDPOINT;
process.env.EMILY_HTTP_ALLOW_PRIVATE = "true";
const runtime = await createRuntime({ dataDir });

const projectComparison = "查找项目 llm_wiki和obsidian做一下比较，看看两者功能有什么不同";
const comparisonAssessment = assessTaskComplexity(projectComparison);
assert.equal(comparisonAssessment.kind, "research_comparison");
assert.equal(comparisonAssessment.longTask, true);
assert.equal(comparisonAssessment.splittable, true);
assert.equal(requiresDeliveryLevelClarification(projectComparison), false);
assert.equal(requiresDeliveryLevelClarification("我要做一个应用，支持用户注册登录"), true);

const clarification = await runtime.handleUserMessage("我要做一个应用，支持用户注册登录", {
  sessionId: "planner-graph",
  source: "test",
});
assert.match(clarification.content, /准出标准/);
assert.deepEqual(clarification.delegatedTo, []);
assert.equal(runtime.taskStore.getRun(clarification.runId!)?.status, "waiting_user");

const comparisonResponse = await runtime.handleUserMessage(projectComparison, {
  sessionId: "planner-comparison",
  source: "test",
});
assert.ok(comparisonResponse.plan);
assert.equal(runtime.taskStore.getRun(comparisonResponse.runId!)?.status, "done");
assert.ok(comparisonResponse.delegatedTo.includes("researcher"));
assert.ok(!comparisonResponse.delegatedTo.includes("developer"));
assert.doesNotMatch(comparisonResponse.content, /请确认目标等级/);

await runtime.updateSettings({ toolCallTimeoutSeconds: 7 });
const webServer = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<html><head><title>Obsidian Features</title></head><body><h1>Obsidian</h1><p>Markdown notes, backlinks, graph view, canvas, plugins, sync.</p></body></html>");
});
await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
try {
  const address = webServer.address() as AddressInfo;
  const localUrl = `http://127.0.0.1:${address.port}/features`;
  const webComparison = await runtime.handleUserMessage(`NEEDS_WEB_PLAN_CLARIFICATION 比较 ${localUrl} 和 /Users/yuxin/0_code/llm_wiki 的功能差异`, {
    sessionId: "planner-web-comparison",
    source: "test",
  });
  assert.equal(runtime.taskStore.getRun(webComparison.runId!)?.status, "done");
  assert.ok(webComparison.delegatedTo.includes("researcher"));
  assert.ok(!webComparison.needsUserInput);
  const webTimeline = runtime.getTimeline({ runId: webComparison.runId! });
  assert.ok(webTimeline.events.some((event) => event.type === "runtime.anomaly"
    && event.payload.code === "planner_clarification_overridden"));
  assert.ok(webTimeline.events.some((event) => event.type === "tool.execution.completed"
    && event.payload.tool === "http_fetch"));
  assert.equal(webTimeline.events.find((event) => event.type === "tool.execution.started"
    && event.payload.tool === "http_fetch")?.payload.timeoutMs, 7000);
} finally {
  await new Promise<void>((resolve, reject) => webServer.close((error) => error ? reject(error) : resolve()));
}

const searchServer = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    results: [{
      title: "NVIDIA model news",
      url: "https://example.com/nvidia-model-news",
      content: "NVIDIA announced a new model update.",
    }],
  }));
});
await new Promise<void>((resolve) => searchServer.listen(0, "127.0.0.1", resolve));
try {
  const address = searchServer.address() as AddressInfo;
  process.env.EMILY_WEB_SEARCH_PROVIDER = "endpoint";
  process.env.EMILY_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${address.port}/search`;
  const explicitSearch = await runtime.handleUserMessage("NEEDS_WEB_PLAN_CLARIFICATION 搜索nvidia最新大模型的新闻", {
    sessionId: "planner-explicit-web-search",
    source: "test",
  });
  assert.equal(runtime.taskStore.getRun(explicitSearch.runId!)?.status, "done");
  assert.ok(!explicitSearch.needsUserInput);
  assert.ok(explicitSearch.delegatedTo.includes("researcher"));
  const searchTimeline = runtime.getTimeline({ runId: explicitSearch.runId! });
  assert.ok(searchTimeline.events.some((event) => event.type === "runtime.anomaly"
    && event.payload.code === "planner_clarification_overridden"));
  assert.ok(searchTimeline.events.some((event) => event.type === "tool.execution.completed"
    && event.payload.tool === "web_search"
    && event.payload.ok === true));
} finally {
  await new Promise<void>((resolve, reject) => searchServer.close((error) => error ? reject(error) : resolve()));
  if (previousSearchProvider === undefined) delete process.env.EMILY_WEB_SEARCH_PROVIDER;
  else process.env.EMILY_WEB_SEARCH_PROVIDER = previousSearchProvider;
  if (previousSearchEndpoint === undefined) delete process.env.EMILY_WEB_SEARCH_ENDPOINT;
  else process.env.EMILY_WEB_SEARCH_ENDPOINT = previousSearchEndpoint;
}

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
const implementationTask = timeline.tasks.find((task) => task.metadata.graphKey === "implementation");
const verificationTask = timeline.tasks.find((task) => task.metadata.graphKey === "verification");
assert.ok(implementationTask);
assert.ok(verificationTask);
assert.equal(implementationTask.metadata.parentKey, "architecture");
assert.equal(verificationTask.metadata.parentKey, "implementation");
assert.ok(timeline.events.some((event) => event.type === "task.dependency.created"
  && event.taskId === verificationTask.id
  && event.payload.dependsOnTaskId === implementationTask.id));

const planOnly = await runtime.handleUserMessage("帮我规划一个 Todo 应用 POC，不要立即实现", {
  sessionId: "planner-plan-only",
  source: "test",
});
assert.ok(planOnly.plan);
assert.equal(planOnly.plan.deliveryLevel, "poc");
assert.equal(runtime.taskStore.getRun(planOnly.runId!)?.status, "done");
assert.deepEqual(planOnly.delegatedTo, ["planner"]);
assert.match(planOnly.content, /暂不执行实现任务/);
assert.match(planOnly.content, /\/dag /);
assert.equal(planOnly.subResults?.length, 1);
assert.equal(planOnly.subResults?.[0]?.role, "planner");
const planOnlyTimeline = runtime.getTimeline({ runId: planOnly.runId! });
const planOnlyTasks = planOnlyTimeline.tasks.filter((task) => task.metadata.planOnly === true);
assert.ok(planOnlyTasks.length >= 10);
assert.ok(planOnlyTasks.every((task) => task.status === "pending"));
assert.ok(planOnlyTasks.every((task) => typeof task.metadata.planSourceTaskId === "string"));
assert.ok(planOnlyTimeline.tasks.some((task) => task.metadata.planPhase === "planning" && task.status === "done"));
assert.ok(planOnlyTasks.some((task) => task.metadata.graphKey === "requirements_scope"));
assert.ok(planOnlyTasks.some((task) => task.metadata.graphKey === "data_model"));
assert.ok(planOnlyTasks.some((task) => task.metadata.graphKey === "cli_commands"));
assert.ok(planOnlyTasks.some((task) => task.metadata.graphKey === "persistence"));
assert.ok(planOnlyTasks.some((task) => task.metadata.graphKey === "validation"));
assert.ok(!planOnly.subResults?.some((result) => result.role === "developer" || result.role === "reviewer"));

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
      metadata: {
        component: "api",
        toolRequests: [{ tool: "http_fetch", approval: { approved: true, template: "network_read" } }],
      },
    }],
  }),
}), { parentKey: "architecture" });
assert.ok(wrappedPatch);
assert.equal(wrappedPatch.tasks[0].metadata?.component, "api");
assert.equal(wrappedPatch.tasks[0].metadata?.toolRequests, undefined);
assert.equal(validateGraphPatchSpec(wrappedPatch, {
  parentKey: "architecture",
  existingKeys: new Set(["scope", "architecture"]),
}).ok, true);

const invalidParentPatch = parseGraphPatchSpec(JSON.stringify({
  reason: "invalid parent",
  parentKey: "architecture",
  stop: false,
  needsUserInput: false,
  questions: [],
  tasks: [{
    key: "orphan_slice",
    role: "developer",
    title: "orphan slice",
    input: "This task points at a missing decomposition parent.",
    parentKey: "missing_module",
    dependsOn: ["architecture"],
    acceptanceCriteria: ["The hierarchy is rejected."],
  }],
}), { parentKey: "architecture" });
assert.ok(invalidParentPatch);
assert.equal(validateGraphPatchSpec(invalidParentPatch, {
  parentKey: "architecture",
  existingKeys: new Set(["scope", "architecture"]),
}).ok, false);

const planPause = await runtime.handleUserMessage("NEEDS_PLAN_CLARIFICATION POC", {
  sessionId: "planner-plan-pause",
  source: "test",
});
assert.equal(runtime.taskStore.getRun(planPause.runId!)?.status, "waiting_user");
assert.match(planPause.content, /请补充验收范围/);
assert.equal(planPause.needsUserInput?.questions[0], "请补充验收范围和必须覆盖的核心场景。");
assert.deepEqual(planPause.delegatedTo, ["planner"]);
assert.equal(planPause.subResults?.length, 1);

const graphPause = await runtime.handleUserMessage("我要做一个应用 NEEDS_GRAPH_INPUT，先达到 POC", {
  sessionId: "planner-graph-pause",
  source: "test",
});
assert.equal(runtime.taskStore.getRun(graphPause.runId!)?.status, "waiting_user");
assert.match(graphPause.content, /请补充任务图继续拆解前必须确认的业务边界/);
assert.equal(graphPause.needsUserInput?.questions[0], "请补充任务图继续拆解前必须确认的业务边界。");
const graphPauseTimeline = runtime.getTimeline({ runId: graphPause.runId! });
assert.ok(graphPauseTimeline.events.some((event) => event.type === "task_graph.waiting_user"));
assert.ok(!graphPause.subResults?.some((result) => result.role === "developer" && result.status === "done"));

const fallbackResponse = await runtime.handleUserMessage("我要做一个应用 FAIL_GRAPH_PATCH，先达到 POC", {
  sessionId: "planner-fallback",
  source: "test",
});
assert.equal(runtime.taskStore.getRun(fallbackResponse.runId!)?.status, "done");
const fallbackTimeline = runtime.getTimeline({ runId: fallbackResponse.runId! });
const fallbackExpanded = fallbackTimeline.events.find((event) => event.type === "task_graph.expanded" && event.payload.source === "fallback");
assert.ok(fallbackExpanded);
assert.equal(runtime.taskStore.getTaskGraph(String(fallbackExpanded.payload.graphId))?.status, "done");
const failedExpansionPlanner = fallbackTimeline.tasks.find((task) => task.metadata.planPhase === "graph_expansion" && task.status !== "done");
assert.ok(failedExpansionPlanner);
assert.notEqual(failedExpansionPlanner.metadata.graphId, fallbackExpanded.payload.graphId);

await runtime.shutdown();
if (previousPrivateEgress === undefined) delete process.env.EMILY_HTTP_ALLOW_PRIVATE;
else process.env.EMILY_HTTP_ALLOW_PRIVATE = previousPrivateEgress;
if (previousSearchProvider === undefined) delete process.env.EMILY_WEB_SEARCH_PROVIDER;
else process.env.EMILY_WEB_SEARCH_PROVIDER = previousSearchProvider;
if (previousSearchEndpoint === undefined) delete process.env.EMILY_WEB_SEARCH_ENDPOINT;
else process.env.EMILY_WEB_SEARCH_ENDPOINT = previousSearchEndpoint;

console.log("planner graph test passed");
