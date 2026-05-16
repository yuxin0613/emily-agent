import type { ModelCompleteInput, ModelCompleteResult, ModelProvider, ProviderConfig } from "./ModelProvider.ts";
import { ProviderCallError } from "./ModelProvider.ts";
import { readJsonResponse, readResponseText } from "./HttpResponse.ts";
import { classifyHttpStatus } from "./ProviderRuntime.ts";
import { providerTimeoutMs } from "./ProviderTiming.ts";

export class OllamaModelProvider implements ModelProvider {
  id: string;
  model: string;
  baseUrl: string;
  temperature: number | undefined;
  timeoutMs: number;
  strictJson: boolean;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.model = config.model || "llama3.1";
    this.baseUrl = config.config?.baseUrl || "http://127.0.0.1:11434";
    this.temperature = config.config?.temperature;
    this.timeoutMs = providerTimeoutMs(config);
    this.strictJson = config.config?.strictJson !== false;
  }

  async complete({ agent, role, prompt }: ModelCompleteInput): Promise<ModelCompleteResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          ...(this.strictJson ? { format: "json" } : {}),
          options: {
            temperature: this.temperature,
          },
          prompt: [
            `Agent: ${agent}`,
            `Role: ${role}`,
            "",
            prompt,
          ].join("\n"),
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
          message: `Ollama provider ${this.id} failed: ${response.status} ${detail.text}`,
        });
      }
      const body = await readJsonResponse<{
        response?: string;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      }>(response, { label: `Ollama provider ${this.id}` });
      return {
        content: body.response || "",
        finishReason: body.done_reason,
        rawProvider: "ollama",
        usage: {
          inputTokens: body.prompt_eval_count,
          outputTokens: body.eval_count,
          totalTokens: typeof body.prompt_eval_count === "number" || typeof body.eval_count === "number"
            ? (body.prompt_eval_count || 0) + (body.eval_count || 0)
            : undefined,
        },
        providerId: this.id,
        model: this.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
