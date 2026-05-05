import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  allowedTools: ["read_file", "http_fetch", "web_search", "browser", "github", "llm_wiki", "delete_file"],
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
assert.match(String((read.output as { content?: string }).content || ""), /Emily AgentOS/);

const timeoutExecutor = new ToolExecutor({
  workspaceDir: process.cwd(),
  taskStore,
  registry: createDefaultToolRegistry(),
  toolCallTimeoutMs: 10,
});
(timeoutExecutor as unknown as { executeAllowed: () => Promise<never> }).executeAllowed = async () => new Promise<never>(() => undefined);
const timedOut = await timeoutExecutor.execute({
  tool: "read_file",
  args: { path: "README.md" },
  roleDefinition: role,
  permissionMode: "read_only",
  sessionId: "tool-executor",
});
assert.equal(timedOut.ok, false);
assert.match(String(timedOut.error || ""), /timed out after 10ms/);

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

const webSearchApprovalRequired = await executor.execute({
  tool: "web_search",
  args: { query: "agentos", provider: "endpoint" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(webSearchApprovalRequired.ok, false);
assert.match(String(webSearchApprovalRequired.error || ""), /network_read/);

const llmWikiReadApprovalRequired = await executor.execute({
  tool: "llm_wiki",
  args: { action: "query", query: "agentos" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(llmWikiReadApprovalRequired.ok, false);
assert.match(String(llmWikiReadApprovalRequired.error || ""), /network_read/);

const llmWikiWriteApprovalRequired = await executor.execute({
  tool: "llm_wiki",
  args: { action: "import_url", urls: ["https://example.com/docs.md"] },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(llmWikiWriteApprovalRequired.ok, false);
assert.match(String(llmWikiWriteApprovalRequired.error || ""), /network_write/);

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

const rawGithubApiWrite = await executor.execute({
  tool: "github",
  args: { command: ["api", "--method", "DELETE", "/repos/example/repo/git/refs/heads/main"] },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(rawGithubApiWrite.ok, false);
assert.match(String(rawGithubApiWrite.error || ""), /github_write/);

const rawGithubApiDefaultWrite = await executor.execute({
  tool: "github",
  args: { command: ["api", "/repos/example/repo/issues"] },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(rawGithubApiDefaultWrite.ok, false);
assert.match(String(rawGithubApiDefaultWrite.error || ""), /github_write/);

const rawGithubApiExplicitRead = await executor.execute({
  tool: "github",
  args: { command: ["api", "--method", "GET", "/repos/example/repo/issues"] },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(rawGithubApiExplicitRead.ok, false);
assert.match(String(rawGithubApiExplicitRead.error || ""), /github_read/);

const localNetworkBlocked = await executor.execute({
  tool: "http_fetch",
  args: { url: "http://127.0.0.1:9/" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  approval: { approved: true, template: "network_read", reason: "denylist test" },
  sessionId: "tool-executor",
});
assert.equal(localNetworkBlocked.ok, false);
assert.match(String(localNetworkBlocked.error || ""), /private|local/);

const mappedLoopbackBlocked = await executor.execute({
  tool: "http_fetch",
  args: { url: "http://[::ffff:7f00:1]:9/" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  approval: { approved: true, template: "network_read", reason: "denylist test" },
  sessionId: "tool-executor",
});
assert.equal(mappedLoopbackBlocked.ok, false);
assert.match(String(mappedLoopbackBlocked.error || ""), /private|local/);

const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-tool-workspace-"));
const outsideDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-tool-outside-"));
await writeFile(path.join(outsideDir, "secret.txt"), "outside secret", "utf8");
await symlink(path.join(outsideDir, "secret.txt"), path.join(workspaceDir, "secret-link"));
const symlinkExecutor = new ToolExecutor({
  workspaceDir,
  registry: createDefaultToolRegistry(),
});
const symlinkRead = await symlinkExecutor.execute({
  tool: "read_file",
  args: { path: "secret-link" },
  roleDefinition: role,
  permissionMode: "read_only",
  sessionId: "tool-executor",
});
assert.equal(symlinkRead.ok, false);
assert.match(String(symlinkRead.error || ""), /symlink|escapes workspace/);

const browserServer = http.createServer((request, response) => {
  if (request.url === "/v1/query" && request.method === "POST") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      mode: "semantic_search",
      query: "agentos memory",
      results: [{ title: "AgentOS Memory", confidence: 0.9 }],
      total_found: 1,
    }));
    return;
  }
  if (request.url === "/v1/import-url" && request.method === "POST") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      message: "imported",
      count: 1,
      items: [{ source_url: "https://example.com/docs.md", status: "pending" }],
    }));
    return;
  }
  if (request.url?.startsWith("/web-search")) {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      results: [{
        title: "AgentOS launch notes",
        url: "https://example.com/agentos",
        content: "Bounded external search result for launch readiness.",
      }],
    }));
    return;
  }
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
const previousPrivateEgress = process.env.EMILY_HTTP_ALLOW_PRIVATE;
process.env.EMILY_HTTP_ALLOW_PRIVATE = "true";
try {
  const webSearch = await executor.execute({
    tool: "web_search",
    args: { query: "agentos launch", provider: "endpoint", endpoint: `http://127.0.0.1:${address.port}/web-search`, count: 99 },
    roleDefinition: role,
    permissionMode: "danger_full_access",
    approval: { approved: true, template: "network_read", reason: "local test web search" },
    sessionId: "tool-executor",
  });
  assert.equal(webSearch.ok, true);
  const webSearchOutput = webSearch.output as { count?: number; results?: Array<{ title?: string; snippet?: string }> };
  assert.equal(webSearchOutput.count, 1);
  assert.equal(webSearchOutput.results?.[0]?.title, "AgentOS launch notes");
  assert.equal(webSearchOutput.results?.[0]?.snippet, "Bounded external search result for launch readiness.");

  const wikiQuery = await executor.execute({
    tool: "llm_wiki",
    args: { action: "query", query: "agentos memory", baseUrl: `http://127.0.0.1:${address.port}` },
    roleDefinition: role,
    permissionMode: "danger_full_access",
    approval: { approved: true, template: "network_read", reason: "local test llm wiki query" },
    sessionId: "tool-executor",
  });
  assert.equal(wikiQuery.ok, true);
  assert.equal((wikiQuery.output as { total_found?: number }).total_found, 1);

  const wikiImport = await executor.execute({
    tool: "llm_wiki",
    args: { action: "import_url", urls: ["https://example.com/docs.md"], baseUrl: `http://127.0.0.1:${address.port}` },
    roleDefinition: role,
    permissionMode: "danger_full_access",
    approval: { approved: true, template: "network_write", reason: "local test llm wiki import" },
    sessionId: "tool-executor",
  });
  assert.equal(wikiImport.ok, true);
  assert.equal((wikiImport.output as { count?: number }).count, 1);

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
  if (previousPrivateEgress === undefined) delete process.env.EMILY_HTTP_ALLOW_PRIVATE;
  else process.env.EMILY_HTTP_ALLOW_PRIVATE = previousPrivateEgress;
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
