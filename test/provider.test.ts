import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EchoModelProvider } from "../src/llm/EchoModelProvider.ts";
import { ProviderCallError, type ModelCompleteInput, type ModelCompleteResult, type ModelProvider } from "../src/llm/ModelProvider.ts";
import { normalizeProviderJsonOutput } from "../src/llm/ProviderJson.ts";
import { normalizeModelCompleteResult, resetProviderCircuit, ResilientModelProvider } from "../src/llm/ProviderRuntime.ts";
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS, legacyProviderConfigPath, ProviderRegistry, providerConfigPath } from "../src/llm/ProviderRegistry.ts";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { parseTaskResult } from "../src/tasks/TaskResult.ts";

class FlakyProvider implements ModelProvider {
  id: string;
  model = "fake-model";
  calls = 0;

  constructor(id: string) {
    this.id = id;
  }

  async complete(_input: ModelCompleteInput): Promise<ModelCompleteResult> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new ProviderCallError({
        providerId: this.id,
        code: "server_error",
        message: "transient failure",
        retryable: true,
      });
    }
    return {
      content: "retried ok",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
      finishReason: "stop",
    };
  }
}

class FailingProvider implements ModelProvider {
  id: string;
  model = "fake-model";
  calls = 0;

  constructor(id: string) {
    this.id = id;
  }

  async complete(_input: ModelCompleteInput): Promise<ModelCompleteResult> {
    this.calls += 1;
    throw new ProviderCallError({
      providerId: this.id,
      code: "server_error",
      message: "provider down",
      retryable: true,
    });
  }
}

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
      config: {
        costPer1KInputTokens: 0.001,
        costPer1KOutputTokens: 0.002,
      },
    },
  ],
  defaultProviderId: "main-echo",
  mainProviderId: "main-echo",
});

assert.deepEqual(runtime.listProviders().map((provider) => provider.id).sort(), ["main-echo", "qa-echo"]);
const providerFile = JSON.parse(await readFile(providerConfigPath(dataDir), "utf8")) as { defaultProviderId: string; toolCallTimeoutSeconds: number };
assert.equal(providerFile.defaultProviderId, "main-echo");
assert.equal(providerFile.toolCallTimeoutSeconds, DEFAULT_TOOL_CALL_TIMEOUT_SECONDS);
await assert.rejects(() => access(legacyProviderConfigPath(dataDir)), /ENOENT/);

const legacyConfigDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-legacy-provider-config-"));
await writeFile(legacyProviderConfigPath(legacyConfigDir), JSON.stringify({
  defaultProviderId: "legacy-main",
  providers: [{
    id: "legacy-main",
    type: "echo",
    model: "legacy-model",
  }],
}, null, 2), "utf8");
const migratedRegistry = await ProviderRegistry.create({ dataDir: legacyConfigDir });
assert.equal(migratedRegistry.defaultProviderId, "legacy-main");
assert.equal(migratedRegistry.getConfig("legacy-main").model, "legacy-model");
const migratedConfig = JSON.parse(await readFile(providerConfigPath(legacyConfigDir), "utf8")) as { defaultProviderId: string; toolCallTimeoutSeconds: number };
assert.equal(migratedConfig.defaultProviderId, "legacy-main");
assert.equal(migratedConfig.toolCallTimeoutSeconds, DEFAULT_TOOL_CALL_TIMEOUT_SECONDS);
await assert.rejects(() => access(legacyProviderConfigPath(legacyConfigDir)), /ENOENT/);

const timeoutConfigDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-tool-timeout-config-"));
await mkdir(timeoutConfigDir, { recursive: true });
await writeFile(providerConfigPath(timeoutConfigDir), JSON.stringify({
  defaultProviderId: "echo",
  toolCallTimeoutSeconds: 42,
  providers: [{ id: "echo", type: "echo", model: "echo-local" }],
}, null, 2), "utf8");
const timeoutRegistry = await ProviderRegistry.create({ dataDir: timeoutConfigDir });
assert.equal(timeoutRegistry.toolCallTimeoutSeconds, 42);
const timeoutConfig = JSON.parse(await readFile(providerConfigPath(timeoutConfigDir), "utf8")) as { toolCallTimeoutSeconds: number };
assert.equal(timeoutConfig.toolCallTimeoutSeconds, 42);

const envConfigDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-env-provider-config-"));
const previousEnvFileKey = process.env.EMILY_TEST_ENV_FILE_KEY;
delete process.env.EMILY_TEST_ENV_FILE_KEY;
await writeFile(path.join(envConfigDir, ".env"), 'EMILY_TEST_ENV_FILE_KEY="loaded-from-env-file"\n', "utf8");
const envRuntime = await createRuntime({ dataDir: envConfigDir, roleDir });
assert.equal(process.env.EMILY_TEST_ENV_FILE_KEY, "loaded-from-env-file");
await envRuntime.shutdown();
if (previousEnvFileKey === undefined) delete process.env.EMILY_TEST_ENV_FILE_KEY;
else process.env.EMILY_TEST_ENV_FILE_KEY = previousEnvFileKey;

const concurrentConfigDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-provider-concurrent-"));
const concurrentA = await ProviderRegistry.create({ dataDir: concurrentConfigDir });
const concurrentB = await ProviderRegistry.create({ dataDir: concurrentConfigDir });
concurrentA.add({ id: "provider-a", type: "echo", model: "model-a" });
concurrentB.add({ id: "provider-b", type: "echo", model: "model-b" });
await Promise.all([
  concurrentA.write(concurrentConfigDir),
  concurrentB.write(concurrentConfigDir),
]);
const mergedProviderIds = (JSON.parse(await readFile(providerConfigPath(concurrentConfigDir), "utf8")) as { providers: ProviderConfig[] })
  .providers
  .map((provider) => provider.id)
  .sort();
assert.deepEqual(mergedProviderIds, ["echo", "provider-a", "provider-b"]);

const removeA = await ProviderRegistry.create({ dataDir: concurrentConfigDir });
const addC = await ProviderRegistry.create({ dataDir: concurrentConfigDir });
removeA.remove("provider-a");
addC.add({ id: "provider-c", type: "echo", model: "model-c" });
await Promise.all([
  removeA.write(concurrentConfigDir),
  addC.write(concurrentConfigDir),
]);
const afterRemoveProviderIds = (JSON.parse(await readFile(providerConfigPath(concurrentConfigDir), "utf8")) as { providers: ProviderConfig[] })
  .providers
  .map((provider) => provider.id)
  .sort();
assert.deepEqual(afterRemoveProviderIds, ["echo", "provider-b", "provider-c"]);

assert.rejects(() => runtime.addProvider({
  id: "bad secret",
  type: "openai",
  model: "gpt-test",
  config: {
    apiKey: "do-not-store",
    apiKeyEnv: "OPENAI_API_KEY",
  },
}), /Provider id|raw apiKey/);

await assert.rejects(() => runtime.addProvider({
  id: "bad-url",
  type: "ollama",
  model: "bad",
  config: {
    baseUrl: "file:///tmp/model",
  },
}), /protocol/);

await assert.rejects(() => runtime.addProvider({
  id: "unknown-config",
  type: "ollama",
  model: "bad",
  config: {
    baseUrl: "http://127.0.0.1:11434",
    extra: true,
  },
}), /Unknown provider config key/);

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

await runtime.addProvider({
  id: "spare-echo",
  type: "echo",
  model: "spare-model",
});
const disabledSpare = await runtime.disableProvider("spare-echo");
assert.equal(disabledSpare.enabled, false);
const disabledHealth = await runtime.checkProviders();
assert.equal(disabledHealth.find((item) => item.id === "spare-echo")?.disabled, true);
assert.throws(() => runtime.providerRegistry.createProvider("spare-echo"), /disabled/);
const enabledSpare = await runtime.enableProvider("spare-echo");
assert.equal(enabledSpare.enabled, true);
const removedSpare = await runtime.removeProvider("spare-echo");
assert.equal(removedSpare.id, "spare-echo");
await assert.rejects(() => runtime.disableProvider("main-echo"), /default provider/);

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
const partialUpdated = await runtime.updateRoleProvider("qa", {
  model: "qa-partial-model",
});
assert.equal(partialUpdated.provider, "qa-echo");
assert.equal(partialUpdated.model, "qa-partial-model");
assert.equal(partialUpdated.temperature, 0);
await assert.rejects(() => runtime.updateRoleProvider("../escaped", {
  model: "escaped-model",
}), /Role name/);
await assert.rejects(access(path.join(path.dirname(roleDir), "escaped", "agent.md")), /ENOENT/);
await assert.rejects(() => runtime.removeProvider("qa-echo"), /referenced by roles: qa/);

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
assert.match(result.summary, /Model: qa-partial-model/);
assert.equal(result.artifacts[0]?.metadata?.providerId, "qa-echo");
assert.equal(typeof result.artifacts[0]?.metadata?.latencyMs, "number");
assert.equal(typeof result.artifacts[0]?.metadata?.attempts, "number");
assert.equal(result.artifacts[0]?.metadata?.jsonFormat, "wrapped_text");
assert.equal(typeof result.artifacts[0]?.metadata?.costUsd, "number");

const usage = runtime.providerUsage({ providerId: "qa-echo" });
assert.ok(usage.totals.calls >= 1);
assert.ok(usage.totals.totalTokens > 0);
assert.ok(usage.totals.costUsd > 0);
assert.ok(usage.recent.some((item) => item.providerId === "qa-echo" && item.status === "success"));

await runtime.addProvider({
  id: "limited-echo",
  type: "echo",
  model: "limit-model",
  config: {
    maxCallsPerDay: 1,
    strictJson: false,
  },
});
const limitedModel = runtime.providerRegistry.createProvider("limited-echo");
await limitedModel.complete({
  agent: "qa",
  role: "quota",
  prompt: "first call is allowed",
});
await assert.rejects(() => limitedModel.complete({
  agent: "qa",
  role: "quota",
  prompt: "second call is blocked",
}), (error: unknown) => error instanceof ProviderCallError && error.code === "quota_exceeded");
const limitedUsage = runtime.providerUsage({ providerId: "limited-echo" });
assert.equal(limitedUsage.totals.success, 1);
assert.equal(limitedUsage.totals.blocked, 1);

const directJson = normalizeProviderJsonOutput("prefix ```json\n{\"summary\":\"json ok\",\"metadata\":{\"source\":\"test\"}}\n``` suffix");
assert.equal(directJson.content, "json ok");
assert.equal(directJson.format, "json_extracted");
const fallbackJson = normalizeProviderJsonOutput("plain text only");
assert.equal(fallbackJson.content, "plain text only");
assert.equal(fallbackJson.format, "wrapped_text");

const flakyProvider = new FlakyProvider("flaky-provider");
const retryModel = new ResilientModelProvider(flakyProvider, {
  id: flakyProvider.id,
  type: "echo",
  model: flakyProvider.model,
  config: {
    maxRetries: 1,
    retryBaseMs: 1,
    retryMaxMs: 1,
  },
});
const retryResult = normalizeModelCompleteResult(await retryModel.complete({
  agent: "qa",
  role: "retry",
  prompt: "retry once",
}), retryModel);
assert.equal(retryResult.content, "retried ok");
assert.equal(retryResult.attempts, 2);
assert.equal(retryResult.usage?.totalTokens, 3);

resetProviderCircuit("circuit-provider");
const failingProvider = new FailingProvider("circuit-provider");
const circuitModel = new ResilientModelProvider(failingProvider, {
  id: failingProvider.id,
  type: "echo",
  model: failingProvider.model,
  config: {
    maxRetries: 0,
    circuitBreakerFailureThreshold: 1,
    circuitBreakerCooldownMs: 1000,
  },
});
await assert.rejects(() => circuitModel.complete({
  agent: "qa",
  role: "circuit",
  prompt: "fail",
}), (error: unknown) => error instanceof ProviderCallError && error.code === "server_error");
await assert.rejects(() => circuitModel.complete({
  agent: "qa",
  role: "circuit",
  prompt: "fail fast",
}), (error: unknown) => error instanceof ProviderCallError && error.code === "circuit_open");
assert.equal(failingProvider.calls, 1);

const roles = await runtime.listRoles();
assert.ok(roles.some((item) => item.name === "qa"));
const defaults = await runtime.initializeDefaultRoles();
const plannerDefault = defaults.find((item) => item.name === "planner");
assert.ok(plannerDefault);
assert.equal(plannerDefault.provider, undefined);
assert.equal(plannerDefault.model, undefined);
const defaultPlannerTask = runtime.taskStore.createTask({
  role: "planner",
  title: "default provider fallback",
  input: "Verify default planner uses main provider.",
  metadata: {
    sessionId: "provider-test",
    maxMemoryCandidates: 0,
  },
});
const defaultPlannerFinished = await runtime.roleAgentManager.runTask(defaultPlannerTask, {
  timeoutMs: 10000,
});
const defaultPlannerResult = parseTaskResult(defaultPlannerFinished.result);
assert.equal(defaultPlannerFinished.status, "done");
assert.equal(defaultPlannerResult?.artifacts[0]?.metadata?.providerId, "main-echo");

await runtime.shutdown();

await assert.rejects(async () => {
  const customDataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-custom-model-"));
  const customRoleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-custom-model-roles-"));
  await createRuntime({
    dataDir: customDataDir,
    roleDir: customRoleDir,
    model: new EchoModelProvider({ id: "custom-main", model: "custom-model" }),
  });
}, /requires mainProviderId/);

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
