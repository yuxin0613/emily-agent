import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
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
    const main = await configureMainAgent(runtime, rl, output);
    await configureRoles(runtime, rl, output, main);
    writeLine(output, "");
    writeLine(output, "Model setup saved.");
  } finally {
    rl.close();
  }
}

async function configureMainAgent(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
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

  const binding = await configureProviderModel(runtime, rl, output, {
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
      const binding = await configureProviderModel(runtime, rl, output, {
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
    printProviders(output, runtime.listProviders());
    const providerAnswer = await question(rl, `${label} provider id, number, or new`, currentProviderId);
    const provider = await resolveProvider(runtime, rl, output, providerAnswer, idPrefix);
    if (!provider) {
      writeLine(output, `Unknown provider: ${providerAnswer}`);
      continue;
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

async function resolveProvider(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  output: Writable,
  answer: string,
  idPrefix: string,
): Promise<ProviderConfig | null> {
  const providers = runtime.listProviders();
  const value = answer.trim();
  if (value.toLowerCase() === "new" || value === "+") {
    return createProvider(runtime, rl, output, idPrefix);
  }
  const byIndex = Number(value);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= providers.length) {
    return providers[byIndex - 1];
  }
  const existing = providers.find((provider) => provider.id === value);
  if (existing) return existing;
  const create = await yesNo(rl, `Provider ${value} does not exist. Create it?`, false);
  return create ? createProvider(runtime, rl, output, value || idPrefix) : null;
}

async function createProvider(
  runtime: ModelConfigRuntime,
  rl: readline.Interface,
  output: Writable,
  idPrefix: string,
): Promise<ProviderConfig> {
  const type = parseProviderType(await question(rl, "Provider type: openai, ollama, or echo", "openai"));
  const id = sanitizeProviderId(await question(rl, "Provider id", `${sanitizeProviderId(idPrefix)}-${type}`));
  const model = await question(rl, "Provider default model", defaultModelForType(type));
  const config: ProviderConfig = {
    id,
    type,
    model,
    enabled: true,
    config: await providerConfigForType(type, rl),
  };
  const saved = await runtime.addProvider(config);
  writeLine(output, `Provider saved: ${saved.id}`);
  return saved;
}

async function providerConfigForType(type: ProviderType, rl: readline.Interface): Promise<ProviderConfig["config"]> {
  if (type === "openai") {
    const apiKeyEnv = await question(rl, "API key environment variable", "OPENAI_API_KEY");
    const baseUrl = await question(rl, "OpenAI-compatible base URL", "https://api.openai.com/v1");
    return {
      apiKeyEnv,
      baseUrl,
      strictJson: true,
      maxRetries: 2,
    };
  }
  if (type === "ollama") {
    const baseUrl = await question(rl, "Ollama base URL", "http://127.0.0.1:11434");
    return { baseUrl };
  }
  return undefined;
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
