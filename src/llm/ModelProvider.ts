export interface ModelCompleteInput {
  agent: string;
  role: string;
  prompt: string;
  taskId?: string;
  runId?: string;
  source?: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type ProviderErrorCode =
  | "auth_error"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "bad_request"
  | "empty_response"
  | "network_error"
  | "circuit_open"
  | "provider_disabled"
  | "quota_exceeded"
  | "unknown_error";

export type JsonData =
  | string
  | number
  | boolean
  | null
  | JsonData[]
  | { [key: string]: JsonData };

export type JsonOutputFormat = "json" | "json_extracted" | "wrapped_text";

export interface ModelCompleteResult {
  content: string;
  rawContent?: string;
  json?: JsonData;
  jsonFormat?: JsonOutputFormat;
  jsonWarnings?: string[];
  usage?: ModelUsage;
  latencyMs?: number;
  finishReason?: string;
  rawProvider?: ProviderType | string;
  attempts?: number;
  providerId?: string;
  model?: string;
  errorCode?: ProviderErrorCode;
  costUsd?: number;
  usageRecordId?: string;
}

export interface ModelProvider {
  id: string;
  model: string;
  complete(input: ModelCompleteInput): Promise<string | ModelCompleteResult>;
}

export type ProviderType = "echo" | "openai" | "ollama";
export type ProviderFallbackMode = "strict" | "fallback";

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  enabled?: boolean;
  model?: string;
  config?: {
    baseUrl?: string;
    apiKeyEnv?: string;
    temperature?: number;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    circuitBreakerFailureThreshold?: number;
    circuitBreakerCooldownMs?: number;
    strictJson?: boolean;
    costPer1KInputTokens?: number;
    costPer1KOutputTokens?: number;
    maxCallsPerMinute?: number;
    maxCallsPerDay?: number;
    maxTokensPerDay?: number;
    maxCostUsdPerDay?: number;
  };
}

export interface ProviderHealth {
  id: string;
  type: ProviderType;
  model: string;
  ok: boolean;
  reason?: string;
  deepChecked: boolean;
  disabled?: boolean;
  circuitOpen?: boolean;
}

export class ProviderCallError extends Error {
  code: ProviderErrorCode;
  providerId: string;
  status?: number;
  retryable: boolean;

  constructor({
    providerId,
    code,
    message,
    status,
    retryable = false,
    cause,
  }: {
    providerId: string;
    code: ProviderErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(message);
    this.name = "ProviderCallError";
    this.providerId = providerId;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}
