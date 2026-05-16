import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { classifyUserMessageIntent, isPlanningOnlyRequest } from "../src/agents/MainAgent.ts";
import { assessTaskComplexity, requiresDeliveryLevelClarification } from "../src/planning/PlanSpec.ts";
import { AgentRouter } from "../src/routing/AgentRouter.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-chat-routing-"));
const runtime = await createRuntime({ dataDir });

try {
  assert.equal(classifyUserMessageIntent("测试消息"), "chat");
  assert.equal(classifyUserMessageIntent("你好"), "chat");
  assert.equal(classifyUserMessageIntent("帮我测试这个接口"), "task");
  assert.equal(classifyUserMessageIntent("帮我规划一个 Todo 应用，不要立即实现"), "task");
  assert.equal(classifyUserMessageIntent("搜索nvidia的新闻"), "task");
  assert.equal(assessTaskComplexity("搜索nvidia的新闻").kind, "research");
  const searchRoute = new AgentRouter().route("搜索nvidia的新闻");
  assert.ok(searchRoute.selectedRoles.includes("researcher"));
  assert.equal(isPlanningOnlyRequest("帮我规划一个 Todo 应用 POC，不要立即实现"), true);
  assert.equal(isPlanningOnlyRequest("帮我做一个 Todo 应用 POC"), false);
  assert.equal(classifyUserMessageIntent("查找项目 llm_wiki和obsidian做一下比较，看看两者功能有什么不同"), "task");
  assert.equal(assessTaskComplexity("查找项目 llm_wiki和obsidian做一下比较，看看两者功能有什么不同").kind, "research_comparison");
  assert.equal(requiresDeliveryLevelClarification("查找项目 llm_wiki和obsidian做一下比较，看看两者功能有什么不同"), false);

  const response = await runtime.handleUserMessage("测试消息", {
    sessionId: "chat-routing",
    source: "test",
  });

  assert.equal(response.agent, "emily");
  assert.deepEqual(response.delegatedTo, []);
  assert.equal(response.plan, undefined);
  assert.equal(response.needsUserInput, undefined);
  assert.match(response.content, /普通对话消息/);
  assert.ok(response.runId);

  const timeline = runtime.getTimeline({ runId: response.runId });
  assert.equal(timeline.run?.status, "done");
  assert.equal(timeline.tasks.length, 0);
  assert.ok(!timeline.events.some((event) => event.type.startsWith("task.")));

  const modelResponse = await runtime.handleUserMessage("现在使用的是哪个模型", {
    sessionId: "chat-routing",
    source: "test",
  });
  assert.match(modelResponse.content, /当前主模型是 echo-local/);
  assert.match(modelResponse.content, /Provider: echo/);
  assert.deepEqual(modelResponse.delegatedTo, []);
  assert.equal(modelResponse.needsUserInput, undefined);
} finally {
  await runtime.shutdown();
}

console.log("chat routing test passed");
