import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { parseTaskResult } from "../src/tasks/TaskResult.ts";

const repoRoot = process.cwd();
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-coding-workspace-"));
const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-coding-data-"));

process.chdir(workspaceDir);
let runtime: Awaited<ReturnType<typeof createRuntime>> | null = null;

try {
  runtime = await createRuntime({
    dataDir,
    roleDir: path.join(repoRoot, "agents"),
    skillDir: path.join(repoRoot, "skills"),
  });
  const task = runtime.taskStore.createTask({
    role: "developer",
    title: "coding tool request",
    input: "EMIT_WRITE_FILE_TOOL_REQUEST 创建文件并保存结果。",
    metadata: {
      sessionId: "coding-tool-request",
      maxMemoryCandidates: 0,
      skillHints: ["coding"],
      toolHints: ["write_file"],
    },
  });

  const finished = await runtime.roleAgentManager.runTask(task, {
    timeoutMs: 10000,
  });
  const result = parseTaskResult(finished.result);
  const written = await readFile(path.join(workspaceDir, "generated", "coding-tool-request.txt"), "utf8");
  const trace = runtime.getTaskTrace(task.id);

  assert.equal(finished.status, "done");
  assert.equal(result?.status, "success");
  assert.equal(written, "written by echo developer tool request\n");
  assert.ok(trace.events.some((event) => event.type === "tool.execution.completed"
    && event.payload.tool === "write_file"
    && event.payload.ok === true));

  const inheritedGoalTask = runtime.taskStore.createTask({
    role: "developer",
    title: "设计游戏数据结构和架构",
    input: "设计游戏数据结构和架构。",
    metadata: {
      sessionId: "coding-tool-request",
      maxMemoryCandidates: 0,
      planGoal: "写一个web的贪吃蛇游戏，结果保存到 ~/2_project/demo。",
      skillHints: ["coding"],
      toolHints: ["write_file"],
    },
  });
  const inheritedGoalFinished = await runtime.roleAgentManager.runTask(inheritedGoalTask, {
    timeoutMs: 10000,
  });
  assert.equal(inheritedGoalFinished.status, "done");

  const codeFenceTask = runtime.taskStore.createTask({
    role: "developer",
    title: "materialize html",
    input: "EMIT_HTML_CODE_FENCE 生成 HTML 文件并保存到 ./web-demo。",
    metadata: {
      sessionId: "coding-tool-request",
      maxMemoryCandidates: 0,
      skillHints: ["coding"],
      toolHints: ["write_file"],
    },
  });
  const codeFenceFinished = await runtime.roleAgentManager.runTask(codeFenceTask, {
    timeoutMs: 10000,
  });
  const html = await readFile(path.join(workspaceDir, "web-demo", "index.html"), "utf8");
  assert.equal(codeFenceFinished.status, "done");
  assert.match(html, /snakeReady/);

  const noWriteTask = runtime.taskStore.createTask({
    role: "developer",
    title: "coding missing write request",
    input: "创建一个文件并保存结果，但模型没有发出工具请求。",
    metadata: {
      sessionId: "coding-tool-request",
      maxMemoryCandidates: 0,
      skillHints: ["coding"],
      toolHints: ["write_file"],
    },
  });
  const noWriteFinished = await runtime.roleAgentManager.runTask(noWriteTask, {
    timeoutMs: 10000,
  });
  assert.equal(noWriteFinished.status, "failed");
  assert.match(String(noWriteFinished.error || ""), /no executable write_file toolRequests/);
} finally {
  await runtime?.shutdown();
  process.chdir(repoRoot);
}

console.log("coding tool request test passed");
