import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { webAppHtml } from "../src/adapters/webUi.ts";
import { createPromptInputDecoder, flattenDagEditorNodes, formatDagEditorView, formatProgressEvent, formatPromptBufferPreviewLines, formatThinkingFrame, formatTranscriptMessage, formatTuiCommandHints, formatTuiHelp, formatTuiHome, formatTuiSubmittedInput, isTuiAbortError, mergeContextQueueToIndex } from "../src/adapters/tui.ts";

const execFileAsync = promisify(execFile);

function stripAnsi(value: string): string {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) width += charDisplayWidth(char);
  return width;
}

function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) || 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (isWideCodePoint(code)) return 2;
  return 1;
}

function isWideCodePoint(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff);
}

function framedLineWidths(value: string): number[] {
  return stripAnsi(value)
    .split("\n")
    .filter((line) => line.startsWith("┌")
      || line.startsWith("└")
      || line.startsWith("│")
      || /^─+$/.test(line)
      || /^─+ Emily AgentOS terminal workspace ─+$/.test(line))
    .map(visibleLength);
}

const html = webAppHtml();

assert.match(html, /Emily AgentOS/);
assert.match(html, /id="nav"/);
assert.match(html, /id="content"/);
assert.match(html, /Sessions/);
assert.match(html, /Monitor/);
assert.match(html, /Settings/);
assert.match(html, /\/sessions\/clear/);
assert.match(html, /\/sessions\/messages/);
assert.match(html, /\/sessions\/restore/);
assert.match(html, /\/skill-candidates\/build/);
assert.match(html, /\/settings/);
assert.match(html, /\/subagents/);
assert.match(html, /\/cron/);
assert.match(html, /\/chat/);
assert.ok(!html.includes("${undefined}"));

const tuiHelp = formatTuiHelp();
assert.match(tuiHelp, /\/mode \[mode\]/);
assert.match(tuiHelp, /\/status/);
assert.match(tuiHelp, /\/sub/);
assert.match(tuiHelp, /\/timeline \[runId\]/);
assert.match(tuiHelp, /\/graph \[runId\]/);
assert.match(tuiHelp, /\/dag list/);
assert.match(tuiHelp, /\/dag <root_id>/);
assert.match(tuiHelp, /\/node <key> \[runId\]/);
assert.match(tuiHelp, /\/help all/);
assert.match(tuiHelp, /\/queue/);
assert.doesNotMatch(tuiHelp, /:status/);
assert.doesNotMatch(tuiHelp, /\/cron-pause/);
assert.ok(!tuiHelp.includes("undefined"));
const allTuiHelp = formatTuiHelp("all");
assert.match(allTuiHelp, /Most commands require/);
assert.match(allTuiHelp, /\/cron-pause <id>/);
assert.match(allTuiHelp, /\/cron-resume <id>/);
assert.match(allTuiHelp, /\/cron-run <id>/);
assert.match(allTuiHelp, /\/cron-delete <id>/);
assert.match(allTuiHelp, /\/graph-add <parent> <key> <role> <title>/);
assert.match(allTuiHelp, /\/graph-update <key> <field> <value>/);
assert.match(allTuiHelp, /:add_before <text>/);
assert.match(allTuiHelp, /:add_after <text>/);
assert.match(allTuiHelp, /:update <text>/);
assert.match(allTuiHelp, /:del/);
assert.doesNotMatch(allTuiHelp, /cron-pause\|resume/);
assert.doesNotMatch(allTuiHelp, /:cron-pause/);
const slashHints = formatTuiCommandHints("/");
assert.match(slashHints, /Command hints/);
assert.match(slashHints, /\/help/);
assert.match(slashHints, /\/new \[title\]/);
assert.match(slashHints, /\/status/);
assert.doesNotMatch(slashHints, /\/cron-pause/);
assert.ok(!slashHints.includes("undefined"));
const filteredHints = formatTuiCommandHints("/", "sta");
assert.match(filteredHints, /Command hints for \/sta/);
assert.match(filteredHints, /\/status/);
assert.doesNotMatch(filteredHints, /\/new \[title\]/);
const filteredAdvancedHints = formatTuiCommandHints(":", "cron-r");
assert.match(filteredAdvancedHints, /:cron-resume <id>/);
assert.match(filteredAdvancedHints, /:cron-run <id>/);
const originalColumns = process.stdout.columns;
process.stdout.columns = 180;
const tuiHome = formatTuiHome({
  provider: { id: "deepseek", model: "deepseek-chat", type: "openai" },
  tools: [{ name: "read_file", category: "filesystem" }, { name: "shell", category: "process" }],
  skills: [{ name: "coding", capabilities: ["software-development"], source: "builtin" }],
  runLog: [
    "[12:00:00] developer running · subagent dev-1 · task abc123 - build",
    "[12:00:01] developer tool completed · shell · subagent dev-1 · task abc123",
    "[12:00:02] planner failed · subagent planner-1 · task fail123 - planner | 原因: Task fail123 timed out after 120000ms",
  ],
  transcript: [
    { role: "user", content: "测试消息" },
    { role: "assistant", content: "收到，测试成功。" },
    { role: "system", content: "run abc · elapsed 2s" },
  ],
  contextQueue: [
    { id: "ctx-1", content: "第一条新 context", recorded: true },
    { id: "ctx-2", content: "第二条新 context", recorded: true },
    { id: "ctx-3", content: "第三条新 context", recorded: true },
  ],
});
process.stdout.columns = originalColumns;
assert.match(tuiHome, /Emily AgentOS/);
assert.match(tuiHome, /Available Tools:/);
assert.match(tuiHome, /Available Skills:/);
assert.match(tuiHome, /Run Log:/);
assert.match(tuiHome, /subagent dev-1/);
assert.match(tuiHome, /tool completed/);
assert.match(tuiHome, /planner failed/);
assert.match(tuiHome, /timed out after 120000ms/);
assert.match(tuiHome, /deepseek-chat/);
assert.match(tuiHome, /Session: tui/);
assert.match(tuiHome, /Welcome to Emily Agent! Type your message or \/help for commands\./);
assert.match(tuiHome, /You/);
assert.match(tuiHome, /测试消息/);
assert.match(tuiHome, /Emily/);
assert.match(tuiHome, /收到，测试成功。/);
assert.match(tuiHome, /run abc/);
assert.match(tuiHome, /Context Queue/);
assert.match(tuiHome, /第一条新 context/);
assert.match(tuiHome, /merge: \/queue merge 2/);
assert.ok(!tuiHome.includes("undefined"));
const tuiHomeFrameWidths = framedLineWidths(tuiHome);
assert.ok(tuiHomeFrameWidths.length > 20);
assert.deepEqual([...new Set(tuiHomeFrameWidths)], [178]);
process.stdout.columns = 160;
const activeNow = Date.now();
const activeTaskHome = formatTuiHome({
  state: {
    sessionId: "active-session",
    lastRunId: "run_active",
    permissionMode: "workspace_write",
    activeTasks: {
      "task-running": {
        id: "task-running",
        role: "developer",
        status: "running",
        title: "Implement run log active task summary",
        assignedAgentId: "developer-12345",
        queuedAtMs: activeNow - 185000,
        runningAtMs: activeNow - 125000,
        updatedAtMs: activeNow - 5000,
      },
      "task-queued": {
        id: "task-queued",
        role: "reviewer",
        status: "queued",
        title: "Verify active task display",
        assignedAgentId: "reviewer-67890",
        queuedAtMs: activeNow - 65000,
        updatedAtMs: activeNow - 4000,
      },
    },
  },
  runLog: ["[12:00:00] developer running · subagent developer-12345 · task task-run - Implement run log active task summary"],
});
process.stdout.columns = originalColumns;
assert.match(activeTaskHome, /Active: 2 tasks/);
assert.match(activeTaskHome, /1 running/);
assert.match(activeTaskHome, /1 queued/);
assert.match(activeTaskHome, /developer/);
assert.match(activeTaskHome, /reviewer/);
assert.match(activeTaskHome, /Implement run log active task summary/);
process.stdout.columns = 60;
const narrowTuiHome = formatTuiHome({ transcript: [{ role: "assistant", content: "narrow frame" }] });
process.stdout.columns = originalColumns;
assert.deepEqual([...new Set(framedLineWidths(narrowTuiHome))], [88]);
const mergedQueue = mergeContextQueueToIndex([
  { id: "ctx-1", content: "第一条", recorded: true },
  { id: "ctx-2", content: "第二条", recorded: true },
  { id: "ctx-3", content: "第三条", recorded: true },
], 2);
assert.equal(mergedQueue.ok, true);
assert.equal(mergedQueue.queue.length, 2);
assert.match(mergedQueue.queue[0].content, /Context 1:\n第一条/);
assert.match(mergedQueue.queue[0].content, /Context 2:\n第二条/);
assert.equal(mergedQueue.queue[1].content, "第三条");
assert.equal(mergeContextQueueToIndex([{ content: "one" }], 1).ok, false);
const idleTuiHome = formatTuiHome();
assert.match(idleTuiHome, /Run Log:/);
assert.match(idleTuiHome, /waiting for activity/);
assert.match(idleTuiHome, /subagent\/task\/tool events appear here/);
const failedProgress = formatProgressEvent("task.failed", {
  id: "31e64bd2-f90d-4f9f-80ec-fb7891bf41d4",
  role: "planner",
  title: "planner: Todo POC",
  assignedAgentId: "planner-73447",
  error: "Error: Task 31e64bd2 timed out after 120000ms\n    at Timeout",
  metadata: {},
}, { payload: { reason: "worker failed" } });
assert.match(failedProgress, /planner failed/);
assert.match(failedProgress, /subagent planner-73447/);
assert.match(failedProgress, /原因: Error: Task 31e64bd2 timed out after 120000ms/);
process.stdout.columns = 180;
const dynamicStatusHome = formatTuiHome({
  state: { sessionId: "review-session", lastRunId: "run_dynamic", permissionMode: "read_only" },
  provider: { id: "main-qwen", model: "qwen3-coder", type: "openai" },
  health: { pendingTasks: 3, runningTasks: 2, openTaskGraphs: 5 },
});
process.stdout.columns = originalColumns;
assert.match(dynamicStatusHome, /qwen3-coder/);
assert.match(dynamicStatusHome, /main-qwen/);
assert.match(dynamicStatusHome, /Session: review-session/);
assert.match(dynamicStatusHome, /Tasks: 3\/2  Graphs: 5/);
assert.doesNotMatch(dynamicStatusHome, /deepseek-v4-flash/);
assert.doesNotMatch(dynamicStatusHome, /Session: tui   \|   Tasks: 0\/0  Graphs: 0/);
const submitted = formatTuiSubmittedInput("what can you do for me?", 80);
assert.match(submitted, /❯ what can you do for me\?/);
assert.doesNotMatch(submitted, /─/);
assert.doesNotMatch(submitted, /Initializing agent\.\.\./);
assert.ok(!submitted.includes("undefined"));
const promptPreview = formatPromptBufferPreviewLines("帮我规划一个 Todo 应用 POC，先拆成 DAG：需求范围、数据模型、CLI 命令、持久化、验证\n/dag list", 32);
assert.ok(promptPreview.length > 1);
assert.equal(promptPreview.at(-1), "/dag list");
assert.ok(promptPreview.every((line) => !line.includes("...")));

let promptBuffer = "";
let promptCursor = 0;
let submittedPrompt = "";
const promptDecoder = createPromptInputDecoder({
  appendText(text) {
    const chars = [...promptBuffer];
    promptBuffer = [...chars.slice(0, promptCursor), text, ...chars.slice(promptCursor)].join("");
    promptCursor += [...text].length;
  },
  backspace() {
    if (promptCursor <= 0) return;
    const chars = [...promptBuffer];
    promptBuffer = [...chars.slice(0, promptCursor - 1), ...chars.slice(promptCursor)].join("");
    promptCursor -= 1;
  },
  deleteForward() {
    const chars = [...promptBuffer];
    promptBuffer = [...chars.slice(0, promptCursor), ...chars.slice(promptCursor + 1)].join("");
  },
  moveCursor(delta) {
    promptCursor = Math.max(0, Math.min([...promptBuffer].length, promptCursor + delta));
  },
  moveToStart() {
    promptCursor = 0;
  },
  moveToEnd() {
    promptCursor = [...promptBuffer].length;
  },
  submit() {
    submittedPrompt = promptBuffer;
  },
  abort() {
    submittedPrompt = "(aborted)";
  },
  isClosed() {
    return false;
  },
});
promptDecoder(Buffer.from("abc"));
promptDecoder(Buffer.from("\x1b[D"));
promptDecoder(Buffer.from("X"));
assert.equal(promptBuffer, "abXc");
assert.equal(promptCursor, 3);
promptDecoder(Buffer.from("\x1b[D"));
promptDecoder(Buffer.from("\x7f"));
assert.equal(promptBuffer, "aXc");
assert.equal(promptCursor, 1);
promptDecoder(Buffer.from("\x1b[C"));
promptDecoder(Buffer.from("\x1b[3~"));
assert.equal(promptBuffer, "aX");
promptDecoder(Buffer.from("\x1b[H"));
promptDecoder(Buffer.from("!"));
promptDecoder(Buffer.from("\x1b[F"));
promptDecoder(Buffer.from("?"));
promptDecoder(Buffer.from("\r"));
assert.equal(submittedPrompt, "!aX?");

const assistant = formatTranscriptMessage("assistant", "hello from emily", 80);
assert.match(assistant, /┊ hello from emily/);
assert.match(formatThinkingFrame(3), /thinking\.\.\./);
assert.equal(isTuiAbortError(Object.assign(new Error("Aborted with Ctrl+C"), {
  name: "AbortError",
  code: "ABORT_ERR",
})), true);
assert.equal(isTuiAbortError(new Error("regular failure")), false);

const dagMap = {
  runId: "run_dag",
  goal: "Build a DAG editor",
  roots: ["scope"],
  nodes: [
    { key: "scope", id: "task_scope", role: "researcher", status: "done", title: "Scope", input: "scope", editable: false, children: ["implementation"] },
    { key: "implementation", id: "task_impl", role: "developer", status: "pending", title: "Implement", input: "implement", editable: true, children: [] },
  ],
};
const dagRows = flattenDagEditorNodes(dagMap);
assert.equal(dagRows.length, 2);
assert.equal(dagRows[1].depth, 1);
const dagView = formatDagEditorView(dagMap, 1, "ready", 100);
assert.match(dagView, /DAG run_dag/);
assert.match(dagView, />  2/);
assert.match(dagView, /:add_before\/:add_after\/:update\/:del/);
assert.match(dagView, /已完成/);
assert.match(dagView, /未开始/);
assert.match(dagView, /ready/);

const cliHelp = await execFileAsync(process.execPath, ["src/index.ts", "--help"], {
  cwd: process.cwd(),
  timeout: 5000,
});
assert.match(cliHelp.stdout, /Emily AgentOS/);
assert.match(cliHelp.stdout, /emily --web/);
assert.equal(cliHelp.stderr, "");

console.log("ui test passed");
