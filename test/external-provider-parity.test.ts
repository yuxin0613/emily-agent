import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import type { ProviderConfig, ProviderType } from "../src/llm/ModelProvider.ts";

if (process.env.EMILY_PROVIDER_INTEGRATION !== "true") {
  console.log("external provider parity test skipped; set EMILY_PROVIDER_INTEGRATION=true with provider env");
  process.exit(0);
}

const type = parseProviderType(process.env.EMILY_PROVIDER_TYPE || "openai");
const apiKeyEnv = process.env.EMILY_PROVIDER_API_KEY_ENV || "OPENAI_API_KEY";
const provider: ProviderConfig = {
  id: "external-parity",
  type,
  model: process.env.EMILY_PROVIDER_MODEL || (type === "ollama" ? "llama3.1" : "gpt-4.1-mini"),
  config: {
    baseUrl: process.env.EMILY_PROVIDER_BASE_URL,
    apiKeyEnv,
    timeoutMs: Number(process.env.EMILY_PROVIDER_TIMEOUT_MS || 15000),
    strictJson: false,
  },
};

if (type === "openai") {
  assert.ok(process.env[apiKeyEnv], `external provider parity requires ${apiKeyEnv}`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-provider-parity-"));
const runtime = await createRuntime({
  dataDir,
  providers: [provider],
  defaultProviderId: provider.id,
  mainProviderId: provider.id,
});

try {
  const health = await runtime.checkProviders({ deep: true });
  const target = health.find((item) => item.id === provider.id);
  assert.equal(target?.ok, true, `provider health failed: ${target?.reason || "missing health row"}`);

  const output = await runtime.model.complete({
    agent: "parity",
    role: "provider parity",
    prompt: "Reply with the exact text: provider parity ok",
    source: "external-provider-parity",
  });
  assert.match(typeof output === "string" ? output : output.content, /provider parity ok/i);
} finally {
  await runtime.shutdown();
}

console.log("external provider parity test passed");

function parseProviderType(value: string): ProviderType {
  if (value === "openai" || value === "ollama" || value === "echo") return value;
  throw new Error("EMILY_PROVIDER_TYPE must be openai, ollama, or echo");
}
