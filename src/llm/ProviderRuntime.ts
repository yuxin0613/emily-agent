import type { ModelCompleteInput, ModelCompleteResult, ModelProvider, ProviderConfig, ProviderErrorCode } from "./ModelProvider.ts";
import { ProviderCallError } from "./ModelProvider.ts";

interface CircuitState {
  failures: number;
  openedUntil: number;
}

const circuitStates = new Map<string, CircuitState>();

export class ResilientModelProvider implements ModelProvider {
  id: string;
  model: string;
  private inner: ModelProvider;
  private config: ProviderConfig;

  constructor(inner: ModelProvider, config: ProviderConfig) {
    this.inner = inner;
    this.config = config;
    this.id = inner.id;
    this.model = inner.model;
  }

  async complete(input: ModelCompleteInput): Promise<ModelCompleteResult> {
    if (this.config.enabled === false) {
      throw new ProviderCallError({
        providerId: this.id,
        code: "provider_disabled",
        message: `Provider ${this.id} is disabled.`,
      });
    }

    const state = getCircuitState(this.id);
    const now = Date.now();
    if (state.openedUntil > now) {
      throw new ProviderCallError({
        providerId: this.id,
        code: "circuit_open",
        message: `Provider ${this.id} circuit is open until ${new Date(state.openedUntil).toISOString()}.`,
      });
    }
    if (state.openedUntil && state.openedUntil <= now) {
      state.openedUntil = 0;
    }

    const startedAt = Date.now();
    const maxRetries = boundedNumber(this.config.config?.maxRetries, 1, 0, 5);
    const retryBaseMs = boundedNumber(this.config.config?.retryBaseMs, 200, 1, 60000);
    const retryMaxMs = boundedNumber(this.config.config?.retryMaxMs, 5000, retryBaseMs, 120000);
    let lastError: ProviderCallError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const result = normalizeModelCompleteResult(await this.inner.complete(input), this.inner);
        if (!result.content.trim()) {
          throw new ProviderCallError({
            providerId: this.id,
            code: "empty_response",
            message: `Provider ${this.id} returned an empty response.`,
          });
        }
        recordProviderSuccess(this.id);
        return {
          ...result,
          latencyMs: result.latencyMs ?? Date.now() - startedAt,
          attempts: attempt + 1,
          providerId: this.id,
          model: this.model,
        };
      } catch (error) {
        lastError = normalizeProviderError(error, this.id);
        if (!lastError.retryable || attempt >= maxRetries) {
          recordProviderFailure(this.id, this.config);
          throw lastError;
        }
        await sleep(backoffMs(attempt, retryBaseMs, retryMaxMs));
      }
    }

    throw lastError || new ProviderCallError({
      providerId: this.id,
      code: "unknown_error",
      message: `Provider ${this.id} failed for an unknown reason.`,
    });
  }
}

export function normalizeModelCompleteResult(result: string | ModelCompleteResult, provider: ModelProvider): ModelCompleteResult {
  if (typeof result === "string") {
    return {
      content: result,
      providerId: provider.id,
      model: provider.model,
    };
  }
  return {
    ...result,
    providerId: result.providerId || provider.id,
    model: result.model || provider.model,
  };
}

export function classifyHttpStatus(status: number): { code: ProviderErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "auth_error", retryable: false };
  if (status === 408) return { code: "timeout", retryable: true };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "server_error", retryable: true };
  if (status >= 400) return { code: "bad_request", retryable: false };
  return { code: "unknown_error", retryable: false };
}

export function normalizeProviderError(error: unknown, providerId: string): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderCallError({
      providerId,
      code: "timeout",
      message: `Provider ${providerId} timed out.`,
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof TypeError) {
    return new ProviderCallError({
      providerId,
      code: "network_error",
      message: error.message,
      retryable: true,
      cause: error,
    });
  }
  return new ProviderCallError({
    providerId,
    code: "unknown_error",
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function isProviderCircuitOpen(providerId: string, now = Date.now()): boolean {
  return (circuitStates.get(providerId)?.openedUntil || 0) > now;
}

export function resetProviderCircuit(providerId?: string): void {
  if (providerId) {
    circuitStates.delete(providerId);
    return;
  }
  circuitStates.clear();
}

function recordProviderSuccess(providerId: string): void {
  circuitStates.set(providerId, { failures: 0, openedUntil: 0 });
}

function recordProviderFailure(providerId: string, config: ProviderConfig): void {
  const state = getCircuitState(providerId);
  state.failures += 1;
  const threshold = boundedNumber(config.config?.circuitBreakerFailureThreshold, 5, 1, 100);
  if (state.failures >= threshold) {
    state.openedUntil = Date.now() + boundedNumber(config.config?.circuitBreakerCooldownMs, 60000, 1000, 60 * 60 * 1000);
  }
}

function getCircuitState(providerId: string): CircuitState {
  const existing = circuitStates.get(providerId);
  if (existing) return existing;
  const created = { failures: 0, openedUntil: 0 };
  circuitStates.set(providerId, created);
  return created;
}

function backoffMs(attempt: number, retryBaseMs: number, retryMaxMs: number): number {
  return Math.min(retryMaxMs, retryBaseMs * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
