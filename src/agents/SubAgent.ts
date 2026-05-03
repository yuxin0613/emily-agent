import { normalizeModelCompleteResult } from "../llm/ProviderRuntime.ts";
import type { ModelProvider } from "../llm/ModelProvider.ts";
import type { MemoryRecallResult } from "../types.ts";

export class SubAgent {
  name: string;
  role: string;
  capabilities: string[];
  model: ModelProvider;
  memory: unknown;

  constructor({ name, role, capabilities, model, memory }: {
    name: string;
    role: string;
    capabilities: string[];
    model: ModelProvider;
    memory: unknown;
  }) {
    this.name = name;
    this.role = role;
    this.capabilities = capabilities;
    this.model = model;
    this.memory = memory;
  }

  async run({ input, sessionId, relevantMemory, taskId, runId, source }: {
    input: string;
    sessionId?: string;
    relevantMemory: MemoryRecallResult;
    taskId?: string;
    runId?: string;
    source?: string;
  }): Promise<{
    agent: string;
    role: string;
    content: string;
    provider: {
      id: string;
      model: string;
      latencyMs: number;
      attempts?: number;
      finishReason?: string;
      rawProvider?: string;
      usage?: unknown;
      costUsd?: number;
      usageRecordId?: string;
      jsonFormat?: string;
      jsonWarnings?: string[];
    };
  }> {
    void sessionId;
    const prompt = [
      "# System",
      `You are ${this.name}.`,
      `Role: ${this.role}`,
      `Capabilities: ${this.capabilities.join(", ")}`,
      "",
      "# Workflow",
      input,
      "",
      "# Output Contract",
      "Return the useful work product for the main agent. Be concise, explicit, and mention blockers.",
      "",
      "# Runtime Context",
      "Relevant memory:",
      ...formatMemory(relevantMemory),
    ].join("\n");

    const startedAt = Date.now();
    const result = normalizeModelCompleteResult(await this.model.complete({
      agent: this.name,
      role: this.role,
      prompt,
      taskId,
      runId,
      source,
    }), this.model);
    const content = result.content;
    const latencyMs = Date.now() - startedAt;
    const provider = {
      id: this.model.id,
      model: this.model.model,
      latencyMs: result.latencyMs ?? latencyMs,
      attempts: result.attempts,
      finishReason: result.finishReason,
      rawProvider: result.rawProvider,
      usage: result.usage,
      costUsd: result.costUsd,
      usageRecordId: result.usageRecordId,
      jsonFormat: result.jsonFormat,
      jsonWarnings: result.jsonWarnings,
    };

    return {
      agent: this.name,
      role: this.role,
      content,
      provider,
    };
  }
}

function formatMemory(memory: MemoryRecallResult): string[] {
  const records = [
    ...memory.shortTerm.map((item) => `[short] ${item.content}`),
    ...memory.files.map((item) => `[file] ${item.content}`),
    ...memory.semantic.map((item) => `[semantic:${item.score.toFixed(3)}] ${item.content}`),
  ];

  return records.length ? records : ["(none)"];
}
