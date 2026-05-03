import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./ModelProvider.ts";

export class EchoModelProvider implements ModelProvider {
  id: string;
  model: string;

  constructor({ id = "echo", model = "echo-local" }: { id?: string; model?: string } = {}) {
    this.id = id;
    this.model = model;
  }

  async complete({ agent, role, prompt }: ModelCompleteInput): Promise<ModelCompleteResult> {
    if (agent === "planner") {
      return this.result([
        "我会把任务拆成三步：",
        "1. 明确输入、输出和运行入口。",
        "2. 选择合适的 subagent 执行实际工作。",
        "3. 把结果写入三层记忆，并向主 agent 返回可沟通的结论。",
      ].join("\n"));
    }

    if (agent === "developer") {
      return this.result([
        "建议当前实现保持模块化：主 agent 负责会话和编排，subagent 负责具体任务，memory 通过统一接口同时写入内存、文件和向量索引。",
        "后续接真实模型时，只需要替换 ModelProvider；接真实向量库时，只需要替换 VectorMemoryLayer。",
      ].join("\n"));
    }

    if (agent === "researcher") {
      return this.result("我会优先从短期上下文、文件记忆和语义检索中取回相关信息，再整理成主 agent 可直接使用的上下文。");
    }

    if (agent === "reviewer") {
      return this.result(JSON.stringify({
        verdict: "pass",
        reasons: ["当前 subagent 结果已形成可汇总输出。"],
        retrySuggested: false,
        confidence: 0.82,
      }));
    }

    return this.result([
      "收到。当前运行的是本地 EchoModelProvider，所以我会展示编排结果而不是调用真实 LLM。",
      `Provider: ${this.id}`,
      `Model: ${this.model}`,
      `Role: ${role}`,
      "",
      compactPrompt(prompt),
      "",
      "下一步可以接入真实模型 provider，把这里替换成 OpenAI、Ollama 或任意兼容接口。",
    ].join("\n"));
  }

  private result(content: string): ModelCompleteResult {
    return {
      content,
      finishReason: "stop",
      rawProvider: "echo",
      providerId: this.id,
      model: this.model,
    };
  }
}

function compactPrompt(prompt: string): string {
  const lines = prompt.split("\n").filter(Boolean);
  return lines.slice(0, 8).join("\n");
}
