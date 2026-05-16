import type { ProviderConfig } from "./ModelProvider.ts";

export const DEFAULT_PROVIDER_TIMEOUT_SECONDS = 60;
export const DEFAULT_RETRY_BASE_SECONDS = 0.2;
export const DEFAULT_RETRY_MAX_SECONDS = 5;
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_SECONDS = 60;

export function secondsToMilliseconds(value: unknown, fallbackSeconds: number): number {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : fallbackSeconds;
  return Math.max(1, Math.round(seconds * 1000));
}

export function providerTimeoutMs(config: ProviderConfig): number {
  return secondsToMilliseconds(config.config?.timeoutSeconds, DEFAULT_PROVIDER_TIMEOUT_SECONDS);
}

export function retryBaseMs(config: ProviderConfig): number {
  return secondsToMilliseconds(config.config?.retryBaseSeconds, DEFAULT_RETRY_BASE_SECONDS);
}

export function retryMaxMs(config: ProviderConfig, minimumMs: number): number {
  return Math.max(minimumMs, secondsToMilliseconds(config.config?.retryMaxSeconds, DEFAULT_RETRY_MAX_SECONDS));
}

export function circuitBreakerCooldownMs(config: ProviderConfig): number {
  return secondsToMilliseconds(config.config?.circuitBreakerCooldownSeconds, DEFAULT_CIRCUIT_BREAKER_COOLDOWN_SECONDS);
}
