import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EchoModelProvider } from "./EchoModelProvider.ts";
import type { ModelProvider, ProviderConfig, ProviderFallbackMode, ProviderHealth } from "./ModelProvider.ts";
import { OllamaModelProvider } from "./OllamaModelProvider.ts";
import { OpenAIModelProvider } from "./OpenAIModelProvider.ts";
import type { RoleDefinition } from "../types.ts";

interface ProviderFile {
  defaultProviderId: string;
  fallbackMode?: ProviderFallbackMode;
  providers: ProviderConfig[];
}

export class ProviderRegistry {
  providers: Map<string, ProviderConfig>;
  defaultProviderId: string;
  fallbackMode: ProviderFallbackMode;

  static async create({
    dataDir,
    providers,
    defaultProviderId = "echo",
    fallbackMode = "strict",
    persist = true,
  }: {
    dataDir: string;
    providers?: ProviderConfig[];
    defaultProviderId?: string;
    fallbackMode?: ProviderFallbackMode;
    persist?: boolean;
  }): Promise<ProviderRegistry> {
    const filePath = providerConfigPath(dataDir);
    const loaded = providers
      ? { defaultProviderId, fallbackMode, providers }
      : await readProviderFile(filePath) || defaultProviderFile(defaultProviderId);
    const registry = new ProviderRegistry({
      providers: loaded.providers,
      defaultProviderId: loaded.defaultProviderId || defaultProviderId,
      fallbackMode: loaded.fallbackMode || fallbackMode,
    });
    registry.ensureDefault();
    if (persist) await registry.write(dataDir);
    return registry;
  }

  constructor({ providers, defaultProviderId = "echo", fallbackMode = "strict" }: { providers: ProviderConfig[]; defaultProviderId?: string; fallbackMode?: ProviderFallbackMode }) {
    this.providers = new Map(providers.map((provider) => {
      validateProviderConfig(provider);
      return [provider.id, cloneProviderConfig(provider)];
    }));
    this.defaultProviderId = defaultProviderId;
    this.fallbackMode = fallbackMode;
  }

  ensureDefault(): void {
    if (!this.providers.has(this.defaultProviderId)) {
      this.providers.set(this.defaultProviderId, {
        id: this.defaultProviderId,
        type: "echo",
        model: "echo-local",
      });
    }
  }

  list(): ProviderConfig[] {
    return [...this.providers.values()].map(cloneProviderConfig);
  }

  getConfig(providerId?: string | null): ProviderConfig {
    const id = providerId || this.defaultProviderId;
    const config = this.providers.get(id);
    if (!config) throw new Error(`Unknown model provider: ${id}`);
    return cloneProviderConfig(config);
  }

  resolveConfig(providerId?: string | null, options: {
    fallbackMode?: ProviderFallbackMode;
    onFallback?: (input: { requestedProviderId: string; fallbackProviderId: string; reason: string }) => void;
  } = {}): ProviderConfig {
    const id = providerId || this.defaultProviderId;
    const config = this.providers.get(id);
    if (config) return cloneProviderConfig(config);

    const mode = options.fallbackMode || this.fallbackMode;
    if (mode === "fallback") {
      const fallback = this.getConfig(this.defaultProviderId);
      options.onFallback?.({
        requestedProviderId: id,
        fallbackProviderId: fallback.id,
        reason: `Unknown model provider: ${id}`,
      });
      return fallback;
    }

    throw new Error(`Unknown model provider: ${id}`);
  }

  createProvider(providerId?: string | null, overrides: { model?: string; temperature?: number } = {}, options: {
    fallbackMode?: ProviderFallbackMode;
    onFallback?: (input: { requestedProviderId: string; fallbackProviderId: string; reason: string }) => void;
  } = {}): ModelProvider {
    const config = this.withOverrides(this.resolveConfig(providerId, options), overrides);
    if (config.type === "echo") return new EchoModelProvider({ id: config.id, model: config.model || "echo-local" });
    if (config.type === "openai") return new OpenAIModelProvider(config);
    if (config.type === "ollama") return new OllamaModelProvider(config);
    throw new Error(`Unsupported provider type: ${(config as ProviderConfig).type}`);
  }

  createForRole(definition: RoleDefinition, options: {
    fallbackMode?: ProviderFallbackMode;
    onFallback?: (input: { requestedProviderId: string; fallbackProviderId: string; reason: string }) => void;
  } = {}): ModelProvider {
    return this.createProvider(definition.provider, {
      model: definition.model,
      temperature: definition.temperature,
    }, options);
  }

  add(config: ProviderConfig): void {
    validateProviderConfig(config);
    this.providers.set(config.id, cloneProviderConfig(config));
  }

  async health({ deep = false }: { deep?: boolean } = {}): Promise<ProviderHealth[]> {
    const checks: ProviderHealth[] = [];
    for (const config of this.list()) {
      checks.push(await this.checkProvider(config, { deep }));
    }
    return checks;
  }

  async write(dataDir: string): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(providerConfigPath(dataDir), JSON.stringify({
      defaultProviderId: this.defaultProviderId,
      fallbackMode: this.fallbackMode,
      providers: this.list(),
    }, null, 2), "utf8");
  }

  private withOverrides(config: ProviderConfig, overrides: { model?: string; temperature?: number }): ProviderConfig {
    return {
      ...config,
      model: overrides.model || config.model,
      config: {
        ...(config.config || {}),
        ...(typeof overrides.temperature === "number" ? { temperature: overrides.temperature } : {}),
      },
    };
  }

  private async checkProvider(config: ProviderConfig, { deep }: { deep: boolean }): Promise<ProviderHealth> {
    if (config.type === "echo") {
      return { id: config.id, type: config.type, model: config.model || "echo-local", ok: true, deepChecked: false };
    }

    if (config.type === "openai") {
      const apiKeyEnv = config.config?.apiKeyEnv || "";
      const ok = Boolean(apiKeyEnv && process.env[apiKeyEnv]);
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok,
        reason: ok ? undefined : `Missing API key env ${apiKeyEnv || "(none)"}`,
        deepChecked: false,
      };
    }

    if (config.type === "ollama") {
      if (!deep) {
        return { id: config.id, type: config.type, model: config.model || "", ok: true, deepChecked: false };
      }
      try {
        const baseUrl = config.config?.baseUrl || "http://127.0.0.1:11434";
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`);
        return {
          id: config.id,
          type: config.type,
          model: config.model || "",
          ok: response.ok,
          reason: response.ok ? undefined : `Ollama responded ${response.status}`,
          deepChecked: true,
        };
      } catch (error) {
        return {
          id: config.id,
          type: config.type,
          model: config.model || "",
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
          deepChecked: true,
        };
      }
    }

    return { id: config.id, type: config.type, model: config.model || "", ok: false, reason: "Unsupported provider type", deepChecked: false };
  }
}

export function providerConfigPath(dataDir: string): string {
  return path.join(dataDir, "providers.json");
}

async function readProviderFile(filePath: string): Promise<ProviderFile | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProviderFile>;
    if (!Array.isArray(parsed.providers)) return null;
    return {
      defaultProviderId: parsed.defaultProviderId || "echo",
      fallbackMode: parsed.fallbackMode === "fallback" ? "fallback" : "strict",
      providers: parsed.providers,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function defaultProviderFile(defaultProviderId: string): ProviderFile {
  return {
    defaultProviderId,
    fallbackMode: "strict",
    providers: [{
      id: defaultProviderId,
      type: "echo",
      model: "echo-local",
    }],
  };
}

export function validateProviderConfig(config: ProviderConfig): void {
  if (!/^[A-Za-z0-9._-]+$/.test(config.id || "")) {
    throw new Error("Provider id must be non-empty and contain only letters, numbers, dot, underscore, or dash.");
  }
  if (config.type !== "echo" && config.type !== "openai" && config.type !== "ollama") {
    throw new Error(`Invalid provider type: ${config.type}`);
  }
  if (config.config && hasUnsafeSecretField(config.config)) {
    throw new Error("Provider config must not contain raw apiKey/authorization secrets; use apiKeyEnv instead.");
  }
  if (config.model !== undefined && !String(config.model).trim()) {
    throw new Error("Provider model must be non-empty when provided.");
  }
  if (config.type === "openai" && !config.config?.apiKeyEnv) {
    throw new Error("OpenAI provider requires config.apiKeyEnv.");
  }
  if (config.config?.temperature !== undefined && (config.config.temperature < 0 || config.config.temperature > 2)) {
    throw new Error("Provider temperature must be between 0 and 2.");
  }
  if (config.config?.timeoutMs !== undefined && (config.config.timeoutMs <= 0 || config.config.timeoutMs > 10 * 60 * 1000)) {
    throw new Error("Provider timeoutMs must be between 1 and 600000.");
  }
}

function hasUnsafeSecretField(config: Record<string, unknown>): boolean {
  return Object.keys(config).some((key) => /^(apiKey|authorization|token|secret)$/i.test(key));
}

function cloneProviderConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    config: config.config ? { ...config.config } : undefined,
  };
}
