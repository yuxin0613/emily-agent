import type { MemoryRecallResult, Task } from "../types.ts";
import type { ModelProvider } from "../llm/ModelProvider.ts";
import type { MemorySystem } from "../memory/MemorySystem.ts";
import type { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import type { ExperienceStore } from "../experience/ExperienceStore.ts";
import type { ExperienceRecallResult } from "../types.ts";
import { parseReviewerVerdict, type ReviewerVerdict } from "../review/ReviewerVerdict.ts";
import { MemoryCandidatePolicy } from "../memory/MemoryCandidatePolicy.ts";
import { createTaskGraph } from "../tasks/TaskGraph.ts";
import { taskResultSummary } from "../tasks/TaskResult.ts";

interface MainAgentResult {
  agent: string;
  runId?: string;
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
  reviewerVerdict?: ReviewerVerdict;
}

export class MainAgent {
  name: string;
  model: ModelProvider;
  memory: MemorySystem;
  taskStore: TaskStore;
  experienceStore: ExperienceStore;
  roleAgentManager: RoleAgentManager;
  memoryCandidatePolicy: MemoryCandidatePolicy;

  constructor({
    name,
    model,
    memory,
    taskStore,
    experienceStore,
    roleAgentManager,
  }: {
    name: string;
    model: ModelProvider;
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
    this.memoryCandidatePolicy = new MemoryCandidatePolicy();
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

    const sessionId = context.sessionId || "default";
    const source = context.source || "unknown";
    const run = this.taskStore.createRun({
      sessionId,
      source,
      userInput: normalizedInput,
    });
    const selectedAgents = this.selectSubAgents(normalizedInput);
    let subResults: Array<{ agent: string; role: string; taskId: string; status: string; content: string }> = [];
    let reviewerVerdict: ReviewerVerdict | undefined;

    try {
      await this.memory.remember({
        scope: sessionId,
        kind: "message:user",
        content: normalizedInput,
        metadata: { source, runId: run.id },
      });

      const relevantMemory = await this.memory.recall(normalizedInput, {
        scope: sessionId,
        limit: 5,
      });
      const relevantExperiences = this.experienceStore.recall(normalizedInput, {
        scope: "project",
        limit: 3,
      }).filter((experience) => experienceApplies(experience, normalizedInput));

      const delegated = await this.delegateTasks({
        input: normalizedInput,
        sessionId,
        source,
        runId: run.id,
        selectedAgents,
      });
      subResults = delegated.subResults;
      reviewerVerdict = delegated.reviewerVerdict;

      const content = await this.synthesizeResponse({
        input: normalizedInput,
        relevantMemory,
        relevantExperiences,
        subResults,
      });
      for (const experience of relevantExperiences) {
        this.experienceStore.recordUse(experience.id);
      }

      await this.memory.remember({
        scope: context.sessionId || "default",
        kind: "message:assistant",
        content,
        metadata: {
          source: "main-agent",
          runId: run.id,
          delegatedTo: selectedAgents,
        },
      });

      for (const result of subResults) {
        this.taskStore.acknowledgeTask(result.taskId);
      }
      await this.approveRunMemoryCandidates(run.id);
      this.taskStore.completeRun(run.id, runStatusFrom({ subResults, reviewerVerdict }));

      return {
        agent: this.name,
        runId: run.id,
        content,
        delegatedTo: selectedAgents,
        memory: relevantMemory,
        experiences: relevantExperiences,
        subResults,
        reviewerVerdict,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.taskStore.completeRun(run.id, "failed");
      const content = `这次运行没有完成：${message}`;
      try {
        await this.memory.remember({
          scope: sessionId,
          kind: "message:assistant:error",
          content,
          metadata: {
            source: "main-agent",
            runId: run.id,
            delegatedTo: selectedAgents,
          },
        });
      } catch {
        // The run status in SQLite is the recovery source of truth even if memory write fails.
      }
      return {
        agent: this.name,
        runId: run.id,
        content,
        delegatedTo: selectedAgents,
        subResults,
        reviewerVerdict,
      };
    }
  }

  async delegateTasks({
    input,
    sessionId,
    source,
    selectedAgents,
    runId,
  }: {
    input: string;
    sessionId: string;
    source: string;
    runId: string;
    selectedAgents: string[];
  }): Promise<{
    subResults: Array<{ agent: string; role: string; taskId: string; status: string; content: string }>;
    reviewerVerdict?: ReviewerVerdict;
  }> {
    const results = [];
    let reviewerVerdict: ReviewerVerdict | undefined;
    const taskGraph = createTaskGraph({
      taskStore: this.taskStore,
      baseMetadata: {
        sessionId,
        source,
        runId,
        createdBy: this.name,
        timeoutMs: 30000,
        maxResultChars: 12000,
        maxMemoryCandidates: 1,
      },
      spec: {
        tasks: [
          {
            key: "planner",
            role: "planner",
            title: `planner: ${input.slice(0, 60)}`,
            input,
            metadata: { graphRole: "planner" },
          },
          ...selectedAgents.filter((agentRole) => agentRole !== "planner").map((role) => ({
            key: role,
            role,
            title: `${role}: ${input.slice(0, 60)}`,
            input,
            dependsOn: ["planner"],
            metadata: {
              graphRole: role,
              autoRetry: false,
            },
          })),
        ],
      },
    });
    const plannerTask = taskGraph.planner;
    const graphId = String(plannerTask.metadata.graphId || "");

    const finishedPlanner = await this.roleAgentManager.runTask(plannerTask);
    results.push(this.formatTaskResult("planner", finishedPlanner));

    for (const role of selectedAgents.filter((agentRole) => agentRole !== "planner")) {
      const task = taskGraph[role];
      const finishedTask = await this.roleAgentManager.runTask(task);
      results.push(this.formatTaskResult(role, finishedTask));
    }

    if (results.some((result) => result.role !== "planner" && result.status === "done")) {
      this.taskStore.updateRunStatus(runId, "reviewing");
      const reviewTask = this.taskStore.createTask({
        role: "reviewer",
        title: `reviewer: ${input.slice(0, 60)}`,
        input: [
          "Review whether the subagent outputs satisfy the user request.",
          `User input: ${input}`,
          "Sub-results:",
          ...results.map((result) => `- ${result.role} ${result.status}: ${result.content}`),
        ].join("\n"),
        metadata: {
          sessionId,
          source,
          runId,
          createdBy: this.name,
          graphRole: "reviewer",
          graphId,
        },
      });
      for (const result of results.filter((item) => item.role !== "planner")) {
        this.taskStore.addTaskDependency(reviewTask.id, result.taskId, "finished");
      }
      const finishedReview = await this.roleAgentManager.runTask(reviewTask);
      const reviewResult = this.formatTaskResult("reviewer", finishedReview);
      reviewerVerdict = parseReviewerVerdict(reviewResult.content);
      results.push(reviewResult);
    }

    return { subResults: results, reviewerVerdict };
  }

  async approveRunMemoryCandidates(runId: string): Promise<void> {
    for (const candidate of this.taskStore.getPendingMemoryCandidates({ runId, limit: 100 })) {
      if (this.memoryCandidatePolicy.decide(candidate) === "rejected") {
        this.taskStore.decidePendingMemoryCandidate(candidate.id, "rejected");
        continue;
      }
      const decision = this.taskStore.decidePendingMemoryCandidate(candidate.id, "approved");
      if (!decision.changed) continue;
      await this.memory.remember({
        scope: candidate.scope,
        kind: candidate.kind,
        content: candidate.content,
        metadata: {
          runId: candidate.runId || "",
          taskId: candidate.taskId || "",
          candidateId: candidate.id,
          committedBy: "main-agent",
        },
      });
    }
  }

  formatTaskResult(role: string, finishedTask: Task): { agent: string; role: string; taskId: string; status: string; content: string } {
    return {
      agent: role,
      role,
      taskId: finishedTask.id,
      status: finishedTask.status,
      content: taskResultSummary(finishedTask.result, finishedTask.error || "(no result)"),
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

function runStatusFrom({
  subResults,
  reviewerVerdict,
}: {
  subResults: Array<{ status: string }>;
  reviewerVerdict?: ReviewerVerdict;
}): "done" | "failed" | "blocked" | "cancelled" {
  if (subResults.some((result) => result.status === "cancelled")) return "cancelled";
  if (subResults.some((result) => result.status !== "done")) return "failed";
  if (reviewerVerdict?.verdict === "needs_user_input") return "blocked";
  if (reviewerVerdict?.verdict === "fail") return "failed";
  return "done";
}

function formatExperiences(experiences: ExperienceRecallResult[]): string[] {
  if (!experiences.length) return ["- (none)"];
  return experiences.map((experience) => [
    `- ${experience.topicKey} r${experience.revision} score=${experience.score.toFixed(3)}`,
    `  problem: ${experience.problemPattern}`,
    `  applicability: ${experience.applicability}`,
    ...(experience.contraindications.length ? [`  avoid: ${experience.contraindications.join("; ")}`] : []),
    `  solution: ${experience.solutionPattern}`,
  ].join("\n"));
}

function experienceApplies(experience: ExperienceRecallResult, input: string): boolean {
  const normalized = input.toLowerCase();
  for (const item of experience.contraindications) {
    const words = item.toLowerCase().split(/[\s,.;:，。；：]+/).filter((word) => word.length >= 4);
    if (words.length && words.some((word) => normalized.includes(word))) return false;
  }
  if (!experience.applicability) return true;
  const applicabilityWords = experience.applicability.toLowerCase().split(/[\s,.;:，。；：]+/).filter((word) => word.length >= 4);
  if (!applicabilityWords.length) return true;
  return applicabilityWords.some((word) => normalized.includes(word))
    || normalized.includes(experience.problemPattern.slice(0, 12).toLowerCase());
}
