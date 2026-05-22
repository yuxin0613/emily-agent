export const DEFAULT_ROLE_TASK_TIMEOUT_SECONDS = 3600;
export const MAX_ROLE_TASK_TIMEOUT_SECONDS = 24 * 60 * 60;
export const DEFAULT_ROLE_TASK_TIMEOUT_MS = DEFAULT_ROLE_TASK_TIMEOUT_SECONDS * 1000;
export const MAX_ROLE_TASK_TIMEOUT_MS = MAX_ROLE_TASK_TIMEOUT_SECONDS * 1000;

export function normalizeRoleTaskTimeoutMs(value: unknown, fallbackMs = DEFAULT_ROLE_TASK_TIMEOUT_MS): number {
  const fallback = boundedTimeoutMs(fallbackMs, DEFAULT_ROLE_TASK_TIMEOUT_MS);
  const input = typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
  return boundedTimeoutMs(input, fallback);
}

export function roleTaskExecutionTimeoutMs(value: unknown, configuredDefaultMs = DEFAULT_ROLE_TASK_TIMEOUT_MS): number {
  const fallback = normalizeRoleTaskTimeoutMs(configuredDefaultMs);
  const input = typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
  return Math.min(MAX_ROLE_TASK_TIMEOUT_MS, Math.max(fallback, input));
}

function boundedTimeoutMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(MAX_ROLE_TASK_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}
