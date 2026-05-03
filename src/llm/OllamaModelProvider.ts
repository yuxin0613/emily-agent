import type { ModelCompleteInput, ModelCompleteResult, ModelProvider, ProviderConfig } from "./ModelProvider.ts";
import { ProviderCallError } from "./ModelProvider.ts";
import { classifyHttpStatus } from "./ProviderRuntime.ts";

export class OllamaModelProvider implements ModelProvider {
  id: string;
  model: string;
  baseUrl: string;
  temperature: number | undefined;
  timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.model = config.model || "llama3.1";
    this.baseUrl = config.config?.baseUrl || "http://127.0.0.1:11434";
    this.temperature = config.config?.temperature;
    this.timeoutMs = config.config?.timeoutMs || 60000;
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
        throw new ProviderCallError({
          providerId: this.id,
          code: classification.code,
          status: response.status,
          retryable: classification.retryable,
          message: `Ollama provider ${this.id} failed: ${response.status} ${await response.text()}`,
        });
      }
      const body = await response.json() as {
        response?: string;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };
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
