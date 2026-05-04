import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ProviderConfig, ProviderType } from "../llm/ModelProvider.ts";
import type { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import type { RoleDefinition } from "../types.ts";

interface ModelConfigRuntime {
  dataDir: string;
  providerRegistry: ProviderRegistry;
  listProviders: () => ProviderConfig[];
  addProvider: (config: ProviderConfig) => Promise<ProviderConfig>;
  listRoles: () => Promise<RoleDefinition[]>;
  updateRoleProvider: (
    name: string,
    input: { provider?: string | null; model?: string | null; temperature?: number | null },
  ) => Promise<RoleDefinition>;
}

interface ProviderBinding {
  providerId: string;
  model: string;
}

interface ResolvedProvider {
  provider: ProviderConfig;
  created: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  amber: "\x1b[38;5;215m",
  green: "\x1b[32m",
  dimGreen: "\x1b[38;5;29m",
  cyan: "\x1b[36m",
};

interface Keypress {
  name?: string;
  ctrl?: boolean;
}

interface SelectChoice {
  label: string;
  description?: string;
  value: string;
}

interface ProviderTemplate {
  key: string;
  aliases?: string[];
  label: string;
  type: ProviderType;
  idSuffix: string;
  model: string;
  models?: string[];
  apiKeyEnv?: string;
  baseUrl?: string;
}

type TtyReadable = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type TtyWritable = Writable & {
  isTTY?: boolean;
};

const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    key: "openai",
    label: "OpenAI (GPT models)",
    type: "openai",
    idSuffix: "openai",
    model: "gpt-4.1-mini",
    models: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"],
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    key: "deepseek",
    label: "DeepSeek (V3/R1, OpenAI-compatible)",
    type: "openai",
    idSuffix: "deepseek",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"],
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    key: "dashscope",
    aliases: ["qwen", "alibaba", "aliyun"],
    label: "Alibaba DashScope / Qwen",
    type: "openai",
    idSuffix: "dashscope",
    model: "qwen-plus",
    models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long", "qwen3-coder-plus"],
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    key: "moonshot",
    aliases: ["kimi"],
    label: "Moonshot / Kimi",
    type: "openai",
    idSuffix: "moonshot",
    model: "moonshot-v1-8k",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-k2-0711-preview"],
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    key: "zhipu",
    aliases: ["glm", "bigmodel"],
    label: "Zhipu GLM / BigModel",
    type: "openai",
    idSuffix: "zhipu",
    model: "glm-4-plus",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4-long"],
    apiKeyEnv: "ZHIPU_API_KEY",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    key: "qianfan",
    aliases: ["baidu", "ernie"],
    label: "Baidu Qianfan / ERNIE",
    type: "openai",
    idSuffix: "qianfan",
    model: "ernie-4.0-8k",
    models: ["ernie-4.0-8k", "ernie-4.0-turbo-8k", "ernie-3.5-8k", "ernie-speed-8k"],
    apiKeyEnv: "QIANFAN_API_KEY",
    baseUrl: "https://qianfan.baidubce.com/v2",
  },
  {
    key: "hunyuan",
    aliases: ["tencent"],
    label: "Tencent Hunyuan",
    type: "openai",
    idSuffix: "hunyuan",
    model: "hunyuan-turbos-latest",
    models: ["hunyuan-turbos-latest", "hunyuan-large", "hunyuan-standard", "hunyuan-lite"],
    apiKeyEnv: "HUNYUAN_API_KEY",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  },
  {
    key: "doubao",
    aliases: ["ark", "volcengine"],
    label: "Doubao / Volcano Ark",
    type: "openai",
    idSuffix: "doubao",
    model: "doubao-endpoint-id",
    models: ["doubao-endpoint-id", "doubao-seed-1-6", "doubao-1-5-pro-32k", "doubao-pro-32k"],
    apiKeyEnv: "ARK_API_KEY",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    key: "minimax",
    label: "MiniMax",
    type: "openai",
    idSuffix: "minimax",
    model: "MiniMax-Text-01",
    models: ["MiniMax-Text-01", "abab6.5s-chat", "abab6.5g-chat", "abab6.5-chat"],
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/v1",
  },
  {
    key: "ollama",
    label: "Ollama local",
    type: "ollama",
    idSuffix: "ollama",
    model: "llama3.1",
    models: ["llama3.1", "qwen2.5-coder:32b", "qwen3:32b", "gemma3:27b"],
    baseUrl: "http://127.0.0.1:11434",
  },
  {
    key: "echo",
    label: "Echo local test provider",
    type: "echo",
    idSuffix: "echo",
    model: "echo-local",
    models: ["echo-local"],
  },
  {
    key: "custom",
    aliases: ["customer", "endpoint"],
    label: "Custom endpoint (OpenAI-compatible)",
    type: "openai",
    idSuffix: "custom",
    model: "model-name",
    models: ["model-name", "gpt-4.1-mini", "qwen2.5-coder:32b", "gemma3:27b-it-q8_0"],
    apiKeyEnv: "CUSTOM_API_KEY",
    baseUrl: "http://127.0.0.1:8000/v1",
  },
];

export async function startModelConfig({
  runtime,
  input = stdin,
  output = stdout,
}: {
  runtime: ModelConfigRuntime;
  input?: Readable;
  output?: Writable;
}): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: Boolean((output as { isTTY?: boolean }).isTTY) });
  try {
    writeLine(output, "Emily AgentOS model setup");
    writeLine(output, "");
    const main = await configureMainAgent(runtime, rl, input, output);
    await configureRoles(runtime, rl, input, output, main);
    writeLine(output, "");
    writeLine(output, "Model setup saved.");
  } catch (error) {
    if (!isModelConfigAbortError(error)) throw error;
    writeLine(output, "");
    writeLine(output, "Model setup cancelled.");
  } finally {
    rl.close();
  }
}

async function configureMainAgent(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  input: Readable,
  output: Writable,
): Promise<ProviderBinding> {
  const current = runtime.providerRegistry.getConfigIncludingDisabled(runtime.providerRegistry.defaultProviderId);
  writeLine(output, `Main agent: ${formatProvider(current)}`);
  const configured = !(current.id === "echo" && current.type === "echo" && (current.model || "echo-local") === "echo-local");
  if (configured) {
    const modify = await yesNo(rl, `Main agent is already configured. Modify it?`, false);
    if (!modify) return { providerId: current.id, model: current.model || defaultModelForType(current.type) };
  } else {
    writeLine(output, "Main agent is still using the local echo provider. Configure it now.");
  }

  const binding = await configureProviderModel(runtime, rl, input, output, {
    label: "main agent",
    currentProviderId: current.id,
    currentModel: current.model || defaultModelForType(current.type),
    idPrefix: "main",
  });
  runtime.providerRegistry.defaultProviderId = binding.providerId;
  runtime.providerRegistry.ensureDefault();
  await runtime.providerRegistry.write(runtime.dataDir);
  writeLine(output, `Main agent saved: ${binding.providerId} / ${binding.model}`);
  return binding;
}

async function configureRoles(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  main: ProviderBinding,
): Promise<void> {
  const roles = await runtime.listRoles();
  if (!roles.length) {
    writeLine(output, "No roles found. Run role defaults first if you want built-in subagents.");
    return;
  }

  writeLine(output, "");
  writeLine(output, "Roles inherit the main agent provider/model by default.");
  for (;;) {
    printRoles(output, roles, main);
    const answer = (await question(rl, "Role to configure: name, number, all, or done", "done")).trim();
    if (!answer || answer.toLowerCase() === "done" || answer.toLowerCase() === "none") return;
    const selected = resolveRoles(roles, answer);
    if (!selected.length) {
      writeLine(output, `No matching role: ${answer}`);
      continue;
    }
    for (const role of selected) {
      const inherit = await yesNo(rl, `${role.name}: inherit main agent provider/model?`, true);
      if (inherit) {
        const updated = await runtime.updateRoleProvider(role.name, { provider: null, model: null });
        replaceRole(roles, updated);
        writeLine(output, `${role.name} now inherits ${main.providerId} / ${main.model}`);
        continue;
      }
      const binding = await configureProviderModel(runtime, rl, input, output, {
        label: `${role.name} role`,
        currentProviderId: role.provider || main.providerId,
        currentModel: role.model || main.model,
        idPrefix: role.name,
      });
      const updated = await runtime.updateRoleProvider(role.name, {
        provider: binding.providerId,
        model: binding.model,
      });
      replaceRole(roles, updated);
      writeLine(output, `${role.name} saved: ${binding.providerId} / ${binding.model}`);
    }
  }
}

async function configureProviderModel(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  {
    label,
    currentProviderId,
    currentModel,
    idPrefix,
  }: {
    label: string;
    currentProviderId: string;
    currentModel: string;
    idPrefix: string;
  },
): Promise<ProviderBinding> {
  for (;;) {
    const providerAnswer = await selectProvider(runtime, rl, input, output, label, currentProviderId);
    const resolved = await resolveProvider(runtime, rl, input, output, providerAnswer, idPrefix);
    if (!resolved) {
      writeLine(output, `Unknown provider: ${providerAnswer}`);
      continue;
    }
    const provider = resolved.provider;
    if (resolved.created) {
      return { providerId: provider.id, model: provider.model || defaultModelForType(provider.type) };
    }
    const model = await question(rl, `${label} model`, provider.model || currentModel || defaultModelForType(provider.type));
    const updated: ProviderConfig = {
      ...provider,
      model,
      enabled: true,
    };
    runtime.providerRegistry.add(updated);
    await runtime.providerRegistry.write(runtime.dataDir);
    return { providerId: updated.id, model: updated.model || defaultModelForType(updated.type) };
  }
}

async function selectProvider(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  label: string,
  currentProviderId: string,
): Promise<string> {
  const providers = runtime.listProviders();
  if (!canUseInteractiveSelect(input, output)) {
    printProviders(output, providers);
    return question(rl, `${label} provider id, number, or new`, currentProviderId);
  }

  const choices: SelectChoice[] = [
    ...providers.map((provider) => ({
      label: formatProvider(provider),
      description: provider.enabled === false ? "disabled" : undefined,
      value: provider.id,
    })),
    { label: "Add a provider", value: "new" },
  ];
  const currentIndex = Math.max(0, providers.findIndex((provider) => provider.id === currentProviderId));
  return selectChoice(rl, input, output, {
    prompt: `${label} provider`,
    choices,
    initialIndex: currentIndex,
  });
}

async function resolveProvider(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  answer: string,
  idPrefix: string,
): Promise<ResolvedProvider | null> {
  const providers = runtime.listProviders();
  const value = answer.trim();
  if (value.toLowerCase() === "new" || value === "+") {
    return { provider: await createProvider(runtime, rl, input, output, idPrefix), created: true };
  }
  const byIndex = Number(value);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= providers.length) {
    return { provider: providers[byIndex - 1], created: false };
  }
  const existing = providers.find((provider) => provider.id === value);
  if (existing) return { provider: existing, created: false };
  const create = await yesNo(rl, `Provider ${value} does not exist. Create it?`, false);
  return create
    ? { provider: await createProvider(runtime, rl, input, output, value || idPrefix), created: true }
    : null;
}

async function selectChoice(
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  {
    prompt,
    choices,
    initialIndex,
  }: {
    prompt: string;
    choices: SelectChoice[];
    initialIndex?: number;
  },
): Promise<string> {
  if (!choices.length) throw new Error(`${prompt} has no choices`);
  const ttyInput = input as TtyReadable;
  let index = clampIndex(initialIndex || 0, choices.length);
  let renderedLines = 0;
  let settled = false;
  const wasRaw = Boolean(ttyInput.isRaw);

  return new Promise<string>((resolve, reject) => {
    const cleanup = (resumeReadline: boolean): void => {
      input.off("keypress", onKeypress);
      if (ttyInput.setRawMode) ttyInput.setRawMode(wasRaw);
      input.pause();
      if (resumeReadline) rl.resume();
    };
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearRender(output, renderedLines);
      writeLine(output, `${prompt}: ${formatSelectedChoice(choices[index])}`);
      cleanup(true);
      resolve(value);
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearRender(output, renderedLines);
      cleanup(false);
      reject(modelConfigAbortError());
    };
    const render = (): void => {
      clearRender(output, renderedLines);
      const lines = renderSelectLines(prompt, choices, index);
      output.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    };
    const move = (delta: number): void => {
      index = (index + delta + choices.length) % choices.length;
      render();
    };
    const onKeypress = (_text: string, key: Keypress = {}): void => {
      if (key.ctrl && key.name === "c") {
        abort();
        return;
      }
      if (key.name === "escape") {
        abort();
        return;
      }
      if (key.name === "up" || key.name === "k") {
        move(-1);
        return;
      }
      if (key.name === "down" || key.name === "j") {
        move(1);
        return;
      }
      if (key.name === "return" || key.name === "enter" || key.name === "space") {
        finish(choices[index].value);
      }
    };

    rl.pause();
    emitKeypressEvents(input);
    if (ttyInput.setRawMode) ttyInput.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
}

async function createProvider(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  idPrefix: string,
): Promise<ProviderConfig> {
  const template = await selectProviderTemplate(rl, input, output);
  const providerOptions = await providerConfigForTemplate(template, rl, input, output, runtime.dataDir);
  const model = await selectDefaultModel(template, providerOptions, rl, input, output);
  const id = uniqueProviderId(runtime, `${sanitizeProviderId(idPrefix)}-${template.idSuffix}`);
  const config: ProviderConfig = {
    id,
    type: template.type,
    model,
    enabled: true,
    config: providerOptions,
  };
  const saved = await runtime.addProvider(config);
  writeLine(output, `Provider saved: ${saved.id}`);
  return saved;
}

function uniqueProviderId(runtime: ModelConfigRuntime, preferred: string): string {
  const base = sanitizeProviderId(preferred);
  const used = new Set(runtime.listProviders().map((provider) => provider.id));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

async function selectProviderTemplate(
  rl: readline.Interface,
  input: Readable,
  output: Writable,
): Promise<ProviderTemplate> {
  if (canUseInteractiveSelect(input, output)) {
    const key = await selectChoice(rl, input, output, {
      prompt: "provider template",
      choices: PROVIDER_TEMPLATES.map((template) => ({
        label: template.label,
        description: providerTemplateDescription(template),
        value: template.key,
      })),
      initialIndex: 0,
    });
    return resolveProviderTemplate(key) || PROVIDER_TEMPLATES[0];
  }

  for (;;) {
    const answer = await question(
      rl,
      "Provider template: openai, deepseek, dashscope/qwen, moonshot/kimi, zhipu/glm, qianfan/baidu, hunyuan/tencent, doubao, minimax, ollama, echo, or custom",
      "openai",
    );
    const template = resolveProviderTemplate(answer);
    if (template) return template;
    writeLine(output, `Unknown provider template: ${answer}`);
  }
}

function resolveProviderTemplate(value: string): ProviderTemplate | null {
  const normalized = value.trim().toLowerCase();
  return PROVIDER_TEMPLATES.find((template) => (
    template.key === normalized
    || template.idSuffix === normalized
    || template.type === normalized
    || (template.aliases || []).includes(normalized)
  )) || null;
}

function providerTemplateDescription(template: ProviderTemplate): string {
  if (template.type === "echo") return `${template.type}, ${template.model}`;
  return `${template.type}, ${template.model}, ${defaultBaseUrlForTemplate(template)}`;
}

async function providerConfigForTemplate(
  template: ProviderTemplate,
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  dataDir: string,
): Promise<ProviderConfig["config"]> {
  if (template.type === "openai") {
    const apiKeyEnv = template.apiKeyEnv || "OPENAI_API_KEY";
    await configureApiKey({ dataDir, input, output, rl, template, apiKeyEnv });
    const baseUrl = await question(rl, "OpenAI-compatible base URL", defaultBaseUrlForTemplate(template));
    return {
      apiKeyEnv,
      baseUrl,
      strictJson: true,
      maxRetries: 2,
    };
  }
  if (template.type === "ollama") {
    const baseUrl = await question(rl, "Ollama base URL", defaultBaseUrlForTemplate(template));
    return { baseUrl };
  }
  return undefined;
}

async function selectDefaultModel(
  template: ProviderTemplate,
  providerOptions: ProviderConfig["config"],
  rl: readline.Interface,
  input: Readable,
  output: Writable,
): Promise<string> {
  const fallback = template.model || defaultModelForType(template.type);
  if (!canUseInteractiveSelect(input, output)) {
    return question(rl, "Provider default model", fallback);
  }

  const endpointModels = await fetchProviderModels(template, providerOptions);
  const registryModels = uniqueStrings([...(endpointModels.models || []), ...(template.models || []), fallback]);
  const source = endpointModels.models.length ? endpointModels.source : "built-in registry";
  writeLine(output, `Found ${registryModels.length} model(s) from ${source}`);
  const customValue = "__custom_model__";
  const model = await selectChoice(rl, input, output, {
    prompt: "default model",
    choices: [
      ...registryModels.map((item) => ({ label: item, value: item })),
      { label: "Enter custom model name", value: customValue },
    ],
    initialIndex: Math.max(0, registryModels.indexOf(fallback)),
  });
  if (model === customValue) {
    return question(rl, "Custom model name", fallback);
  }
  return model;
}

async function fetchProviderModels(
  template: ProviderTemplate,
  providerOptions: ProviderConfig["config"],
): Promise<{ models: string[]; source: string }> {
  try {
    if (template.type === "openai") {
      const baseUrl = String(providerOptions?.baseUrl || defaultBaseUrlForTemplate(template));
      const apiKeyEnv = String(providerOptions?.apiKeyEnv || template.apiKeyEnv || "");
      const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : "";
      if (!apiKey) return { models: [], source: "built-in registry" };
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) return { models: [], source: "built-in registry" };
      const body = await response.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown } | string> };
      const models = uniqueStrings([
        ...(body.data || []).map((item) => String(item.id || "")),
        ...(body.models || []).map((item) => typeof item === "string" ? item : String(item.id || "")),
      ]);
      return { models, source: `${baseUrl.replace(/\/$/, "")}/models` };
    }
    if (template.type === "ollama") {
      const baseUrl = String(providerOptions?.baseUrl || defaultBaseUrlForTemplate(template));
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return { models: [], source: "built-in registry" };
      const body = await response.json() as { models?: Array<{ name?: unknown }> };
      const models = uniqueStrings((body.models || []).map((item) => String(item.name || "")));
      return { models, source: `${baseUrl.replace(/\/$/, "")}/api/tags` };
    }
  } catch {
    return { models: [], source: "built-in registry" };
  }
  return { models: [], source: "built-in registry" };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

async function configureApiKey({
  dataDir,
  input,
  output,
  rl,
  template,
  apiKeyEnv,
}: {
  dataDir: string;
  input: Readable;
  output: Writable;
  rl: readline.Interface;
  template: ProviderTemplate;
  apiKeyEnv: string;
}): Promise<void> {
  const existing = process.env[apiKeyEnv] || "";
  const label = `${providerApiKeyLabel(template)} API key`;
  const hint = existing
    ? `already set ${maskSecret(existing)}, Enter to keep`
    : `saved as ${apiKeyEnv}, Enter to skip`;
  const apiKey = await secretQuestion(rl, input, output, `${label} [${hint}]`);
  if (apiKey) {
    await upsertEnvValue(dataDir, apiKeyEnv, apiKey);
    process.env[apiKeyEnv] = apiKey;
    writeLine(output, `${label}: saved to ${apiKeyEnv}`);
    return;
  }
  if (existing) {
    writeLine(output, `${label}: using ${apiKeyEnv}`);
    return;
  }
  writeLine(output, `${label}: skipped; set ${apiKeyEnv} before using this provider`);
}

function providerApiKeyLabel(template: ProviderTemplate): string {
  return template.label.replace(/\s*\([^)]*\)\s*$/, "");
}

async function secretQuestion(
  rl: readline.Interface,
  input: Readable,
  output: Writable,
  prompt: string,
): Promise<string> {
  if (!canUseInteractiveSelect(input, output)) {
    return (await rl.question(`${prompt}: `)).trim();
  }

  const ttyInput = input as TtyReadable;
  let value = "";
  let settled = false;
  const wasRaw = Boolean(ttyInput.isRaw);

  return new Promise<string>((resolve, reject) => {
    const render = (): void => {
      output.write(`\r\x1b[2K${prompt}: ${"*".repeat([...value].length)}`);
    };
    const cleanup = (resumeReadline: boolean): void => {
      input.off("keypress", onKeypress);
      if (ttyInput.setRawMode) ttyInput.setRawMode(wasRaw);
      input.pause();
      if (resumeReadline) rl.resume();
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      output.write("\n");
      cleanup(true);
      resolve(value.trim());
    };
    const abort = (): void => {
      if (settled) return;
      settled = true;
      output.write("\n");
      cleanup(false);
      reject(modelConfigAbortError());
    };
    const onKeypress = (text: string, key: Keypress = {}): void => {
      if (key.ctrl && key.name === "c") {
        abort();
        return;
      }
      if (key.name === "escape") {
        abort();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        if (!value.length) return;
        value = value.slice(0, -1);
        render();
        return;
      }
      if (text && text >= " " && text !== "\x7f") {
        value += text;
        render();
      }
    };

    rl.pause();
    emitKeypressEvents(input);
    if (ttyInput.setRawMode) ttyInput.setRawMode(true);
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
}

async function upsertEnvValue(dataDir: string, key: string, value: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const envPath = path.join(dataDir, ".env");
  let raw = "";
  try {
    raw = await readFile(envPath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const assignment = `${key}=${quoteEnvValue(value)}`;
  const lines = raw ? raw.split(/\r?\n/) : [];
  let replaced = false;
  const next = lines.map((line) => {
    if (line.match(new RegExp(`^${escapeRegExp(key)}=`))) {
      replaced = true;
      return assignment;
    }
    return line;
  }).filter((line, index, array) => line || index < array.length - 1);
  if (!replaced) next.push(assignment);
  await writeFile(envPath, `${next.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(envPath, 0o600).catch(() => undefined);
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultBaseUrlForTemplate(template: ProviderTemplate): string {
  if (template.baseUrl) return template.baseUrl;
  if (template.type === "ollama") return "http://127.0.0.1:11434";
  return "https://api.openai.com/v1";
}

function printProviders(output: Writable, providers: ProviderConfig[]): void {
  writeLine(output, "");
  writeLine(output, "Providers:");
  providers.forEach((provider, index) => {
    const disabled = provider.enabled === false ? " disabled" : "";
    writeLine(output, `  ${index + 1}. ${formatProvider(provider)}${disabled}`);
  });
  writeLine(output, "  new. Add a provider");
}

function renderSelectLines(prompt: string, choices: SelectChoice[], selectedIndex: number): string[] {
  const lines = [
    "",
    style(`Select ${prompt}:`, "amber"),
    `  ${style("↕", "dimGreen")} ${style("navigate", "dimGreen")}  ${style("ENTER/SPACE", "dimGreen")} ${style("select", "dimGreen")}  ${style("ESC", "dimGreen")} ${style("cancel", "dimGreen")}`,
    "",
  ];
  choices.forEach((choice, index) => {
    const selected = index === selectedIndex;
    const suffix = choice.description ? ` (${choice.description})` : "";
    const radio = selected ? "(●)" : "(○)";
    const pointer = selected ? "➜ " : "  ";
    const tail = selected ? "  ←" : "";
    const line = `${pointer}${radio} ${formatSelectedChoice(choice)}${suffix}${tail}`;
    lines.push(`  ${style(line, selected ? "cyan" : "green")}`);
  });
  return lines;
}

function formatSelectedChoice(choice: SelectChoice): string {
  return choice.label;
}

function clearRender(output: Writable, renderedLines: number): void {
  if (!renderedLines) return;
  output.write(`\x1b[${renderedLines}A\x1b[0J`);
}

function canUseInteractiveSelect(input: Readable, output: Writable): boolean {
  const ttyInput = input as TtyReadable;
  const ttyOutput = output as TtyWritable;
  return Boolean(ttyInput.isTTY && ttyOutput.isTTY && ttyInput.setRawMode);
}

function clampIndex(value: number, length: number): number {
  return Math.min(Math.max(0, value), Math.max(0, length - 1));
}

function printRoles(output: Writable, roles: RoleDefinition[], main: ProviderBinding): void {
  writeLine(output, "");
  writeLine(output, "Roles:");
  roles.forEach((role, index) => {
    const binding = role.provider
      ? `${role.provider} / ${role.model || "(provider default)"}`
      : `inherit ${main.providerId} / ${main.model}`;
    writeLine(output, `  ${index + 1}. ${role.name}  ${binding}`);
  });
}

function resolveRoles(roles: RoleDefinition[], answer: string): RoleDefinition[] {
  if (answer.trim().toLowerCase() === "all") return roles;
  const selected: RoleDefinition[] = [];
  for (const raw of answer.split(",")) {
    const value = raw.trim();
    if (!value) continue;
    const index = Number(value);
    const role = Number.isInteger(index)
      ? roles[index - 1]
      : roles.find((item) => item.name === value);
    if (role && !selected.includes(role)) selected.push(role);
  }
  return selected;
}

function replaceRole(roles: RoleDefinition[], updated: RoleDefinition): void {
  const index = roles.findIndex((role) => role.name === updated.name);
  if (index >= 0) roles[index] = updated;
}

async function question(rl: readline.Interface, prompt: string, fallback: string): Promise<string> {
  const answer = await rl.question(`${prompt} [${fallback}]: `);
  return answer.trim() || fallback;
}

async function yesNo(rl: readline.Interface, prompt: string, fallback: boolean): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  for (;;) {
    const answer = (await rl.question(`${prompt} [${suffix}]: `)).trim().toLowerCase();
    if (!answer) return fallback;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
  }
}

function modelConfigAbortError(): Error {
  return Object.assign(new Error("Model setup cancelled."), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function isModelConfigAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

function parseProviderType(value: string): ProviderType {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "ollama" || normalized === "echo") return normalized;
  throw new Error(`Unsupported provider type: ${value}`);
}

function defaultModelForType(type: ProviderType): string {
  if (type === "ollama") return "llama3.1";
  if (type === "echo") return "echo-local";
  return "gpt-4.1-mini";
}

function sanitizeProviderId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "provider";
}

function formatProvider(provider: ProviderConfig): string {
  return `${provider.id} (${provider.type}, ${provider.model || defaultModelForType(provider.type)})`;
}

function writeLine(output: Writable, line: string): void {
  output.write(`${line}\n`);
}

function supportsColor(): boolean {
  return Boolean((stdout as { isTTY?: boolean }).isTTY && !process.env.NO_COLOR);
}

function style(value: string, key: keyof typeof ANSI): string {
  if (!supportsColor()) return value;
  return `${ANSI[key]}${value}${ANSI.reset}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
