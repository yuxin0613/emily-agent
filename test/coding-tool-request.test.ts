import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { artifactRequirementForInput, ensureArtifactMaterializationPlan } from "../src/planning/ArtifactMaterialization.ts";
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
      requiredFiles: ["generated/coding-tool-request.txt"],
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

  const materialized = ensureArtifactMaterializationPlan({
    goal: "Build FocusForge",
    deliveryLevel: "uat",
    exitCriteria: ["Artifacts are runnable."],
    planningMode: "single_wave",
    maxWaves: 1,
    failureStrategy: "block_dependents",
    tasks: [{
      key: "implementation",
      role: "developer",
      title: "implementation",
      input: "Implement the app.",
      parentKey: "",
      dependsOn: [],
      dependencyType: "success",
      acceptanceCriteria: ["Implementation exists."],
      toolHints: ["write_file"],
      skillHints: ["coding"],
      timeoutMs: 30000,
      maxRetries: 1,
      maxResultChars: 12000,
      maxMemoryCandidates: 1,
      wave: 1,
      expandable: false,
      expansionGoal: "",
      maxExpansionDepth: 0,
    }, {
      key: "validation",
      role: "reviewer",
      title: "validation",
      input: "Review the app.",
      parentKey: "implementation",
      dependsOn: ["implementation"],
      dependencyType: "finished",
      acceptanceCriteria: ["Artifacts are reviewed."],
      toolHints: [],
      skillHints: ["review"],
      timeoutMs: 30000,
      maxRetries: 1,
      maxResultChars: 12000,
      maxMemoryCandidates: 1,
      wave: 2,
      expandable: false,
      expansionGoal: "",
      maxExpansionDepth: 0,
    }],
    review: { required: true, criteria: ["Artifacts are runnable."] },
    clarificationRequired: false,
    clarificationQuestions: [],
  }, "生成纯前端 Web 应用，保存到 ~/2_project/focusforge_demo。目录中至少包含 index.html、styles.css、app.js、README.md。");
  const finalTask = materialized.tasks.find((item) => item.key === "final_materialization");
  assert.ok(finalTask);
  assert.equal(finalTask.role, "developer");
  assert.deepEqual(finalTask.metadata?.requiredFiles, [
    "~/2_project/focusforge_demo/index.html",
    "~/2_project/focusforge_demo/styles.css",
    "~/2_project/focusforge_demo/app.js",
    "~/2_project/focusforge_demo/README.md",
  ]);
  assert.ok(finalTask.dependsOn.includes("implementation"));
  assert.ok(materialized.tasks.find((item) => item.key === "validation")?.dependsOn.includes("final_materialization"));
  assert.deepEqual(artifactRequirementForInput("写一个 HTML 页面保存到 ./demo")?.requiredFiles, [
    "./demo/index.html",
    "./demo/styles.css",
    "./demo/app.js",
    "./demo/README.md",
  ]);

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

  const missingRequiredTask = runtime.taskStore.createTask({
    role: "developer",
    title: "coding partial materialization",
    input: "EMIT_WRITE_FILE_TOOL_REQUEST 创建两个文件并保存结果。",
    metadata: {
      sessionId: "coding-tool-request",
      maxMemoryCandidates: 0,
      skillHints: ["coding"],
      toolHints: ["write_file"],
      requiredFiles: ["generated/coding-tool-request.txt", "generated/missing-required.txt"],
    },
  });
  const missingRequiredFinished = await runtime.roleAgentManager.runTask(missingRequiredTask, {
    timeoutMs: 10000,
  });
  assert.equal(missingRequiredFinished.status, "failed");
  assert.match(String(missingRequiredFinished.error || ""), /Missing successful write_file execution/);

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
