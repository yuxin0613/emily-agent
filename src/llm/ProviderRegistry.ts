import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { EchoModelProvider } from "./EchoModelProvider.ts";
import type { ModelProvider, ProviderConfig, ProviderFallbackMode, ProviderHealth } from "./ModelProvider.ts";
import { OllamaModelProvider } from "./OllamaModelProvider.ts";
import { OpenAIModelProvider } from "./OpenAIModelProvider.ts";
import { CodexModelProvider, codexResponsesUrl } from "./CodexModelProvider.ts";
import { readCodexAuthCredentials } from "./CodexAuth.ts";
import { isProviderCircuitOpen, ResilientModelProvider } from "./ProviderRuntime.ts";
import {
  DEFAULT_PROVIDER_TIMEOUT_SECONDS,
  providerTimeoutMs,
} from "./ProviderTiming.ts";
import type { ProviderUsageStore } from "./ProviderUsageStore.ts";
import type { RoleDefinition } from "../types.ts";
import { DEFAULT_ROLE_TASK_TIMEOUT_SECONDS, MAX_ROLE_TASK_TIMEOUT_SECONDS } from "../runtime/RoleTaskTimeout.ts";

export interface RuntimeSettings {
  defaultProviderId: string;
  fallbackMode?: ProviderFallbackMode;
  toolCallTimeoutSeconds: number;
  providerTimeoutSeconds: number;
  agents: AgentRuntimeConfig;
  providers: ProviderConfig[];
}

export interface RuntimeSettingsUpdate {
  defaultProviderId?: unknown;
  fallbackMode?: unknown;
  toolCallTimeoutSeconds?: unknown;
  providerTimeoutSeconds?: unknown;
  agents?: unknown;
  providers?: unknown;
}

export const DEFAULT_TOOL_CALL_TIMEOUT_SECONDS = 3600;

export interface AgentRuntimeConfig {
  mainAgents: number;
  maxSubagentsPerRole: number;
  maxConcurrentSubagents: number;
  releaseSubagentsAfterTask: boolean;
  subagentIdleTtlSeconds: number;
  plannerTaskTimeoutSeconds: number;
  roleTaskTimeoutSeconds: number;
}

export class ProviderRegistry {
  providers: Map<string, ProviderConfig>;
  defaultProviderId: string;
  fallbackMode: ProviderFallbackMode;
  toolCallTimeoutSeconds: number;
  providerTimeoutSeconds: number;
  agents: AgentRuntimeConfig;
  usageStore?: ProviderUsageStore;
  private persistedSnapshot: RuntimeSettings;

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
    const persistedSnapshot = await readProviderConfig(dataDir, defaultProviderId);
    const loaded = providers
      ? {
          defaultProviderId,
          fallbackMode,
          toolCallTimeoutSeconds: persistedSnapshot.toolCallTimeoutSeconds,
          providerTimeoutSeconds: persistedSnapshot.providerTimeoutSeconds,
          agents: persistedSnapshot.agents,
          providers,
        }
      : persistedSnapshot;
    const registry = new ProviderRegistry({
      providers: loaded.providers,
      defaultProviderId: loaded.defaultProviderId || defaultProviderId,
      fallbackMode: loaded.fallbackMode || fallbackMode,
      usageStore,
      persistedSnapshot,
    });
    registry.ensureDefault();
    if (persist) {
      await registry.write(dataDir);
      await removeLegacyProviderConfig(dataDir);
    }
    return registry;
  }

  constructor({
    providers,
    defaultProviderId = "echo",
    fallbackMode = "strict",
    usageStore,
    persistedSnapshot,
  }: {
    providers: ProviderConfig[];
    defaultProviderId?: string;
    fallbackMode?: ProviderFallbackMode;
    usageStore?: ProviderUsageStore;
    persistedSnapshot?: RuntimeSettings;
  }) {
    this.providers = new Map(providers.map((provider) => {
      const normalized = normalizeProviderConfig(provider);
      validateProviderConfig(normalized);
      return [normalized.id, cloneProviderConfig(normalized)];
    }));
    this.defaultProviderId = defaultProviderId;
    this.fallbackMode = fallbackMode;
    this.toolCallTimeoutSeconds = persistedSnapshot?.toolCallTimeoutSeconds || DEFAULT_TOOL_CALL_TIMEOUT_SECONDS;
    this.providerTimeoutSeconds = persistedSnapshot?.providerTimeoutSeconds || DEFAULT_PROVIDER_TIMEOUT_SECONDS;
    this.agents = normalizeAgentRuntimeConfig(persistedSnapshot?.agents);
    this.usageStore = usageStore;
    this.persistedSnapshot = cloneProviderFile(persistedSnapshot || {
      defaultProviderId,
      fallbackMode,
      toolCallTimeoutSeconds: this.toolCallTimeoutSeconds,
      providerTimeoutSeconds: this.providerTimeoutSeconds,
      agents: this.agents,
      providers,
    });
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
    else if (config.type === "codex") provider = new CodexModelProvider(config);
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
    const normalized = normalizeProviderConfig(config);
    validateProviderConfig(normalized);
    this.providers.set(normalized.id, cloneProviderConfig(normalized));
  }

  enable(providerId: string): ProviderConfig {
    const config = this.getConfigIncludingDisabled(providerId);
    config.enabled = true;
    const normalized = normalizeProviderConfig(config);
    validateProviderConfig(normalized);
    this.providers.set(providerId, cloneProviderConfig(normalized));
    return cloneProviderConfig(normalized);
  }

  disable(providerId: string, { referencedBy = [] }: { referencedBy?: string[] } = {}): ProviderConfig {
    this.assertProviderCanBeRemovedOrDisabled(providerId, referencedBy, "disable");
    const config = this.getConfigIncludingDisabled(providerId);
    config.enabled = false;
    const normalized = normalizeProviderConfig(config);
    validateProviderConfig(normalized);
    this.providers.set(providerId, cloneProviderConfig(normalized));
    return cloneProviderConfig(normalized);
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
    const desired = this.toProviderFile();
    await withProviderConfigLock(dataDir, async () => {
      const disk = await readProviderConfig(dataDir, desired.defaultProviderId);
      const merged = mergeProviderFiles({
        base: this.persistedSnapshot,
        desired,
        disk,
      });
      await writeProviderFileUnlocked(dataDir, targetPath, merged);
      this.applyProviderFile(merged);
      this.persistedSnapshot = cloneProviderFile(merged);
    });
  }

  getSettings(): RuntimeSettings {
    return cloneProviderFile(this.toProviderFile());
  }

  updateSettings(input: RuntimeSettingsUpdate = {}): RuntimeSettings {
    const next = this.toProviderFile();
    if (Object.prototype.hasOwnProperty.call(input, "defaultProviderId")) {
      next.defaultProviderId = requiredConfigString(input.defaultProviderId, "defaultProviderId");
    }
    if (Object.prototype.hasOwnProperty.call(input, "fallbackMode")) {
      next.fallbackMode = parseFallbackMode(input.fallbackMode);
    }
    if (Object.prototype.hasOwnProperty.call(input, "toolCallTimeoutSeconds")) {
      next.toolCallTimeoutSeconds = normalizeToolCallTimeoutSeconds(input.toolCallTimeoutSeconds);
    }
    if (Object.prototype.hasOwnProperty.call(input, "providerTimeoutSeconds")) {
      next.providerTimeoutSeconds = normalizeProviderTimeoutSeconds(input.providerTimeoutSeconds);
    }
    if (Object.prototype.hasOwnProperty.call(input, "agents")) {
      const agents = input.agents && typeof input.agents === "object" && !Array.isArray(input.agents)
        ? input.agents as Partial<AgentRuntimeConfig>
        : {};
      next.agents = normalizeAgentRuntimeConfig({ ...next.agents, ...agents });
    }
    if (Object.prototype.hasOwnProperty.call(input, "providers")) {
      if (!Array.isArray(input.providers)) throw new Error("Settings providers must be an array.");
      next.providers = input.providers.map((provider) => {
        if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
          throw new Error("Settings providers must contain provider objects.");
        }
        const normalized = normalizeProviderConfig(provider as ProviderConfig);
        validateProviderConfig(normalized);
        return cloneProviderConfig(normalized);
      });
    }
    if (!next.providers.some((provider) => provider.id === next.defaultProviderId)) {
      throw new Error(`Default provider is not configured: ${next.defaultProviderId}`);
    }
    this.applyProviderFile(next);
    return this.getSettings();
  }

  private toProviderFile(): RuntimeSettings {
    return {
      defaultProviderId: this.defaultProviderId,
      fallbackMode: this.fallbackMode,
      toolCallTimeoutSeconds: this.toolCallTimeoutSeconds,
      providerTimeoutSeconds: this.providerTimeoutSeconds,
      agents: this.agents,
      providers: this.list(),
    };
  }

  private applyProviderFile(file: RuntimeSettings): void {
    this.defaultProviderId = file.defaultProviderId;
    this.fallbackMode = file.fallbackMode || "strict";
    this.toolCallTimeoutSeconds = normalizeToolCallTimeoutSeconds(file.toolCallTimeoutSeconds);
    this.providerTimeoutSeconds = normalizeProviderTimeoutSeconds(file.providerTimeoutSeconds);
    this.agents = normalizeAgentRuntimeConfig(file.agents);
    this.providers = new Map(file.providers.map((provider) => {
      const normalized = normalizeProviderConfig(provider);
      validateProviderConfig(normalized);
      return [normalized.id, cloneProviderConfig(normalized)];
    }));
  }

  private withOverrides(config: ProviderConfig, overrides: { model?: string; temperature?: number }): ProviderConfig {
    return {
      ...config,
      model: overrides.model || config.model,
      config: {
        ...(config.config || {}),
        timeoutSeconds: config.config?.timeoutSeconds ?? this.providerTimeoutSeconds,
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

    if (config.type === "codex") {
      return this.checkCodexProvider(config, { deep });
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
        timeoutMs: providerTimeoutMs(config, this.providerTimeoutSeconds),
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
        timeoutMs: providerTimeoutMs(config, this.providerTimeoutSeconds),
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

  private async checkCodexProvider(config: ProviderConfig, { deep }: { deep: boolean }): Promise<ProviderHealth> {
    let credentials: Awaited<ReturnType<typeof readCodexAuthCredentials>>;
    try {
      credentials = await readCodexAuthCredentials(config.config?.authJsonPath, config.id);
    } catch (error) {
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        deepChecked: false,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    }

    if (!deep) {
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: true,
        deepChecked: false,
        circuitOpen: isProviderCircuitOpen(config.id),
      };
    }

    try {
      const response = await fetchWithTimeout(codexResponsesUrl(config.config?.baseUrl || "https://chatgpt.com/backend-api/codex"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.accessToken}`,
          "ChatGPT-Account-ID": credentials.accountId,
          originator: "codex_cli_rs",
          "user-agent": "emily-agent",
        },
        body: JSON.stringify({
          model: config.model || "gpt-5.5",
          input: "Reply with the exact text: provider health ok",
        }),
        timeoutMs: providerTimeoutMs(config, this.providerTimeoutSeconds),
      });
      return {
        id: config.id,
        type: config.type,
        model: config.model || "",
        ok: response.ok,
        reason: response.ok ? undefined : `Codex provider responded ${response.status}`,
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

async function fetchWithTimeout(
  url: string,
  {
    headers = {},
    timeoutMs,
    method = "GET",
    body,
  }: {
    headers?: Record<string, string>;
    timeoutMs: number;
    method?: string;
    body?: string;
  },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readProviderFile(filePath: string): Promise<RuntimeSettings | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
    if (!Array.isArray(parsed.providers)) return null;
    return {
      defaultProviderId: parsed.defaultProviderId || "echo",
      fallbackMode: parsed.fallbackMode === "fallback" ? "fallback" : "strict",
      toolCallTimeoutSeconds: normalizeToolCallTimeoutSeconds(parsed.toolCallTimeoutSeconds),
      providerTimeoutSeconds: normalizeProviderTimeoutSeconds(parsed.providerTimeoutSeconds),
      agents: normalizeAgentRuntimeConfig(parsed.agents),
      providers: parsed.providers.map((provider) => normalizeProviderConfig(provider as ProviderConfig)),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readProviderConfig(dataDir: string, defaultProviderId: string): Promise<RuntimeSettings> {
  return await readProviderFile(providerConfigPath(dataDir))
    || await readProviderFile(legacyProviderConfigPath(dataDir))
    || defaultProviderFile(defaultProviderId);
}

async function writeProviderFileUnlocked(dataDir: string, targetPath: string, file: RuntimeSettings): Promise<void> {
  const tmpPath = path.join(dataDir, `.config.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(file, null, 2), "utf8");
    await rename(tmpPath, targetPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

function mergeProviderFiles({
  base,
  desired,
  disk,
}: {
  base: RuntimeSettings;
  desired: RuntimeSettings;
  disk: RuntimeSettings;
}): RuntimeSettings {
  const baseProviders = providerMap(base.providers);
  const desiredProviders = providerMap(desired.providers);
  const mergedProviders = providerMap(disk.providers);

  if (desired.defaultProviderId !== base.defaultProviderId) {
    disk.defaultProviderId = desired.defaultProviderId;
  }
  if ((desired.fallbackMode || "strict") !== (base.fallbackMode || "strict")) {
    disk.fallbackMode = desired.fallbackMode || "strict";
  }
  if (desired.toolCallTimeoutSeconds !== base.toolCallTimeoutSeconds) {
    disk.toolCallTimeoutSeconds = desired.toolCallTimeoutSeconds;
  }
  if (desired.providerTimeoutSeconds !== base.providerTimeoutSeconds) {
    disk.providerTimeoutSeconds = desired.providerTimeoutSeconds;
  }
  if (!sameAgentRuntimeConfig(desired.agents, base.agents)) {
    disk.agents = desired.agents;
  }

  for (const [id, provider] of desiredProviders) {
    const previous = baseProviders.get(id);
    if (!previous || !sameProviderConfig(previous, provider)) {
      mergedProviders.set(id, cloneProviderConfig(provider));
    }
  }

  for (const id of baseProviders.keys()) {
    if (!desiredProviders.has(id)) {
      mergedProviders.delete(id);
    }
  }

  let defaultProviderId = disk.defaultProviderId || desired.defaultProviderId || "echo";
  if (!mergedProviders.has(defaultProviderId)) {
    const desiredDefault = desiredProviders.get(desired.defaultProviderId);
    if (desiredDefault) {
      defaultProviderId = desired.defaultProviderId;
      mergedProviders.set(defaultProviderId, cloneProviderConfig(desiredDefault));
    } else {
      const fallbackProvider = mergedProviders.values().next().value as ProviderConfig | undefined;
      if (fallbackProvider) defaultProviderId = fallbackProvider.id;
      else {
        defaultProviderId = "echo";
        mergedProviders.set("echo", {
          id: "echo",
          type: "echo",
          model: "echo-local",
          enabled: true,
        });
      }
    }
  }

  const merged: RuntimeSettings = {
    defaultProviderId,
    fallbackMode: disk.fallbackMode === "fallback" ? "fallback" : "strict",
    toolCallTimeoutSeconds: normalizeToolCallTimeoutSeconds(disk.toolCallTimeoutSeconds ?? desired.toolCallTimeoutSeconds),
    providerTimeoutSeconds: normalizeProviderTimeoutSeconds(disk.providerTimeoutSeconds ?? desired.providerTimeoutSeconds),
    agents: normalizeAgentRuntimeConfig(disk.agents ?? desired.agents),
    providers: [...mergedProviders.values()].map(cloneProviderConfig),
  };
  for (const provider of merged.providers) validateProviderConfig(provider);
  return merged;
}

function providerMap(providers: ProviderConfig[]): Map<string, ProviderConfig> {
  return new Map(providers.map((provider) => [provider.id, cloneProviderConfig(provider)]));
}

function sameProviderConfig(left: ProviderConfig, right: ProviderConfig): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameAgentRuntimeConfig(left: AgentRuntimeConfig, right: AgentRuntimeConfig): boolean {
  return stableJson(normalizeAgentRuntimeConfig(left)) === stableJson(normalizeAgentRuntimeConfig(right));
}

function cloneProviderFile(file: RuntimeSettings): RuntimeSettings {
  return {
    defaultProviderId: file.defaultProviderId || "echo",
    fallbackMode: file.fallbackMode === "fallback" ? "fallback" : "strict",
    toolCallTimeoutSeconds: normalizeToolCallTimeoutSeconds(file.toolCallTimeoutSeconds),
    providerTimeoutSeconds: normalizeProviderTimeoutSeconds(file.providerTimeoutSeconds),
    agents: normalizeAgentRuntimeConfig(file.agents),
    providers: file.providers.map(cloneProviderConfig),
  };
}

async function withProviderConfigLock<T>(dataDir: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${providerConfigPath(dataDir)}.lock`;
  const staleLockMs = 30_000;
  const deadline = Date.now() + 5000;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  while (!handle) {
    try {
      const acquired = await open(lockPath, "wx");
      try {
        await acquired.writeFile(JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }), "utf8");
        handle = acquired;
      } catch (error) {
        await acquired.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const current = await stat(lockPath).catch(() => null);
      if (current && Date.now() - current.mtimeMs > staleLockMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for provider config lock: ${lockPath}`);
      }
      await delay(25);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function removeLegacyProviderConfig(dataDir: string): Promise<void> {
  await unlink(legacyProviderConfigPath(dataDir)).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  });
}

function defaultProviderFile(defaultProviderId: string): RuntimeSettings {
  return {
    defaultProviderId,
    fallbackMode: "strict",
    toolCallTimeoutSeconds: DEFAULT_TOOL_CALL_TIMEOUT_SECONDS,
    providerTimeoutSeconds: DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    agents: defaultAgentRuntimeConfig(),
    providers: [{
      id: defaultProviderId,
      type: "echo",
      model: "echo-local",
      enabled: true,
    }],
  };
}

function defaultAgentRuntimeConfig(): AgentRuntimeConfig {
  const available = Math.max(1, availableParallelism());
  return {
    mainAgents: 1,
    maxSubagentsPerRole: 1,
    maxConcurrentSubagents: Math.max(1, Math.min(4, available - 1 || 1)),
    releaseSubagentsAfterTask: true,
    subagentIdleTtlSeconds: 60,
    plannerTaskTimeoutSeconds: 600,
    roleTaskTimeoutSeconds: DEFAULT_ROLE_TASK_TIMEOUT_SECONDS,
  };
}

function requiredConfigString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Config ${name} must be a non-empty string.`);
  }
  return value.trim();
}

function parseFallbackMode(value: unknown): ProviderFallbackMode {
  if (value === "strict" || value === "fallback") return value;
  throw new Error("Config fallbackMode must be strict or fallback.");
}

function normalizeToolCallTimeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TOOL_CALL_TIMEOUT_SECONDS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 24 * 60 * 60) {
    throw new Error("Config toolCallTimeoutSeconds must be an integer between 1 and 86400.");
  }
  return value;
}

function normalizeProviderTimeoutSeconds(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_PROVIDER_TIMEOUT_SECONDS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 24 * 60 * 60) {
    throw new Error("Config providerTimeoutSeconds must be an integer between 1 and 86400.");
  }
  return value;
}

export function normalizeAgentRuntimeConfig(value: unknown): AgentRuntimeConfig {
  const defaults = defaultAgentRuntimeConfig();
  const input = value && typeof value === "object" ? value as Partial<AgentRuntimeConfig> : {};
  const config = {
    mainAgents: numberConfig(input.mainAgents, defaults.mainAgents, "agents.mainAgents", 1, 1),
    maxSubagentsPerRole: numberConfig(input.maxSubagentsPerRole, defaults.maxSubagentsPerRole, "agents.maxSubagentsPerRole", 1, 1),
    maxConcurrentSubagents: numberConfig(input.maxConcurrentSubagents, defaults.maxConcurrentSubagents, "agents.maxConcurrentSubagents", 1, 64),
    releaseSubagentsAfterTask: typeof input.releaseSubagentsAfterTask === "boolean" ? input.releaseSubagentsAfterTask : defaults.releaseSubagentsAfterTask,
    subagentIdleTtlSeconds: numberConfig(input.subagentIdleTtlSeconds, defaults.subagentIdleTtlSeconds, "agents.subagentIdleTtlSeconds", 0, 24 * 60 * 60),
    plannerTaskTimeoutSeconds: numberConfig(input.plannerTaskTimeoutSeconds, defaults.plannerTaskTimeoutSeconds, "agents.plannerTaskTimeoutSeconds", 1, 24 * 60 * 60),
    roleTaskTimeoutSeconds: numberConfig(input.roleTaskTimeoutSeconds, defaults.roleTaskTimeoutSeconds, "agents.roleTaskTimeoutSeconds", 1, MAX_ROLE_TASK_TIMEOUT_SECONDS),
  };
  return config;
}

function numberConfig(value: unknown, fallback: number, name: string, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Config ${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function validateProviderConfig(config: ProviderConfig): void {
  config = normalizeProviderConfig(config);
  if (!/^[A-Za-z0-9._-]+$/.test(config.id || "")) {
    throw new Error("Provider id must be non-empty and contain only letters, numbers, dot, underscore, or dash.");
  }
  if (config.type !== "echo" && config.type !== "openai" && config.type !== "ollama" && config.type !== "codex") {
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
    "authJsonPath",
    "temperature",
    "timeoutSeconds",
    "maxRetries",
    "retryBaseSeconds",
    "retryMaxSeconds",
    "circuitBreakerFailureThreshold",
    "circuitBreakerCooldownSeconds",
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
  if (value.authJsonPath !== undefined && (typeof value.authJsonPath !== "string" || !value.authJsonPath.trim())) {
    throw new Error("Provider authJsonPath must be a non-empty string when provided.");
  }
  assertNumberRange(value.temperature, "temperature", 0, 2);
  assertNumberRange(value.timeoutSeconds, "timeoutSeconds", 1, 24 * 60 * 60);
  assertNumberRange(value.maxRetries, "maxRetries", 0, 5);
  assertNumberRange(value.retryBaseSeconds, "retryBaseSeconds", 0.001, 60);
  assertNumberRange(value.retryMaxSeconds, "retryMaxSeconds", 0.001, 120);
  assertNumberRange(value.circuitBreakerFailureThreshold, "circuitBreakerFailureThreshold", 1, 100);
  assertNumberRange(value.circuitBreakerCooldownSeconds, "circuitBreakerCooldownSeconds", 1, 60 * 60);
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

function normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
  const next: ProviderConfig = {
    ...config,
    config: config.config ? { ...config.config } : undefined,
  };
  if (!next.config) return next;
  const value = next.config as ProviderConfig["config"] & Record<string, unknown>;
  migrateMillisecondsConfig(value, "timeoutMs", "timeoutSeconds");
  migrateMillisecondsConfig(value, "retryBaseMs", "retryBaseSeconds");
  migrateMillisecondsConfig(value, "retryMaxMs", "retryMaxSeconds");
  migrateMillisecondsConfig(value, "circuitBreakerCooldownMs", "circuitBreakerCooldownSeconds");
  return next;
}

function migrateMillisecondsConfig(config: Record<string, unknown>, legacyKey: string, secondsKey: string): void {
  if (config[secondsKey] === undefined && typeof config[legacyKey] === "number" && Number.isFinite(config[legacyKey])) {
    config[secondsKey] = config[legacyKey] / 1000;
  }
  delete config[legacyKey];
}

function cloneProviderConfig(config: ProviderConfig): ProviderConfig {
  const normalized = normalizeProviderConfig(config);
  return {
    ...normalized,
    config: normalized.config ? { ...normalized.config } : undefined,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
