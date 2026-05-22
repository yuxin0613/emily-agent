import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { startModelConfig } from "../src/adapters/modelConfig.ts";
import { createRuntime } from "../src/runtime/createRuntime.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-model-config-"));
const roleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-model-config-roles-"));
const runtime = await createRuntime({ dataDir, roleDir, enableCron: false });

try {
  await runtime.initializeDefaultRoles();
  await runtime.updateRoleProvider("planner", {
    provider: "echo",
    model: "old-planner-model",
  });

  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  const configuring = startModelConfig({ runtime, input, output });
  writePromptLines(input, [
    "new",
    "echo",
    "main-model",
    "planner",
    "y",
    "done",
  ]);
  await configuring;

  assert.equal(runtime.providerRegistry.defaultProviderId, "main-echo");
  const mainProvider = runtime.providerRegistry.getConfig("main-echo");
  assert.equal(mainProvider.model, "main-model");
  const planner = await runtime.roleManager.getRole("planner");
  assert.equal(planner.provider, undefined);
  assert.equal(planner.model, undefined);
  const rendered = Buffer.concat(chunks).toString("utf8");
  assert.match(rendered, /Model setup saved/);
  assert.doesNotMatch(rendered, /Provider id/);
} finally {
  await runtime.shutdown();
}

console.log("model config test passed");

const codexDataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-model-config-codex-"));
const codexRoleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-model-config-codex-roles-"));
const codexHome = await mkdtemp(path.join(os.tmpdir(), "emily-agent-codex-home-"));
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;
await mkdir(codexHome, { recursive: true });
await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-test-codex"\n', "utf8");
const codexRuntime = await createRuntime({ dataDir: codexDataDir, roleDir: codexRoleDir, enableCron: false });

try {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

  const configuring = startModelConfig({ runtime: codexRuntime, input, output });
  writePromptLines(input, [
    "new",
    "codex",
    "",
    "",
  ]);
  await configuring;

  assert.equal(codexRuntime.providerRegistry.defaultProviderId, "main-codex");
  const provider = codexRuntime.providerRegistry.getConfig("main-codex");
  assert.equal(provider.type, "codex");
  assert.equal(provider.model, "gpt-test-codex");
  assert.equal(provider.config?.authJsonPath, path.join(codexHome, "auth.json"));
  const rendered = Buffer.concat(chunks).toString("utf8");
  assert.doesNotMatch(rendered, /API key/i);
} finally {
  await codexRuntime.shutdown();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
}

console.log("codex model config test passed");

function writePromptLines(input: PassThrough, lines: string[]): void {
  lines.forEach((line, index) => {
    setTimeout(() => input.write(`${line}\n`), index * 20);
  });
  setTimeout(() => input.end(), lines.length * 20 + 20);
}
