import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { parseTaskResult } from "../src/tasks/TaskResult.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-web-search-skill-runtime-"));
const searchRequests: Array<{ url: string; body: string }> = [];
const searchServer = http.createServer((request, response) => {
  if (request.url?.startsWith("/web-search") && request.method === "GET") {
    searchRequests.push({ url: request.url, body: "" });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      results: [{
        title: "NVIDIA news",
        url: "https://example.com/nvidia-news",
        content: "NVIDIA released open model news.",
      }],
    }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise<void>((resolve) => searchServer.listen(0, "127.0.0.1", resolve));
const address = searchServer.address() as AddressInfo;
const previousProvider = process.env.EMILY_WEB_SEARCH_PROVIDER;
const previousEndpoint = process.env.EMILY_WEB_SEARCH_ENDPOINT;
const previousAllowPrivate = process.env.EMILY_HTTP_ALLOW_PRIVATE;
process.env.EMILY_WEB_SEARCH_PROVIDER = "endpoint";
process.env.EMILY_WEB_SEARCH_ENDPOINT = `http://127.0.0.1:${address.port}/web-search`;
process.env.EMILY_HTTP_ALLOW_PRIVATE = "true";

const runtime = await createRuntime({
  dataDir,
  providers: [{
    id: "main-echo",
    type: "echo",
    model: "web-search-skill-runtime",
  }],
  defaultProviderId: "main-echo",
  mainProviderId: "main-echo",
});

try {
  const task = runtime.taskStore.createTask({
    role: "researcher",
    title: "web-search skill runtime",
    input: "搜索nvidia的新闻",
    metadata: {
      sessionId: "web-search-skill-runtime",
      permissionMode: "workspace_write",
      maxMemoryCandidates: 0,
      skillHints: ["web-search"],
    },
  });

  const finished = await runtime.roleAgentManager.runTask(task, { timeoutMs: 30000 });
  const result = parseTaskResult(finished.result);
  const metadata = result?.artifacts[0]?.metadata;
  assert.equal(finished.status, "done");
  assert.equal(result?.status, "success");
  assert.ok(searchRequests.length >= 1);
  assert.ok(searchRequests[0]?.url.includes("nvidia"));
  assert.ok(Array.isArray(metadata?.skills?.matched) && metadata.skills.matched.includes("web-search"));
  assert.ok(Array.isArray(metadata?.tools?.executed));
  assert.ok(metadata.tools.executed.some((item: { tool?: string; ok?: boolean }) => item.tool === "web_search" && item.ok === true));
} finally {
  await runtime.shutdown();
  await new Promise<void>((resolve, reject) => searchServer.close((error) => error ? reject(error) : resolve()));
  if (previousProvider === undefined) delete process.env.EMILY_WEB_SEARCH_PROVIDER;
  else process.env.EMILY_WEB_SEARCH_PROVIDER = previousProvider;
  if (previousEndpoint === undefined) delete process.env.EMILY_WEB_SEARCH_ENDPOINT;
  else process.env.EMILY_WEB_SEARCH_ENDPOINT = previousEndpoint;
  if (previousAllowPrivate === undefined) delete process.env.EMILY_HTTP_ALLOW_PRIVATE;
  else process.env.EMILY_HTTP_ALLOW_PRIVATE = previousAllowPrivate;
}

console.log("web search skill runtime test passed");
