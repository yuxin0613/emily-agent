import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { ToolExecutor } from "../src/tools/ToolExecutor.ts";
import { createDefaultToolRegistry } from "../src/tools/ToolRegistry.ts";
import { TaskStore } from "../src/tasks/TaskStore.ts";
import type { RoleDefinition } from "../src/types.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-tool-executor-"));
const taskStore = await TaskStore.create({ dataDir });
const executor = new ToolExecutor({
  workspaceDir: process.cwd(),
  taskStore,
  registry: createDefaultToolRegistry(),
});

const role: RoleDefinition = {
  name: "network-researcher",
  role: "Use approved external tools.",
  singleton: true,
  allowedTools: ["read_file", "http_fetch", "browser", "github", "delete_file"],
  forbiddenTools: ["delete_file"],
  maxConcurrentTasks: 1,
  capabilities: ["research"],
  skills: [],
  instructions: "Use approved tools only.",
};

const read = await executor.execute({
  tool: "read_file",
  args: { path: "README.md", maxBytes: 120 },
  roleDefinition: role,
  permissionMode: "read_only",
  sessionId: "tool-executor",
});
assert.equal(read.ok, true);
assert.match(String((read.output as { content?: string }).content || ""), /emily-agent/);

const deniedByMode = await executor.execute({
  tool: "http_fetch",
  args: { url: "https://example.com" },
  roleDefinition: role,
  permissionMode: "workspace_write",
  sessionId: "tool-executor",
});
assert.equal(deniedByMode.ok, false);
assert.match(String(deniedByMode.error || ""), /not allowed/);

const approvalRequired = await executor.execute({
  tool: "http_fetch",
  args: { url: "https://example.com" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(approvalRequired.ok, false);
assert.match(String(approvalRequired.error || ""), /network_read/);

const wrongTemplate = await executor.execute({
  tool: "http_fetch",
  args: { url: "https://example.com" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  approval: { approved: true, template: "network_write", reason: "wrong template" },
  sessionId: "tool-executor",
});
assert.equal(wrongTemplate.ok, false);
assert.match(String(wrongTemplate.error || ""), /network_read/);

const githubReadApproval = await executor.execute({
  tool: "github",
  args: { action: "pr.get", number: "1" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(githubReadApproval.ok, false);
assert.match(String(githubReadApproval.error || ""), /github_read/);

const githubWriteApproval = await executor.execute({
  tool: "github",
  args: { action: "issue.comment", number: "1", body: "Looks good from test." },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(githubWriteApproval.ok, false);
assert.match(String(githubWriteApproval.error || ""), /github_write/);

const browserServer = http.createServer((request, response) => {
  if (request.url === "/next") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><head><title>Next page</title></head><body><h1>Arrived</h1><p>Second page text.</p></body></html>");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end('<html><head><title>Home</title></head><body><h1>Home</h1><a href="/next">Next</a><form action="/search"><input name="q" /></form></body></html>');
});
await new Promise<void>((resolve) => browserServer.listen(0, "127.0.0.1", resolve));
const address = browserServer.address() as AddressInfo;
try {
  const browser = await executor.execute({
    tool: "browser",
    args: { url: `http://127.0.0.1:${address.port}/`, action: "follow_link", text: "Next" },
    roleDefinition: role,
    permissionMode: "danger_full_access",
    approval: { approved: true, template: "browser_interaction", reason: "local test browser" },
    sessionId: "tool-executor",
  });
  assert.equal(browser.ok, true);
  const output = browser.output as { snapshot?: { title?: string; headings?: Array<{ text: string }> } };
  assert.equal(output.snapshot?.title, "Next page");
  assert.equal(output.snapshot?.headings?.[0]?.text, "Arrived");
} finally {
  await new Promise<void>((resolve, reject) => browserServer.close((error) => error ? reject(error) : resolve()));
}

const forbidden = await executor.execute({
  tool: "delete_file",
  args: { path: "README.md" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  approval: { approved: true, reason: "test should still honor forbidden tools" },
  sessionId: "tool-executor",
});
assert.equal(forbidden.ok, false);
assert.match(String(forbidden.error || ""), /not allowed/);

const events = taskStore.getLatestEvents({ limit: 50 });
assert.ok(events.some((event) => event.type === "tool.execution.completed"));
assert.ok(events.some((event) => event.type === "tool.execution.approval_required"));

taskStore.close();
console.log("tool executor test passed");
