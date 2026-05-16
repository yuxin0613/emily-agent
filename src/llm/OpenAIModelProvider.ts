import type { ModelCompleteInput, ModelCompleteResult, ModelProvider, ProviderConfig } from "./ModelProvider.ts";
import { ProviderCallError } from "./ModelProvider.ts";
import { readJsonResponse, readResponseText } from "./HttpResponse.ts";
import { classifyHttpStatus } from "./ProviderRuntime.ts";
import { providerTimeoutMs } from "./ProviderTiming.ts";

export class OpenAIModelProvider implements ModelProvider {
  id: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  temperature: number | undefined;
  timeoutMs: number;
  strictJson: boolean;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.model = config.model || "gpt-4.1-mini";
    this.baseUrl = config.config?.baseUrl || "https://api.openai.com/v1";
    this.apiKeyEnv = config.config?.apiKeyEnv || "OPENAI_API_KEY";
    this.temperature = config.config?.temperature;
    this.timeoutMs = providerTimeoutMs(config);
    this.strictJson = config.config?.strictJson !== false;
  }

  async complete({ agent, role, prompt }: ModelCompleteInput): Promise<ModelCompleteResult> {
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) {
      throw new ProviderCallError({
        providerId: this.id,
        code: "auth_error",
        message: `Missing API key env ${this.apiKeyEnv} for provider ${this.id}`,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          ...(this.strictJson ? { response_format: { type: "json_object" } } : {}),
          messages: [
            {
              role: "system",
              content: [`Agent: ${agent}`, `Role: ${role}`].join("\n"),
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const classification = classifyHttpStatus(response.status);
        const detail = await readResponseText(response, 64000);
        throw new ProviderCallError({
          providerId: this.id,
          code: classification.code,
          status: response.status,
          retryable: classification.retryable,
          message: `OpenAI provider ${this.id} failed: ${response.status} ${detail.text}`,
        });
      }
      const body = await readJsonResponse<{
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      }>(response, { label: `OpenAI provider ${this.id}` });
      return {
        content: body.choices?.[0]?.message?.content || "",
        finishReason: body.choices?.[0]?.finish_reason,
        rawProvider: "openai",
        usage: body.usage ? {
          inputTokens: body.usage.prompt_tokens,
          outputTokens: body.usage.completion_tokens,
          totalTokens: body.usage.total_tokens,
        } : undefined,
        providerId: this.id,
        model: this.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
