import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { webAppHtml } from "../src/adapters/webUi.ts";
import { formatTuiCommandHints, formatTuiHelp, formatTuiHome, formatTuiSubmittedInput, isTuiAbortError } from "../src/adapters/tui.ts";

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
assert.match(tuiHelp, /:mode \[mode\]/);
assert.match(tuiHelp, /:status/);
assert.match(tuiHelp, /:timeline \[runId\]/);
assert.ok(!tuiHelp.includes("undefined"));
const slashHints = formatTuiCommandHints("/");
assert.match(slashHints, /Command hints/);
assert.match(slashHints, /\/help/);
assert.match(slashHints, /\/new \[title\]/);
assert.match(slashHints, /\/status/);
assert.ok(!slashHints.includes("undefined"));
const filteredHints = formatTuiCommandHints("/", "sta");
assert.match(filteredHints, /Command hints for \/sta/);
assert.match(filteredHints, /\/status/);
assert.doesNotMatch(filteredHints, /\/new \[title\]/);
const tuiHome = formatTuiHome({
  provider: { id: "deepseek", model: "deepseek-chat", type: "openai" },
  tools: [{ name: "read_file", category: "filesystem" }, { name: "shell", category: "process" }],
  skills: [{ name: "coding", capabilities: ["software-development"], source: "builtin" }],
});
assert.match(tuiHome, /Emily AgentOS/);
assert.match(tuiHome, /Available Tools/);
assert.match(tuiHome, /Available Skills/);
assert.match(tuiHome, /deepseek-chat/);
assert.match(tuiHome, /Welcome to Emily Agent! Type your message or \/help for commands\./);
assert.ok(!tuiHome.includes("undefined"));
const submitted = formatTuiSubmittedInput("what can you do for me?", 80);
assert.match(submitted, /● what can you do for me\?/);
assert.match(submitted, /Initializing agent\.\.\./);
assert.ok(!submitted.includes("undefined"));
assert.equal(isTuiAbortError(Object.assign(new Error("Aborted with Ctrl+C"), {
  name: "AbortError",
  code: "ABORT_ERR",
})), true);
assert.equal(isTuiAbortError(new Error("regular failure")), false);

const cliHelp = await execFileAsync(process.execPath, ["src/index.ts", "--help"], {
  cwd: process.cwd(),
  timeout: 5000,
});
assert.match(cliHelp.stdout, /Emily AgentOS/);
assert.match(cliHelp.stdout, /emily --web/);
assert.equal(cliHelp.stderr, "");

console.log("ui test passed");
