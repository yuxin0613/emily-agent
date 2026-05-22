import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { CodexModelProvider } from "../src/llm/CodexModelProvider.ts";
import { ProviderCallError, type ProviderConfig } from "../src/llm/ModelProvider.ts";

const missingAuthProvider = new CodexModelProvider({
  id: "codex-missing-auth",
  type: "codex",
  model: "gpt-5.5",
  config: {
    authJsonPath: path.join(os.tmpdir(), `missing-codex-auth-${process.pid}.json`),
  },
});

await assert.rejects(() => missingAuthProvider.complete({
  agent: "main",
  role: "missing auth",
  prompt: "hello",
}), (error: unknown) => (
  error instanceof ProviderCallError
  && error.code === "auth_error"
  && /Codex auth file not found/.test(error.message)
));

const authDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-codex-auth-"));
const authJsonPath = path.join(authDir, "auth.json");
await writeFile(authJsonPath, JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    account_id: "account-123",
  },
  last_refresh: new Date().toISOString(),
}, null, 2), "utf8");

let captured: {
  headers: IncomingMessage["headers"];
  body: unknown;
} | null = null;

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(request, "end");
  captured = {
    headers: request.headers,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    output_text: "{\"summary\":\"codex ok\"}",
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      total_tokens: 7,
    },
  }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config: ProviderConfig = {
    id: "codex-success",
    type: "codex",
    model: "gpt-5.5",
    config: {
      authJsonPath,
      baseUrl: `http://127.0.0.1:${address.port}/codex`,
      strictJson: true,
    },
  };
  const provider = new CodexModelProvider(config);
  const result = await provider.complete({
    agent: "main",
    role: "developer",
    prompt: "Reply with JSON.",
  });

  assert.equal(captured?.headers.authorization, "Bearer test-access-token");
  assert.equal(captured?.headers["chatgpt-account-id"], "account-123");
  assert.equal((captured?.body as { model?: string }).model, "gpt-5.5");
  assert.equal(result.content, "{\"summary\":\"codex ok\"}");
  assert.equal(result.rawProvider, "codex");
  assert.equal(result.usage?.inputTokens, 3);
  assert.equal(result.usage?.outputTokens, 4);
  assert.equal(result.usage?.totalTokens, 7);
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

console.log("codex provider test passed");
