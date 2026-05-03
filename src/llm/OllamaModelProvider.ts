import type { ModelCompleteInput, ModelProvider, ProviderConfig } from "./ModelProvider.ts";

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

  async complete({ agent, role, prompt }: ModelCompleteInput): Promise<string> {
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
        throw new Error(`Ollama provider ${this.id} failed: ${response.status} ${await response.text()}`);
      }
      const body = await response.json() as { response?: string };
      return body.response || "";
    } finally {
      clearTimeout(timer);
    }
  }
}
