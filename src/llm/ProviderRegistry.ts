import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { EchoModelProvider } from "./EchoModelProvider.ts";
import type { ModelProvider, ProviderConfig, ProviderFallbackMode, ProviderHealth } from "./ModelProvider.ts";
import { OllamaModelProvider } from "./OllamaModelProvider.ts";
import { OpenAIModelProvider } from "./OpenAIModelProvider.ts";
import { isProviderCircuitOpen, ResilientModelProvider } from "./ProviderRuntime.ts";
import type { ProviderUsageStore } from "./ProviderUsageStore.ts";
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
  usageStore?: ProviderUsageStore;

  static async create({
    dataDir,
    providers,
    defaultProviderId = "echo",
    fallbackMode = "strict",
    persist = true,
    usageStore,
  }: {
    dataDir: string;
    providers?: ProviderConfig[];
    defaultProviderId?: string;
    fallbackMode?: ProviderFallbackMode;
    persist?: boolean;
    usageStore?: ProviderUsageStore;
  }): Promise<ProviderRegistry> {
    const loaded = providers
      ? { defaultProviderId, fallbackMode, providers }
      : await readProviderConfig(dataDir, defaultProviderId);
    const registry = new ProviderRegistry({
      providers: loaded.providers,
      defaultProviderId: loaded.defaultProviderId || defaultProviderId,
      fallbackMode: loaded.fallbackMode || fallbackMode,
      usageStore,
    });
    registry.ensureDefault();
    if (persist) {
      await registry.write(dataDir);
      await removeLegacyProviderConfig(dataDir);
    }
    return registry;
  }

  constructor({ providers, defaultProviderId = "echo", fallbackMode = "strict", usageStore }: { providers: ProviderConfig[]; defaultProviderId?: string; fallbackMode?: ProviderFallbackMode; usageStore?: ProviderUsageStore }) {
    this.providers = new Map(providers.map((provider) => {
      validateProviderConfig(provider);
      return [provider.id, cloneProviderConfig(provider)];
    }));
    this.defaultProviderId = defaultProviderId;
    this.fallbackMode = fallbackMode;
    this.usageStore = usageStore;
  }

  ensureDefault(): void {
    if (!this.providers.has(this.defaultProviderId)) {
      this.providers.set(this.defaultProviderId, {
        id: this.defaultProviderId,
        type: "echo",
        model: "echo-local",
        enabled: true,
      });
    }
  }

  list(): ProviderConfig[] {
    return [...this.providers.values()].map(cloneProviderConfig);
  }

  getConfig(providerId?: string | null): ProviderConfig {
    const config = this.getConfigIncludingDisabled(providerId);
    if (config.enabled === false) throw new Error(`Model provider is disabled: ${config.id}`);
    return config;
  }

  getConfigIncludingDisabled(providerId?: string | null): ProviderConfig {
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
    if (config && config.enabled !== false) return cloneProviderConfig(config);

    const mode = options.fallbackMode || this.fallbackMode;
    if (mode === "fallback" && id !== this.defaultProviderId) {
      const fallback = this.getConfig(this.defaultProviderId);
      options.onFallback?.({
        requestedProviderId: id,
        fallbackProviderId: fallback.id,
        reason: config?.enabled === false ? `Model provider is disabled: ${id}` : `Unknown model provider: ${id}`,
      });
      return fallback;
    }

    if (config?.enabled === false) throw new Error(`Model provider is disabled: ${id}`);
    throw new Error(`Unknown model provider: ${id}`);
  }

  createProvider(providerId?: string | null, overrides: { model?: string; temperature?: number } = {}, options: {
    fallbackMode?: ProviderFallbackMode;
    onFallback?: (input: { requestedProviderId: string; fallbackProviderId: string; reason: string }) => void;
  } = {}): ModelProvider {
    const config = this.withOverrides(this.resolveConfig(providerId, options), overrides);
    let provider: ModelProvider;
    if (config.type === "echo") provider = new EchoModelProvider({ id: config.id, model: config.model || "echo-local" });
    else if (config.type === "openai") provider = new OpenAIModelProvider(config);
    else if (config.type === "ollama") provider = new OllamaModelProvider(config);
    else throw new Error(`Unsupported provider type: ${(config as ProviderConfig).type}`);
    return new ResilientModelProvider(provider, config, { usageStore: this.usageStore });
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

  enable(providerId: string): ProviderConfig {
    const config = this.getConfigIncludingDisabled(providerId);
    config.enabled = true;
    validateProviderConfig(config);
    this.providers.set(providerId, cloneProviderConfig(config));
    return cloneProviderConfig(config);
  }

  disable(providerId: string, { referencedBy = [] }: { referencedBy?: string[] } = {}): ProviderConfig {
    this.assertProviderCanBeRemovedOrDisabled(providerId, referencedBy, "disable");
    const config = this.getConfigIncludingDisabled(providerId);
    config.enabled = false;
    validateProviderConfig(config);
    this.providers.set(providerId, cloneProviderConfig(config));
    return cloneProviderConfig(config);
  }

  remove(providerId: string, { referencedBy = [] }: { referencedBy?: string[] } = {}): ProviderConfig {
    this.assertProviderCanBeRemovedOrDisabled(providerId, referencedBy, "remove");
    const config = this.getConfigIncludingDisabled(providerId);
    this.providers.delete(providerId);
    return config;
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
    const targetPath = providerConfigPath(dataDir);
    const tmpPath = path.join(dataDir, `.config.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmpPath, JSON.stringify({
      defaultProviderId: this.defaultProviderId,
      fallbackMode: this.fallbackMode,
      providers: this.list(),
    }, null, 2), "utf8");
    try {
      await rename(tmpPath, targetPath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
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
    if (config.enabled === false) {
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: false,
        reason: "Provider is disabled",
        deepChecked: false,
        disabled: true,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    }

    if (config.type === "echo") {
      return { id: config.id, type: config.type, model: config.model || "echo-local", ok: true, deepChecked: false, circuitOpen: isProviderCircuitOpen(config.id) };
    }

    if (config.type === "openai") {
      return this.checkOpenAIProvider(config, { deep });
    }

    if (config.type === "ollama") {
      return this.checkOllamaProvider(config, { deep });
    }

    return { id: config.id, type: config.type, model: config.model || "", ok: false, reason: "Unsupported provider type", deepChecked: false };
  }

  private async checkOpenAIProvider(config: ProviderConfig, { deep }: { deep: boolean }): Promise<ProviderHealth> {
    const apiKeyEnv = config.config?.apiKeyEnv || "";
    const ok = Boolean(apiKeyEnv && process.env[apiKeyEnv]);
    if (!ok || !deep) {
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok,
        reason: ok ? undefined : `Missing API key env ${apiKeyEnv || "(none)"}`,
        deepChecked: false,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    }
    try {
      const response = await fetchWithTimeout(`${(config.config?.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/models`, {
        headers: {
          authorization: `Bearer ${process.env[apiKeyEnv]}`,
        },
        timeoutMs: config.config?.timeoutMs || 60000,
      });
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: response.ok,
        reason: response.ok ? undefined : `OpenAI-compatible provider responded ${response.status}`,
        deepChecked: true,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    } catch (error) {
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        deepChecked: true,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    }
  }

  private async checkOllamaProvider(config: ProviderConfig, { deep }: { deep: boolean }): Promise<ProviderHealth> {
    if (!deep) {
      return { id: config.id, type: config.type, model: config.model || "", ok: true, deepChecked: false, circuitOpen: isProviderCircuitOpen(config.id) };
    }
    try {
      const baseUrl = config.config?.baseUrl || "http://127.0.0.1:11434";
      const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
        timeoutMs: config.config?.timeoutMs || 60000,
      });
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: response.ok,
        reason: response.ok ? undefined : `Ollama responded ${response.status}`,
        deepChecked: true,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    } catch (error) {
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        deepChecked: true,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    }
  }

  private assertProviderCanBeRemovedOrDisabled(providerId: string, referencedBy: string[], operation: "disable" | "remove"): void {
    this.getConfigIncludingDisabled(providerId);
    if (providerId === this.defaultProviderId) {
      throw new Error(`Cannot ${operation} default provider: ${providerId}`);
    }
    if (referencedBy.length) {
      throw new Error(`Cannot ${operation} provider ${providerId}; referenced by roles: ${referencedBy.join(", ")}`);
    }
  }
}

export function providerConfigPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

export function legacyProviderConfigPath(dataDir: string): string {
  return path.join(dataDir, "providers.json");
}

async function fetchWithTimeout(url: string, { headers = {}, timeoutMs }: { headers?: Record<string, string>; timeoutMs: number }): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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

async function readProviderConfig(dataDir: string, defaultProviderId: string): Promise<ProviderFile> {
  return await readProviderFile(providerConfigPath(dataDir))
    || await readProviderFile(legacyProviderConfigPath(dataDir))
    || defaultProviderFile(defaultProviderId);
}

async function removeLegacyProviderConfig(dataDir: string): Promise<void> {
  await unlink(legacyProviderConfigPath(dataDir)).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  });
}

function defaultProviderFile(defaultProviderId: string): ProviderFile {
  return {
    defaultProviderId,
    fallbackMode: "strict",
    providers: [{
      id: defaultProviderId,
      type: "echo",
      model: "echo-local",
      enabled: true,
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
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error("Provider enabled must be a boolean when provided.");
  }
  if (config.config) validateProviderConfigObject(config);
  if (config.model !== undefined && !String(config.model).trim()) {
    throw new Error("Provider model must be non-empty when provided.");
  }
  if (config.type === "openai" && !config.config?.apiKeyEnv) {
    throw new Error("OpenAI provider requires config.apiKeyEnv.");
  }
}

function validateProviderConfigObject(config: ProviderConfig): void {
  const value = config.config || {};
  if (hasUnsafeSecretField(value)) {
    throw new Error("Provider config must not contain raw apiKey/authorization secrets; use apiKeyEnv instead.");
  }
  const allowedKeys = new Set([
    "baseUrl",
    "apiKeyEnv",
    "temperature",
    "timeoutMs",
    "maxRetries",
    "retryBaseMs",
    "retryMaxMs",
    "circuitBreakerFailureThreshold",
    "circuitBreakerCooldownMs",
    "strictJson",
    "costPer1KInputTokens",
    "costPer1KOutputTokens",
    "maxCallsPerMinute",
    "maxCallsPerDay",
    "maxTokensPerDay",
    "maxCostUsdPerDay",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown provider config key: ${key}`);
  }
  if (value.baseUrl !== undefined) validateBaseUrl(String(value.baseUrl));
  if (value.apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value.apiKeyEnv))) {
    throw new Error("Provider apiKeyEnv must be a valid environment variable name.");
  }
  assertNumberRange(value.temperature, "temperature", 0, 2);
  assertNumberRange(value.timeoutMs, "timeoutMs", 1, 10 * 60 * 1000);
  assertNumberRange(value.maxRetries, "maxRetries", 0, 5);
  assertNumberRange(value.retryBaseMs, "retryBaseMs", 1, 60000);
  assertNumberRange(value.retryMaxMs, "retryMaxMs", 1, 120000);
  assertNumberRange(value.circuitBreakerFailureThreshold, "circuitBreakerFailureThreshold", 1, 100);
  assertNumberRange(value.circuitBreakerCooldownMs, "circuitBreakerCooldownMs", 1000, 60 * 60 * 1000);
  if (value.strictJson !== undefined && typeof value.strictJson !== "boolean") {
    throw new Error("Provider strictJson must be a boolean when provided.");
  }
  assertNumberRange(value.costPer1KInputTokens, "costPer1KInputTokens", 0, 1000);
  assertNumberRange(value.costPer1KOutputTokens, "costPer1KOutputTokens", 0, 1000);
  assertNumberRange(value.maxCallsPerMinute, "maxCallsPerMinute", 1, 100000);
  assertNumberRange(value.maxCallsPerDay, "maxCallsPerDay", 1, 10000000);
  assertNumberRange(value.maxTokensPerDay, "maxTokensPerDay", 1, 1000000000);
  assertNumberRange(value.maxCostUsdPerDay, "maxCostUsdPerDay", 0, 1000000);
}

function assertNumberRange(value: unknown, key: string, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Provider ${key} must be between ${min} and ${max}.`);
  }
}

function validateBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Provider baseUrl must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Provider baseUrl protocol must be http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Provider baseUrl must not contain credentials.");
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
