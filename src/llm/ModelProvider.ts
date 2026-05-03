export interface ModelCompleteInput {
  agent: string;
  role: string;
  prompt: string;
}

export interface ModelProvider {
  id: string;
  model: string;
  complete(input: ModelCompleteInput): Promise<string>;
}

export type ProviderType = "echo" | "openai" | "ollama";
export type ProviderFallbackMode = "strict" | "fallback";

export interface ProviderConfig {
  id: string;
  type: ProviderType;
  model?: string;
  config?: {
    baseUrl?: string;
    apiKeyEnv?: string;
    temperature?: number;
    timeoutMs?: number;
  };
}

export interface ProviderHealth {
  id: string;
  type: ProviderType;
  model: string;
  ok: boolean;
  reason?: string;
  deepChecked: boolean;
}
