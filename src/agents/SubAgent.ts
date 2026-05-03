export class SubAgent {
  constructor({ name, role, capabilities, model, memory }) {
    this.name = name;
    this.role = role;
    this.capabilities = capabilities;
    this.model = model;
    this.memory = memory;
  }

  async run({ input, sessionId, relevantMemory }) {
    const prompt = [
      `Role: ${this.role}`,
      `Capabilities: ${this.capabilities.join(", ")}`,
      `Task: ${input}`,
      "Relevant memory:",
      ...formatMemory(relevantMemory),
      "",
      "Return the useful work product for the main agent.",
    ].join("\n");

    const content = await this.model.complete({
      agent: this.name,
      role: this.role,
      prompt,
    });

    await this.memory.remember({
      scope: sessionId,
      kind: "subagent:result",
      content,
      metadata: {
        source: this.name,
        capabilities: this.capabilities,
      },
    });

    return {
      agent: this.name,
      role: this.role,
      content,
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
