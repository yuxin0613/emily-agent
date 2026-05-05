import type { ModelCompleteInput, ModelCompleteResult, ModelProvider } from "./ModelProvider.ts";

export class EchoModelProvider implements ModelProvider {
  id: string;
  model: string;

  constructor({ id = "echo", model = "echo-local" }: { id?: string; model?: string } = {}) {
    this.id = id;
    this.model = model;
  }

  async complete({ agent, role, prompt }: ModelCompleteInput): Promise<ModelCompleteResult> {
    if (agent === "planner" && /GraphPatchSpec|adaptively expand/i.test(prompt)) {
      if (/FAIL_GRAPH_PATCH/.test(prompt)) {
        throw new Error("Echo graph patch failure requested by test input.");
      }
      const parentKey = extractParentKey(prompt);
      if (/NEEDS_GRAPH_INPUT/.test(prompt)) {
        return this.result(JSON.stringify({
          reason: "Need more graph input before creating the next slice.",
          parentKey,
          stop: false,
          needsUserInput: true,
          questions: ["请补充任务图继续拆解前必须确认的业务边界。"],
          tasks: [],
        }));
      }
      return this.result(JSON.stringify({
        reason: "Echo adaptive graph patch from the completed parent task.",
        parentKey,
        stop: false,
        needsUserInput: false,
        questions: [],
        tasks: [
          {
            key: "verification",
            role: "reviewer",
            title: "verification slice",
            input: "Verify the implementation slice against the delivery exit criteria and return pass/fail/needs_user_input.",
            parentKey: "implementation",
            dependsOn: ["implementation"],
            dependencyType: "finished",
            acceptanceCriteria: [
              "The implementation result is checked against the current exit criteria.",
              "The verdict is explicit and actionable.",
            ],
            toolHints: [],
            skillHints: ["review", "quality"],
            timeoutMs: 30000,
            maxRetries: 1,
            maxResultChars: 12000,
            maxMemoryCandidates: 1,
            wave: 2,
            expandable: false,
            expansionGoal: "",
            maxExpansionDepth: 0,
          },
          {
            key: "implementation",
            role: "developer",
            title: "implementation slice",
            input: "Implement or specify the first concrete slice needed to satisfy the current exit criteria. Use the completed parent task result as context and return remaining work as next actions.",
            parentKey,
            dependsOn: [parentKey],
            dependencyType: "success",
            acceptanceCriteria: [
              "A concrete implementation slice or precise executable design is produced.",
              "The result states what remains for later rolling waves.",
            ],
            toolHints: ["read_file", "write_file", "run_tests"],
            skillHints: ["coding", "implementation"],
            timeoutMs: 30000,
            maxRetries: 1,
            maxResultChars: 12000,
            maxMemoryCandidates: 1,
            wave: 2,
            expandable: false,
            expansionGoal: "",
            maxExpansionDepth: 0,
          },
        ],
      }));
    }

    if (agent === "planner") {
      if (/NEEDS_PLAN_CLARIFICATION/.test(prompt)) {
        return this.result(JSON.stringify({
          goal: "Clarification required before execution.",
          deliveryLevel: "poc",
          exitCriteria: ["The user answers the planner clarification question."],
          planningMode: "rolling",
          maxWaves: 1,
          failureStrategy: "block_dependents",
          tasks: [{
            key: "scope",
            role: "researcher",
            title: "scope clarification",
            input: "Wait for the user to clarify scope.",
            dependsOn: [],
            dependencyType: "success",
            acceptanceCriteria: ["The missing scope information is available."],
            toolHints: [],
            skillHints: ["requirements"],
            timeoutMs: 30000,
            maxRetries: 1,
            maxResultChars: 12000,
            maxMemoryCandidates: 0,
            wave: 1,
            expandable: false,
            expansionGoal: "",
            maxExpansionDepth: 0,
          }],
          review: {
            required: true,
            criteria: ["The clarification answer is available."],
          },
          clarificationRequired: true,
          clarificationQuestions: ["请补充验收范围和必须覆盖的核心场景。"],
        }));
      }
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

    if (/Conversation mode:\s*direct_chat/i.test(prompt)) {
      return this.result([
        `收到：${extractUserInput(prompt) || "我在。"}`,
        "这是普通对话消息，我不会把它拆成任务。需要我执行具体工作时，直接说“帮我……”或描述目标就行。",
      ].join("\n"));
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

function extractUserInput(prompt: string): string {
  const match = prompt.match(/^User input:\s*(.+)$/m);
  return match?.[1]?.trim() || "";
}

function compactPrompt(prompt: string): string {
  const lines = prompt.split("\n").filter(Boolean);
  return lines.slice(0, 8).join("\n");
}

function extractParentKey(prompt: string): string {
  const jsonLike = prompt.match(/"parentKey"\s*:\s*"([^"]+)"/);
  if (jsonLike?.[1]) return jsonLike[1];
  const exact = prompt.match(/parentKey must be exactly ([A-Za-z0-9._-]+)/);
  return exact?.[1]?.replace(/[.,;:]+$/, "") || "architecture";
}
