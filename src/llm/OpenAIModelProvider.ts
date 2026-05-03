import type { ModelCompleteInput, ModelProvider, ProviderConfig } from "./ModelProvider.ts";

export class OpenAIModelProvider implements ModelProvider {
  id: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  temperature: number | undefined;
  timeoutMs: number;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.model = config.model || "gpt-4.1-mini";
    this.baseUrl = config.config?.baseUrl || "https://api.openai.com/v1";
    this.apiKeyEnv = config.config?.apiKeyEnv || "OPENAI_API_KEY";
    this.temperature = config.config?.temperature;
    this.timeoutMs = config.config?.timeoutMs || 60000;
  }

  async complete({ agent, role, prompt }: ModelCompleteInput): Promise<string> {
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`Missing API key env ${this.apiKeyEnv} for provider ${this.id}`);
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
        throw new Error(`OpenAI provider ${this.id} failed: ${response.status} ${await response.text()}`);
      }
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return body.choices?.[0]?.message?.content || "";
    } finally {
      clearTimeout(timer);
    }
  }
}
