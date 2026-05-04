import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { webAppHtml } from "../src/adapters/webUi.ts";
import { formatTuiHelp } from "../src/adapters/tui.ts";

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

const cliHelp = await execFileAsync(process.execPath, ["src/index.ts", "--help"], {
  cwd: process.cwd(),
  timeout: 5000,
});
assert.match(cliHelp.stdout, /Emily AgentOS/);
assert.match(cliHelp.stdout, /emily --web/);
assert.equal(cliHelp.stderr, "");

console.log("ui test passed");
