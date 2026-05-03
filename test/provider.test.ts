import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { parseTaskResult } from "../src/tasks/TaskResult.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-provider-"));
const roleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-roles-"));

const runtime = await createRuntime({
  dataDir,
  roleDir,
  providers: [
    {
      id: "main-echo",
      type: "echo",
      model: "main-model",
    },
    {
      id: "qa-echo",
      type: "echo",
      model: "qa-base-model",
    },
  ],
  defaultProviderId: "main-echo",
  mainProviderId: "main-echo",
});

assert.deepEqual(runtime.listProviders().map((provider) => provider.id).sort(), ["main-echo", "qa-echo"]);

assert.rejects(() => runtime.addProvider({
  id: "bad secret",
  type: "openai",
  model: "gpt-test",
  config: {
    apiKey: "do-not-store",
    apiKeyEnv: "OPENAI_API_KEY",
  },
}), /Provider id|raw apiKey/);

await runtime.addProvider({
  id: "openai-missing-env",
  type: "openai",
  model: "gpt-test",
  config: {
    apiKeyEnv: "EMILY_TEST_MISSING_OPENAI_KEY",
  },
});
const providerHealth = await runtime.checkProviders();
assert.equal(providerHealth.find((item) => item.id === "openai-missing-env")?.ok, false);

const role = await runtime.addRole({
  name: "qa",
  role: "Check runtime behavior and return concise quality notes.",
  provider: "qa-echo",
  model: "qa-special-model",
  temperature: 0.1,
  allowedTools: ["read_file"],
  forbiddenTools: ["write_file"],
  capabilities: ["quality", "verification"],
  instructions: "Review the assigned task and return a concise QA result.",
});

assert.equal(role.name, "qa");
assert.equal(role.provider, "qa-echo");
assert.equal(role.model, "qa-special-model");

await assert.rejects(() => runtime.addRole({
  name: "bad role",
  role: "Invalid role",
  provider: "qa-echo",
  allowedTools: ["read_file"],
  instructions: "bad",
}), /Role name/);

await assert.rejects(() => runtime.addRole({
  name: "conflict",
  role: "Invalid tool conflict",
  provider: "qa-echo",
  allowedTools: ["read_file"],
  forbiddenTools: ["read_file"],
  instructions: "bad",
}), /both allowed and forbidden/);

const updated = await runtime.updateRoleProvider("qa", {
  provider: "qa-echo",
  model: "qa-updated-model",
  temperature: 0,
});
assert.equal(updated.model, "qa-updated-model");

const task = runtime.taskStore.createTask({
  role: "qa",
  title: "provider selection",
  input: "Verify that qa uses its role-specific provider.",
  metadata: {
    sessionId: "provider-test",
    maxMemoryCandidates: 0,
  },
});

const finished = await runtime.roleAgentManager.runTask(task, {
  timeoutMs: 10000,
});
const result = parseTaskResult(finished.result);
assert.equal(finished.status, "done");
assert.ok(result);
assert.match(result.summary, /Provider: qa-echo/);
assert.match(result.summary, /Model: qa-updated-model/);
assert.equal(result.artifacts[0]?.metadata?.providerId, "qa-echo");
assert.equal(typeof result.artifacts[0]?.metadata?.latencyMs, "number");

const roles = await runtime.listRoles();
assert.ok(roles.some((item) => item.name === "qa"));
const defaults = await runtime.initializeDefaultRoles();
assert.ok(defaults.some((item) => item.name === "planner"));

await runtime.shutdown();

const fallbackDataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-provider-fallback-"));
const fallbackRoleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-fallback-roles-"));
await mkdir(path.join(fallbackRoleDir, "fallback"), { recursive: true });
await writeFile(path.join(fallbackRoleDir, "fallback", "agent.md"), [
  "---",
  "name: \"fallback\"",
  "role: \"Exercise missing provider fallback.\"",
  "provider: \"missing-provider\"",
  "allowed_tools:",
  "  - read_file",
  "capabilities:",
  "  - fallback",
  "---",
  "Use the assigned task and return a concise fallback result.",
  "",
].join("\n"), "utf8");

const fallbackRuntime = await createRuntime({
  dataDir: fallbackDataDir,
  roleDir: fallbackRoleDir,
  providers: [
    {
      id: "main-echo",
      type: "echo",
      model: "fallback-main",
    },
    {
      id: "other-echo",
      type: "echo",
      model: "fallback-other",
    },
  ],
  defaultProviderId: "other-echo",
  mainProviderId: "main-echo",
  providerFallbackMode: "fallback",
});
assert.equal(fallbackRuntime.providerRegistry.defaultProviderId, "main-echo");
const fallbackTask = fallbackRuntime.taskStore.createTask({
  role: "fallback",
  title: "provider fallback",
  input: "Verify missing provider fallback.",
  metadata: {
    sessionId: "fallback-test",
    maxMemoryCandidates: 0,
  },
});
const fallbackFinished = await fallbackRuntime.roleAgentManager.runTask(fallbackTask, {
  timeoutMs: 10000,
});
const fallbackResult = parseTaskResult(fallbackFinished.result);
assert.equal(fallbackFinished.status, "done");
assert.match(fallbackResult?.summary || "", /Provider: main-echo/);
assert.doesNotMatch(fallbackResult?.summary || "", /Provider: other-echo/);
assert.ok(fallbackRuntime.taskStore.getLatestEvents({ limit: 50 }).some((event) => event.type === "runtime.anomaly" && event.payload.code === "provider_fallback"));
await fallbackRuntime.shutdown();

console.log("provider test passed");
