import type { ModelCompleteInput, ModelCompleteResult, ModelProvider, ProviderConfig } from "./ModelProvider.ts";
import { ProviderCallError } from "./ModelProvider.ts";
import { readJsonResponse, readResponseText } from "./HttpResponse.ts";
import { classifyHttpStatus } from "./ProviderRuntime.ts";
import { providerTimeoutMs } from "./ProviderTiming.ts";
import { readCodexAuthCredentials } from "./CodexAuth.ts";

interface CodexResponseBody {
  output_text?: unknown;
  output?: Array<{
    type?: unknown;
    text?: unknown;
    content?: Array<{
      type?: unknown;
      text?: unknown;
      value?: unknown;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  status?: unknown;
}

export class CodexModelProvider implements ModelProvider {
  id: string;
  model: string;
  baseUrl: string;
  authJsonPath: string | undefined;
  temperature: number | undefined;
  timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.model = config.model || "gpt-5.5";
    this.baseUrl = config.config?.baseUrl || "https://chatgpt.com/backend-api/codex";
    this.authJsonPath = config.config?.authJsonPath;
    this.temperature = config.config?.temperature;
    this.timeoutMs = providerTimeoutMs(config);
  }

  async complete({ agent, role, prompt }: ModelCompleteInput): Promise<ModelCompleteResult> {
    const credentials = await readCodexAuthCredentials(this.authJsonPath, this.id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(codexResponsesUrl(this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.accessToken}`,
          "ChatGPT-Account-ID": credentials.accountId,
          originator: "codex_cli_rs",
          "user-agent": "emily-agent",
        },
        body: JSON.stringify({
          model: this.model,
          ...(typeof this.temperature === "number" ? { temperature: this.temperature } : {}),
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: [`Agent: ${agent}`, `Role: ${role}`].join("\n"),
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: prompt,
                },
              ],
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
          message: `Codex provider ${this.id} failed: ${response.status} ${detail.text}`,
        });
      }

      const body = await readJsonResponse<CodexResponseBody>(response, { label: `Codex provider ${this.id}` });
      return {
        content: extractCodexOutputText(body),
        rawProvider: "codex",
        usage: body.usage ? {
          inputTokens: body.usage.input_tokens,
          outputTokens: body.usage.output_tokens,
          totalTokens: body.usage.total_tokens,
        } : undefined,
        providerId: this.id,
        model: this.model,
        finishReason: typeof body.status === "string" ? body.status : undefined,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function codexResponsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
}

function extractCodexOutputText(body: CodexResponseBody): string {
  if (typeof body.output_text === "string") return body.output_text;
  const parts: string[] = [];
  for (const item of body.output || []) {
    if (typeof item.text === "string") parts.push(item.text);
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
      else if (typeof content.value === "string") parts.push(content.value);
    }
  }
  return parts.join("");
}
