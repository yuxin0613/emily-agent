import type { MemoryRecallResult, Task } from "../types.ts";
import type { EchoModelProvider } from "../llm/EchoModelProvider.ts";
import type { MemorySystem } from "../memory/MemorySystem.ts";
import type { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import type { ExperienceStore } from "../experience/ExperienceStore.ts";
import type { ExperienceRecallResult } from "../types.ts";

interface MainAgentResult {
  agent: string;
  content: string;
  delegatedTo: string[];
  memory?: MemoryRecallResult;
  experiences?: ExperienceRecallResult[];
  subResults?: Array<{
    agent: string;
    role: string;
    taskId: string;
    status: string;
    content: string;
  }>;
}

export class MainAgent {
  name: string;
  model: EchoModelProvider;
  memory: MemorySystem;
  taskStore: TaskStore;
  experienceStore: ExperienceStore;
  roleAgentManager: RoleAgentManager;

  constructor({
    name,
    model,
    memory,
    taskStore,
    experienceStore,
    roleAgentManager,
  }: {
    name: string;
    model: EchoModelProvider;
    memory: MemorySystem;
    taskStore: TaskStore;
    experienceStore: ExperienceStore;
    roleAgentManager: RoleAgentManager;
  }) {
    this.name = name;
    this.model = model;
    this.memory = memory;
    this.taskStore = taskStore;
    this.experienceStore = experienceStore;
    this.roleAgentManager = roleAgentManager;
  }

  async handleUserMessage(input: string, context: { sessionId?: string; source?: string } = {}): Promise<MainAgentResult> {
    const normalizedInput = String(input || "").trim();
    if (!normalizedInput) {
      return {
        agent: this.name,
        content: "说点什么吧，我在。",
        delegatedTo: [],
      };
    }

    await this.memory.remember({
      scope: context.sessionId || "default",
      kind: "message:user",
      content: normalizedInput,
      metadata: { source: context.source || "unknown" },
    });

    const relevantMemory = await this.memory.recall(normalizedInput, {
      scope: context.sessionId || "default",
      limit: 5,
    });
    const relevantExperiences = this.experienceStore.recall(normalizedInput, {
      scope: "project",
      limit: 3,
    });

    const selectedAgents = this.selectSubAgents(normalizedInput);
    const subResults = await this.delegateTasks({
      input: normalizedInput,
      sessionId: context.sessionId || "default",
      source: context.source || "unknown",
      selectedAgents,
    });

    const content = await this.synthesizeResponse({
      input: normalizedInput,
      relevantMemory,
      relevantExperiences,
      subResults,
    });

    await this.memory.remember({
      scope: context.sessionId || "default",
      kind: "message:assistant",
      content,
      metadata: {
        source: "main-agent",
        delegatedTo: selectedAgents,
      },
    });

    for (const result of subResults) {
      this.taskStore.acknowledgeTask(result.taskId);
    }

    return {
      agent: this.name,
      content,
      delegatedTo: selectedAgents,
      memory: relevantMemory,
      experiences: relevantExperiences,
      subResults,
    };
  }

  async delegateTasks({
    input,
    sessionId,
    source,
    selectedAgents,
  }: {
    input: string;
    sessionId: string;
    source: string;
    selectedAgents: string[];
  }): Promise<Array<{ agent: string; role: string; taskId: string; status: string; content: string }>> {
    const results = [];

    for (const role of selectedAgents) {
      const task = this.taskStore.createTask({
        role,
        title: `${role}: ${input.slice(0, 60)}`,
        input,
        metadata: {
          sessionId,
          source,
          createdBy: this.name,
          autoRetry: false,
        },
      });

      const finishedTask = await this.roleAgentManager.runTask(task);
      results.push(this.formatTaskResult(role, finishedTask));
    }

    return results;
  }

  formatTaskResult(role: string, finishedTask: Task): { agent: string; role: string; taskId: string; status: string; content: string } {
    return {
      agent: role,
      role,
      taskId: finishedTask.id,
      status: finishedTask.status,
      content: finishedTask.result || finishedTask.error || "(no result)",
    };
  }

  selectSubAgents(input: string): string[] {
    const lower = input.toLowerCase();
    const agents = ["planner"];

    if (/(code|bug|fix|实现|开发|报错|架构|node|api|webui|tui)/i.test(lower)) {
      agents.push("developer");
    } else {
      agents.push("researcher");
    }

    return agents;
  }

  async synthesizeResponse({
    input,
    relevantMemory,
    relevantExperiences,
    subResults,
  }: {
    input: string;
    relevantMemory: MemoryRecallResult;
    relevantExperiences: ExperienceRecallResult[];
    subResults: Array<{ agent: string; content: string }>;
  }): Promise<string> {
    const prompt = [
      `User input: ${input}`,
      `Relevant memory count: ${relevantMemory.semantic.length + relevantMemory.shortTerm.length}`,
      "Relevant active experiences:",
      ...formatExperiences(relevantExperiences),
      "Sub-agent results:",
      ...subResults.map((result) => `- ${result.agent}: ${result.content}`),
      "",
      "Write a concise, helpful response in Chinese.",
    ].join("\n");

    return this.model.complete({
      agent: this.name,
      role: "Communicate with the user and coordinate sub-agents.",
      prompt,
    });
  }
}

function formatExperiences(experiences: ExperienceRecallResult[]): string[] {
  if (!experiences.length) return ["- (none)"];
  return experiences.map((experience) => [
    `- ${experience.topicKey} r${experience.revision} score=${experience.score.toFixed(3)}`,
    `  problem: ${experience.problemPattern}`,
    `  solution: ${experience.solutionPattern}`,
  ].join("\n"));
}
