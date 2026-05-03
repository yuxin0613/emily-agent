import assert from "node:assert/strict";
import { webAppHtml } from "../src/adapters/webUi.ts";

const html = webAppHtml();

assert.match(html, /Emily AgentOS/);
assert.match(html, /id="nav"/);
assert.match(html, /id="content"/);
assert.match(html, /Sessions/);
assert.match(html, /\/sessions\/clear/);
assert.match(html, /\/sessions\/restore/);
assert.match(html, /\/skill-candidates\/build/);
assert.match(html, /\/chat/);
assert.ok(!html.includes("${undefined}"));

console.log("ui test passed");
