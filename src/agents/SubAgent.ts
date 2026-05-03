import { normalizeModelCompleteResult } from "../llm/ProviderRuntime.ts";

export class SubAgent {
  constructor({ name, role, capabilities, model, memory }) {
    this.name = name;
    this.role = role;
    this.capabilities = capabilities;
    this.model = model;
    this.memory = memory;
  }

  async run({ input, sessionId, relevantMemory, taskId, runId, source }) {
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

    await this.memory.remember({
      scope: sessionId,
      kind: "subagent:result",
      content,
      metadata: {
        source: this.name,
        capabilities: this.capabilities,
        providerId: provider.id,
        model: provider.model,
        latencyMs: provider.latencyMs,
        attempts: provider.attempts,
        finishReason: provider.finishReason,
        rawProvider: provider.rawProvider,
        usage: provider.usage,
        costUsd: provider.costUsd,
        usageRecordId: provider.usageRecordId,
        jsonFormat: provider.jsonFormat,
        jsonWarnings: provider.jsonWarnings,
      },
    });

    return {
      agent: this.name,
      role: this.role,
      content,
      provider,
    };
  }
}

function formatMemory(memory) {
  const records = [
    ...memory.shortTerm.map((item) => `[short] ${item.content}`),
    ...memory.files.map((item) => `[file] ${item.content}`),
    ...memory.semantic.map((item) => `[semantic:${item.score.toFixed(3)}] ${item.content}`),
  ];

  return records.length ? records : ["(none)"];
}
