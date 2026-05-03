export class EchoModelProvider {
  async complete({ agent, role, prompt }) {
    if (agent === "planner") {
      return [
        "我会把任务拆成三步：",
        "1. 明确输入、输出和运行入口。",
        "2. 选择合适的 subagent 执行实际工作。",
        "3. 把结果写入三层记忆，并向主 agent 返回可沟通的结论。",
      ].join("\n");
    }

    if (agent === "developer") {
      return [
        "建议当前实现保持模块化：主 agent 负责会话和编排，subagent 负责具体任务，memory 通过统一接口同时写入内存、文件和向量索引。",
        "后续接真实模型时，只需要替换 ModelProvider；接真实向量库时，只需要替换 VectorMemoryLayer。",
      ].join("\n");
    }

    if (agent === "researcher") {
      return "我会优先从短期上下文、文件记忆和语义检索中取回相关信息，再整理成主 agent 可直接使用的上下文。";
    }

    if (agent === "reviewer") {
      return JSON.stringify({
        verdict: "pass",
        reasons: ["当前 subagent 结果已形成可汇总输出。"],
        retrySuggested: false,
        confidence: 0.82,
      });
    }

    return [
      "收到。当前运行的是本地 EchoModelProvider，所以我会展示编排结果而不是调用真实 LLM。",
      "",
      compactPrompt(prompt),
      "",
      "下一步可以接入真实模型 provider，把这里替换成 OpenAI、Ollama 或任意兼容接口。",
    ].join("\n");
  }
}

function compactPrompt(prompt) {
  const lines = prompt.split("\n").filter(Boolean);
  return lines.slice(0, 8).join("\n");
}
