import type { MemoryRecallResult, Task } from "../types.ts";
import type { ModelProvider } from "../llm/ModelProvider.ts";
import { normalizeModelCompleteResult } from "../llm/ProviderRuntime.ts";
import type { MemorySystem } from "../memory/MemorySystem.ts";
import type { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import type { ExperienceStore } from "../experience/ExperienceStore.ts";
import type { ExperienceRecallResult } from "../types.ts";
import type { ContextEngine } from "../context/ContextEngine.ts";
import type { LifecycleHooks } from "../runtime/LifecycleHooks.ts";
import type { AgentRouter } from "../routing/AgentRouter.ts";
import { parseReviewerVerdict, type ReviewerVerdict } from "../review/ReviewerVerdict.ts";
import { MemoryCandidatePolicy } from "../memory/MemoryCandidatePolicy.ts";
import { createTaskGraph, createTaskGraphFromPlan } from "../tasks/TaskGraph.ts";
import { TaskGraphExecutor, type TaskGraphPause } from "../tasks/TaskGraphExecutor.ts";
import { taskResultSummary } from "../tasks/TaskResult.ts";
import {
  createFallbackPlanSpec,
  deliveryLevelQuestion,
  inferDeliveryLevel,
  parsePlanSpec,
  requiresDeliveryLevelClarification,
  validatePlanSpec,
  type PlanSpec,
} from "../planning/PlanSpec.ts";

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
  needsUserInput?: {
    reason: string;
    questions: string[];
  };
  plan?: {
    goal: string;
    deliveryLevel: string;
    planningMode: string;
    taskCount: number;
    exitCriteria: string[];
  };
}

interface UserInputPause {
  reason: string;
  questions: string[];
  taskId?: string;
  plannerTaskId?: string;
  source: "plan" | TaskGraphPause["source"];
}

export class MainAgent {
  name: string;
  model: ModelProvider;
  memory: MemorySystem;
  taskStore: TaskStore;
  experienceStore: ExperienceStore;
  roleAgentManager: RoleAgentManager;
  memoryCandidatePolicy: MemoryCandidatePolicy;
  contextEngine: ContextEngine | null;
  hooks: LifecycleHooks | null;
  router: AgentRouter | null;

  constructor({
    name,
    model,
    memory,
    taskStore,
    experienceStore,
    roleAgentManager,
    contextEngine = null,
    hooks = null,
    router = null,
  }: {
    name: string;
    model: ModelProvider;
    memory: MemorySystem;
    taskStore: TaskStore;
    experienceStore: ExperienceStore;
    roleAgentManager: RoleAgentManager;
    contextEngine?: ContextEngine | null;
    hooks?: LifecycleHooks | null;
    router?: AgentRouter | null;
  }) {
    this.name = name;
    this.model = model;
    this.memory = memory;
    this.taskStore = taskStore;
    this.experienceStore = experienceStore;
    this.roleAgentManager = roleAgentManager;
    this.memoryCandidatePolicy = new MemoryCandidatePolicy();
    this.contextEngine = contextEngine;
    this.hooks = hooks;
    this.router = router;
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
    await this.hooks?.emit("beforeRun", {
      run,
      payload: { input: normalizedInput, sessionId, source },
    });
    const selectedAgents = this.selectSubAgents(normalizedInput);
    let delegatedTo = selectedAgents;
    let planSummary: MainAgentResult["plan"];
    let subResults: Array<{ agent: string; role: string; taskId: string; status: string; content: string }> = [];
    let reviewerVerdict: ReviewerVerdict | undefined;

    try {
      await this.remember({
        scope: sessionId,
        kind: "message:user",
        content: normalizedInput,
        metadata: { source, runId: run.id },
      });

      if (requiresDeliveryLevelClarification(normalizedInput)) {
        const content = deliveryLevelQuestion(normalizedInput);
        this.taskStore.completeRun(run.id, "waiting_user");
        await this.remember({
          scope: sessionId,
          kind: "message:assistant",
          content,
          metadata: {
            source: "main-agent",
            runId: run.id,
            waitingFor: "delivery_level",
          },
        });
        await this.hooks?.emit("afterRun", {
          run: this.taskStore.getRun(run.id) || run,
          payload: { status: "waiting_user", waitingFor: "delivery_level" },
        });
        return {
          agent: this.name,
          runId: run.id,
          content,
          delegatedTo: [],
          subResults: [],
        };
      }

      const contextBundle = this.contextEngine
        ? await this.contextEngine.build({
          query: normalizedInput,
          sessionId,
          runId: run.id,
          role: this.name,
          mode: shouldUseDeepContext(normalizedInput) ? "deep" : "active",
        })
        : null;
      const relevantMemory = contextBundle?.memory || await this.memory.recall(normalizedInput, {
        scope: sessionId,
        limit: 5,
      });
      const relevantExperiences = (contextBundle?.experiences || this.experienceStore.recall(normalizedInput, {
        scope: "project",
        limit: 3,
      })).filter((experience) => experienceApplies(experience, normalizedInput));

      const delegated = await this.delegateTasks({
        input: normalizedInput,
        sessionId,
        source,
        runId: run.id,
        selectedAgents,
      });
      subResults = delegated.subResults;
      reviewerVerdict = delegated.reviewerVerdict;
      delegatedTo = delegated.delegatedTo;
      planSummary = summarizePlan(delegated.plan);

      if (delegated.pause) {
        const content = formatUserInputPause(delegated.pause);
        for (const result of subResults) {
          this.taskStore.acknowledgeTask(result.taskId);
        }
        await this.approveRunMemoryCandidates(run.id);
        this.taskStore.completeRun(run.id, "waiting_user");
        await this.remember({
          scope: sessionId,
          kind: "message:assistant",
          content,
          metadata: {
            source: "main-agent",
            runId: run.id,
            delegatedTo,
            plan: planSummary || null,
            waitingFor: "user_input",
            pause: {
              reason: delegated.pause.reason,
              questions: delegated.pause.questions,
              taskId: delegated.pause.taskId || "",
              plannerTaskId: delegated.pause.plannerTaskId || "",
              source: delegated.pause.source,
            },
          },
        });
        await this.hooks?.emit("afterRun", {
          run: this.taskStore.getRun(run.id) || run,
          payload: { status: "waiting_user", waitingFor: "user_input", delegatedTo },
        });
        return {
          agent: this.name,
          runId: run.id,
          content,
          delegatedTo,
          memory: relevantMemory,
          experiences: relevantExperiences,
          plan: planSummary,
          subResults,
          reviewerVerdict,
          needsUserInput: {
            reason: delegated.pause.reason,
            questions: delegated.pause.questions,
          },
        };
      }

      const content = await this.synthesizeResponse({
        input: normalizedInput,
        runId: run.id,
        sessionId,
        relevantMemory,
        relevantExperiences,
        plan: delegated.plan,
        subResults,
      });
      for (const experience of relevantExperiences) {
        this.experienceStore.recordUse(experience.id);
      }

      await this.remember({
        scope: context.sessionId || "default",
        kind: "message:assistant",
        content,
        metadata: {
          source: "main-agent",
          runId: run.id,
          delegatedTo,
          plan: planSummary || null,
        },
      });

      for (const result of subResults) {
        this.taskStore.acknowledgeTask(result.taskId);
      }
      await this.approveRunMemoryCandidates(run.id);
      this.taskStore.completeRun(run.id, runStatusFrom({ subResults, reviewerVerdict }));
      await this.hooks?.emit("afterRun", {
        run: this.taskStore.getRun(run.id) || run,
        payload: {
          status: this.taskStore.getRun(run.id)?.status || "done",
          delegatedTo,
        },
      });

      return {
        agent: this.name,
        runId: run.id,
        content,
        delegatedTo,
        memory: relevantMemory,
        experiences: relevantExperiences,
        plan: planSummary,
        subResults,
        reviewerVerdict,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.taskStore.completeRun(run.id, "failed");
      const content = `这次运行没有完成：${message}`;
      try {
        await this.remember({
          scope: sessionId,
          kind: "message:assistant:error",
          content,
          metadata: {
            source: "main-agent",
            runId: run.id,
            delegatedTo,
          },
        });
      } catch {
        // The run status in SQLite is the recovery source of truth even if memory write fails.
      }
      await this.hooks?.emit("afterRun", {
        run: this.taskStore.getRun(run.id) || run,
        payload: {
          status: "failed",
          error: message,
          delegatedTo,
        },
      });
      return {
        agent: this.name,
        runId: run.id,
        content,
        delegatedTo,
        subResults,
        reviewerVerdict,
        plan: planSummary,
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
    delegatedTo: string[];
    plan: PlanSpec;
    pause?: UserInputPause;
  }> {
    const results = [];
    let reviewerVerdict: ReviewerVerdict | undefined;
    const planningPrompt = plannerPrompt(input, inferDeliveryLevel(input) || "poc");
    const planningGraph = createTaskGraph({
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
            input: planningPrompt,
            metadata: {
              graphRole: "planner",
              planPhase: "planning",
              deliveryLevel: inferDeliveryLevel(input) || "poc",
            },
          },
        ],
      },
    });
    const plannerTask = planningGraph.planner;

    const finishedPlanner = await this.roleAgentManager.runTask(plannerTask);
    results.push(this.formatTaskResult("planner", finishedPlanner));
    if (finishedPlanner.status !== "done") {
      this.taskStore.refreshTaskGraphStatuses();
      const fallback = createFallbackPlanSpec(input, selectedAgents);
      return { subResults: results, delegatedTo: ["planner"], plan: fallback };
    }

    let plan = parsePlanSpec(this.formatTaskResult("planner", finishedPlanner).content)
      || createFallbackPlanSpec(input, selectedAgents);
    const validation = validatePlanSpec(plan);
    if (!validation.ok) {
      this.taskStore.addEvent({
        type: "runtime.anomaly",
        taskId: finishedPlanner.id,
        payload: {
          severity: "warning",
          code: "planner_plan_invalid",
          message: "Planner returned an invalid PlanSpec; fallback plan was used.",
          errors: validation.errors,
          runId,
          repaired: true,
        },
      });
      plan = createFallbackPlanSpec(input, selectedAgents);
    }

    if (plan.clarificationRequired) {
      return {
        subResults: results,
        reviewerVerdict,
        delegatedTo: ["planner"],
        plan,
        pause: {
          reason: "planner requested clarification before execution",
          questions: plan.clarificationQuestions.length ? plan.clarificationQuestions : ["请补充这个任务继续拆解前必须确认的信息。"],
          taskId: finishedPlanner.id,
          source: "plan",
        },
      };
    }

    const executionTasks = createTaskGraphFromPlan({
      taskStore: this.taskStore,
      plan,
      baseMetadata: {
        sessionId,
        source,
        runId,
        createdBy: this.name,
        planSourceTaskId: finishedPlanner.id,
      },
    });
    const executor = new TaskGraphExecutor({
      taskStore: this.taskStore,
      roleAgentManager: this.roleAgentManager,
      plan,
    });
    const execution = await executor.execute(executionTasks);
    for (const task of execution.completed) {
      results.push(this.formatTaskResult(task.role, task));
    }
    for (const task of execution.internal) {
      this.taskStore.acknowledgeTask(task.id);
    }

    if (execution.pause) {
      return {
        subResults: results,
        reviewerVerdict,
        delegatedTo: unique([
          "planner",
          ...plan.tasks.map((task) => task.role),
          ...results.map((result) => result.role),
        ]),
        plan,
        pause: {
          reason: execution.pause.reason,
          questions: execution.pause.questions,
          taskId: execution.pause.taskId,
          plannerTaskId: execution.pause.plannerTaskId,
          source: execution.pause.source,
        },
      };
    }

    if (results.some((result) => result.role !== "planner" && result.status === "done")) {
      this.taskStore.updateRunStatus(runId, "reviewing");
      const explicitReview = results.filter((result) => result.role === "reviewer").at(-1);
      if (explicitReview) {
        reviewerVerdict = parseReviewerVerdict(explicitReview.content);
      } else if (plan.review.required) {
        const reviewTask = this.taskStore.createTask({
          role: "reviewer",
          title: `reviewer: ${input.slice(0, 60)}`,
          input: [
            "Review whether the graph outputs satisfy the user request and delivery exit criteria.",
            `User input: ${input}`,
            `Delivery level: ${plan.deliveryLevel}`,
            "Exit criteria:",
            ...plan.exitCriteria.map((item) => `- ${item}`),
            "Sub-results:",
            ...results.map((result) => `- ${result.role} ${result.status}: ${result.content}`),
          ].join("\n"),
          metadata: {
            sessionId,
            source,
            runId,
            createdBy: this.name,
            graphRole: "reviewer",
            graphId: execution.graphId || "",
            acceptanceCriteria: plan.review.criteria,
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
    }

    return {
      subResults: results,
      reviewerVerdict,
      delegatedTo: unique([
        "planner",
        ...plan.tasks.map((task) => task.role),
        ...results.map((result) => result.role),
        ...(plan.review.required ? ["reviewer"] : []),
      ]),
      plan,
    };
  }

  async approveRunMemoryCandidates(runId: string): Promise<void> {
    for (const candidate of this.taskStore.getPendingMemoryCandidates({ runId, limit: 100 })) {
      if (this.memoryCandidatePolicy.decide(candidate) === "rejected") {
        this.taskStore.decidePendingMemoryCandidate(candidate.id, "rejected");
        continue;
      }
      const decision = this.taskStore.decidePendingMemoryCandidate(candidate.id, "approved");
      if (!decision.changed) continue;
      await this.remember({
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

  private async remember(record: Parameters<MemorySystem["remember"]>[0]) {
    await this.hooks?.emit("beforeMemoryCommit", {
      payload: {
        scope: record.scope || "default",
        kind: record.kind || "note",
      },
    });
    const saved = await this.memory.remember(record);
    await this.hooks?.emit("afterMemoryCommit", {
      payload: {
        id: saved.id,
        scope: saved.scope,
        kind: saved.kind,
      },
    });
    return saved;
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
    return this.router?.route(input).selectedRoles || legacySelectSubAgents(input);
  }

  async synthesizeResponse({
    input,
    runId,
    sessionId,
    relevantMemory,
    relevantExperiences,
    plan,
    subResults,
  }: {
    input: string;
    runId?: string;
    sessionId?: string;
    relevantMemory: MemoryRecallResult;
    relevantExperiences: ExperienceRecallResult[];
    plan?: PlanSpec;
    subResults: Array<{ agent: string; content: string }>;
  }): Promise<string> {
    const prompt = [
      `User input: ${input}`,
      `Relevant memory count: ${relevantMemory.semantic.length + relevantMemory.shortTerm.length}`,
      "Relevant active experiences:",
      ...formatExperiences(relevantExperiences),
      "Execution plan:",
      ...(plan ? formatPlan(plan) : ["- (none)"]),
      "Sub-agent results:",
      ...subResults.map((result) => `- ${result.agent}: ${result.content}`),
      "",
      "Write a concise, helpful response in Chinese.",
    ].join("\n");

    const result = normalizeModelCompleteResult(await this.model.complete({
      agent: this.name,
      role: "Communicate with the user and coordinate sub-agents.",
      prompt,
      runId,
      source: sessionId ? `session:${sessionId}` : "main-agent",
    }), this.model);
    return result.content;
  }
}

function plannerPrompt(input: string, deliveryLevel: string): string {
  return [
    "Create a PlanSpec JSON object for an outcome-oriented agent task graph.",
    "Return only JSON. Do not wrap it in markdown.",
    "",
    "Required shape:",
    JSON.stringify({
      goal: "string",
      deliveryLevel,
      exitCriteria: ["string"],
      planningMode: "single_wave or rolling",
      maxWaves: 1,
      failureStrategy: "block_dependents",
      tasks: [{
        key: "implementation",
        role: "developer",
        title: "short task title",
        input: "full task instructions",
        parentKey: "",
        dependsOn: [],
        dependencyType: "success",
        acceptanceCriteria: ["string"],
        toolHints: [],
        skillHints: [],
        timeoutMs: 30000,
        maxRetries: 1,
        maxResultChars: 12000,
        maxMemoryCandidates: 1,
        wave: 1,
        expandable: false,
        expansionGoal: "",
        maxExpansionDepth: 0,
      }],
      review: {
        required: true,
        criteria: ["string"],
      },
      clarificationRequired: false,
      clarificationQuestions: [],
    }, null, 2),
    "",
    "Planning rules:",
    "- For long product/application work, decompose by outcome -> module -> feature slice -> verification.",
    "- For rolling mode, keep the initial graph coarse and mark tasks that should expand later with expandable=true.",
    "- Expandable tasks should describe expansionGoal and maxExpansionDepth.",
    "- Each task must have acceptanceCriteria.",
    "- Use dependencies instead of prose ordering.",
    "- Keep the first wave small enough to execute now; use planningMode=rolling for larger goals.",
    "- Use deliveryLevel to decide exit criteria: poc, uat, production.",
    "",
    `User request: ${input}`,
  ].join("\n");
}

function summarizePlan(plan?: PlanSpec): MainAgentResult["plan"] | undefined {
  if (!plan) return undefined;
  return {
    goal: plan.goal,
    deliveryLevel: plan.deliveryLevel,
    planningMode: plan.planningMode,
    taskCount: plan.tasks.length,
    exitCriteria: plan.exitCriteria,
  };
}

function formatPlan(plan: PlanSpec): string[] {
  return [
    `- goal: ${plan.goal}`,
    `- deliveryLevel: ${plan.deliveryLevel}`,
    `- planningMode: ${plan.planningMode}`,
    `- taskCount: ${plan.tasks.length}`,
    "- exitCriteria:",
    ...plan.exitCriteria.map((item) => `  - ${item}`),
    "- tasks:",
    ...plan.tasks.map((task) => `  - ${task.key} [${task.role}] wave=${task.wave} dependsOn=${task.dependsOn.join(",") || "(none)"}`),
  ];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function legacySelectSubAgents(input: string): string[] {
  const lower = input.toLowerCase();
  const agents = ["planner"];
  if (/(code|bug|fix|实现|开发|报错|架构|node|api|webui|tui|应用|系统|平台|项目|功能|接口)/i.test(lower)) {
    agents.push("developer");
  } else {
    agents.push("researcher");
  }
  return agents;
}

function shouldUseDeepContext(input: string): boolean {
  return /(之前|历史|上下文|session|会话|记得|remember|history|long[- ]?term|deep)/i.test(input);
}

function formatUserInputPause(pause: UserInputPause): string {
  const questions = pause.questions.length ? pause.questions : ["请补充继续执行前必须确认的信息。"];
  return [
    "这一步需要你补充信息后我才能继续拆分执行。",
    "",
    `原因：${pause.reason}`,
    "",
    "请确认：",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
  ].join("\n");
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
