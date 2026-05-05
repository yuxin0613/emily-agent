import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { webAppHtml } from "../src/adapters/webUi.ts";
import { flattenDagEditorNodes, formatDagEditorView, formatThinkingFrame, formatTranscriptMessage, formatTuiCommandHints, formatTuiHelp, formatTuiHome, formatTuiSubmittedInput, isTuiAbortError } from "../src/adapters/tui.ts";

const execFileAsync = promisify(execFile);

const html = webAppHtml();

assert.match(html, /Emily AgentOS/);
assert.match(html, /id="nav"/);
assert.match(html, /id="content"/);
assert.match(html, /Sessions/);
assert.match(html, /\/sessions\/clear/);
assert.match(html, /\/sessions\/messages/);
assert.match(html, /\/sessions\/restore/);
assert.match(html, /\/skill-candidates\/build/);
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
const tuiHome = formatTuiHome({
  provider: { id: "deepseek", model: "deepseek-chat", type: "openai" },
  tools: [{ name: "read_file", category: "filesystem" }, { name: "shell", category: "process" }],
  skills: [{ name: "coding", capabilities: ["software-development"], source: "builtin" }],
  runLog: [
    "[12:00:00] developer running · subagent developer-1 · task abc123 - build",
    "[12:00:01] developer tool completed · shell · subagent developer-1 · task abc123",
  ],
});
assert.match(tuiHome, /Emily AgentOS/);
assert.match(tuiHome, /Available Tools/);
assert.match(tuiHome, /Available Skills/);
assert.match(tuiHome, /Run Log/);
assert.match(tuiHome, /subagent developer-1/);
assert.match(tuiHome, /tool completed/);
assert.match(tuiHome, /deepseek-chat/);
assert.match(tuiHome, /Welcome to Emily Agent! Type your message or \/help for commands\./);
assert.ok(!tuiHome.includes("undefined"));
const submitted = formatTuiSubmittedInput("what can you do for me?", 80);
assert.match(submitted, /❯ what can you do for me\?/);
assert.doesNotMatch(submitted, /─/);
assert.doesNotMatch(submitted, /Initializing agent\.\.\./);
assert.ok(!submitted.includes("undefined"));
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
