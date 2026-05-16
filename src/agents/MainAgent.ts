import type { MemoryRecallResult, Metadata, Task } from "../types.ts";
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
import { parsePermissionMode } from "../tools/PermissionMode.ts";
import { parseReviewerVerdict, type ReviewerVerdict } from "../review/ReviewerVerdict.ts";
import { MemoryCandidatePolicy } from "../memory/MemoryCandidatePolicy.ts";
import { createTaskGraph, createTaskGraphFromPlan } from "../tasks/TaskGraph.ts";
import { TaskGraphExecutor, type TaskGraphPause } from "../tasks/TaskGraphExecutor.ts";
import { taskResultSummary } from "../tasks/TaskResult.ts";
import {
  createFallbackPlanSpec,
  createPlanningOnlyPlanSpec,
  assessTaskComplexity,
  deliveryLevelQuestion,
  inferDeliveryLevel,
  parsePlanSpec,
  requiresDeliveryLevelClarification,
  validatePlanSpec,
  type PlanSpec,
} from "../planning/PlanSpec.ts";
import { DEFAULT_ROLE_TASK_TIMEOUT_MS, normalizeRoleTaskTimeoutMs } from "../runtime/RoleTaskTimeout.ts";

const DEFAULT_PLANNER_TASK_TIMEOUT_MS = 10 * 60 * 1000;

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
  plannerTaskTimeoutMs: number;
  roleTaskTimeoutMs: number;

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
    plannerTaskTimeoutMs = DEFAULT_PLANNER_TASK_TIMEOUT_MS,
    roleTaskTimeoutMs = DEFAULT_ROLE_TASK_TIMEOUT_MS,
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
    plannerTaskTimeoutMs?: number;
    roleTaskTimeoutMs?: number;
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
    this.plannerTaskTimeoutMs = Math.max(1000, Math.floor(plannerTaskTimeoutMs));
    this.roleTaskTimeoutMs = normalizeRoleTaskTimeoutMs(roleTaskTimeoutMs);
  }

  async handleUserMessage(input: string, context: { sessionId?: string; source?: string; permissionMode?: unknown } = {}): Promise<MainAgentResult> {
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
    const permissionMode = parsePermissionMode(context.permissionMode);
    const run = this.taskStore.createRun({
      sessionId,
      source,
      userInput: normalizedInput,
    });
    await this.hooks?.emit("beforeRun", {
      run,
      payload: { input: normalizedInput, sessionId, source, permissionMode },
    });
    let delegatedTo: string[] = [];
    let planSummary: MainAgentResult["plan"];
    let subResults: Array<{ agent: string; role: string; taskId: string; status: string; content: string }> = [];
    let reviewerVerdict: ReviewerVerdict | undefined;

    try {
      await this.remember({
        scope: sessionId,
        kind: "message:user",
        content: normalizedInput,
        metadata: { source, runId: run.id, permissionMode },
      });

      const intent = classifyUserMessageIntent(normalizedInput);
      if (intent === "chat") {
        if (isModelIdentityQuestion(normalizedInput)) {
          const content = formatCurrentModelAnswer(this.model);
          await this.remember({
            scope: sessionId,
            kind: "message:assistant",
            content,
            metadata: {
              source: "main-agent",
              runId: run.id,
              intent,
              delegatedTo: [],
              answeredFrom: "runtime_model_config",
            },
          });
          this.taskStore.completeRun(run.id, "done");
          await this.hooks?.emit("afterRun", {
            run: this.taskStore.getRun(run.id) || run,
            payload: {
              status: "done",
              intent,
              delegatedTo: [],
              answeredFrom: "runtime_model_config",
            },
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
        const content = await this.answerDirectChat({
          input: normalizedInput,
          runId: run.id,
          sessionId,
          relevantMemory,
          relevantExperiences,
        });
        for (const experience of relevantExperiences) {
          this.experienceStore.recordUse(experience.id);
        }
        await this.remember({
          scope: sessionId,
          kind: "message:assistant",
          content,
          metadata: {
            source: "main-agent",
            runId: run.id,
            intent,
            delegatedTo: [],
          },
        });
        await this.approveRunMemoryCandidates(run.id);
        this.taskStore.completeRun(run.id, "done");
        await this.hooks?.emit("afterRun", {
          run: this.taskStore.getRun(run.id) || run,
          payload: {
            status: "done",
            intent,
            delegatedTo: [],
          },
        });
        return {
          agent: this.name,
          runId: run.id,
          content,
          delegatedTo: [],
          memory: relevantMemory,
          experiences: relevantExperiences,
          subResults: [],
        };
      }

      if (!isPlanningOnlyRequest(normalizedInput) && requiresDeliveryLevelClarification(normalizedInput)) {
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

      const selectedAgents = this.selectSubAgents(normalizedInput);
      delegatedTo = selectedAgents;
      const planOnly = isPlanningOnlyRequest(normalizedInput);
      const delegated = await this.delegateTasks({
        input: normalizedInput,
        sessionId,
        source,
        runId: run.id,
        selectedAgents,
        permissionMode,
        planOnly,
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

      if (delegated.planOnly) {
        const content = formatPlanOnlyResponse(delegated.plan, {
          runId: run.id,
          graphId: delegated.graphId || "",
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
            planOnly: true,
            graphId: delegated.graphId || "",
          },
        });
        for (const result of subResults) {
          this.taskStore.acknowledgeTask(result.taskId);
        }
        await this.approveRunMemoryCandidates(run.id);
        this.taskStore.completeRun(run.id, "done");
        await this.hooks?.emit("afterRun", {
          run: this.taskStore.getRun(run.id) || run,
          payload: {
            status: "done",
            delegatedTo,
            planOnly: true,
            graphId: delegated.graphId || "",
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
      }

      const content = await this.synthesizeResponse({
        input: normalizedInput,
        runId: run.id,
        sessionId,
        relevantMemory,
        relevantExperiences,
        plan: delegated.plan,
        subResults,
        reviewerVerdict,
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
    permissionMode,
    planOnly = false,
  }: {
    input: string;
    sessionId: string;
    source: string;
    runId: string;
    selectedAgents: string[];
    permissionMode?: ReturnType<typeof parsePermissionMode>;
    planOnly?: boolean;
  }): Promise<{
    subResults: Array<{ agent: string; role: string; taskId: string; status: string; content: string }>;
    reviewerVerdict?: ReviewerVerdict;
    delegatedTo: string[];
    plan: PlanSpec;
    pause?: UserInputPause;
    planOnly?: boolean;
    graphId?: string;
  }> {
    const results = [];
    let reviewerVerdict: ReviewerVerdict | undefined;

    const planningPrompt = plannerPrompt(input, inferDeliveryLevel(input) || "poc", this.roleTaskTimeoutMs);
    const planningGraph = createTaskGraph({
      taskStore: this.taskStore,
      baseMetadata: {
        sessionId,
        source,
        runId,
        createdBy: this.name,
        timeoutMs: this.plannerTaskTimeoutMs,
        maxResultChars: 12000,
        maxMemoryCandidates: 1,
        permissionMode: permissionMode || "workspace_write",
        ...runtimeWebSearchMetadata(),
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

    const finishedPlanner = await this.roleAgentManager.runTask(plannerTask, {
      timeoutMs: this.plannerTaskTimeoutMs + 5000,
    });
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

    if (plan.clarificationRequired && shouldOverridePlannerClarification(input, plan)) {
      this.taskStore.addEvent({
        type: "runtime.anomaly",
        taskId: finishedPlanner.id,
        payload: {
          severity: "warning",
          code: "planner_clarification_overridden",
          message: "Planner asked for source or web-search confirmation even though the request already gave an actionable research/search instruction; fallback execution plan was used.",
          questions: plan.clarificationQuestions,
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

    if (planOnly) {
      plan = createPlanningOnlyPlanSpec(input, selectedAgents, plan);
      const plannedTasks = createTaskGraphFromPlan({
        taskStore: this.taskStore,
        plan,
        baseMetadata: {
          sessionId,
          source,
          runId,
          createdBy: this.name,
          planSourceTaskId: finishedPlanner.id,
          permissionMode: permissionMode || "workspace_write",
          planOnly: true,
          executionState: "draft",
          ...runtimeWebSearchMetadata(),
        },
        roleTaskTimeoutMs: this.roleTaskTimeoutMs,
      });
      const graphId = String(Object.values(plannedTasks)[0]?.metadata.graphId || "");
      this.taskStore.refreshTaskGraphStatuses();
      return {
        subResults: results,
        reviewerVerdict,
        delegatedTo: ["planner"],
        plan,
        planOnly: true,
        graphId,
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
        permissionMode: permissionMode || "workspace_write",
        ...runtimeWebSearchMetadata(),
      },
      roleTaskTimeoutMs: this.roleTaskTimeoutMs,
    });
    const executor = new TaskGraphExecutor({
      taskStore: this.taskStore,
      roleAgentManager: this.roleAgentManager,
      plan,
      roleTaskTimeoutMs: this.roleTaskTimeoutMs,
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
        const reviewInputs = results.filter((result) => result.role !== "planner");
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
            ...reviewInputs.map((result) => `- ${result.role} ${result.status}: ${result.content}`),
          ].join("\n"),
          metadata: {
            sessionId,
            source,
            runId,
            createdBy: this.name,
            graphRole: "reviewer",
            graphId: execution.graphId || "",
            acceptanceCriteria: plan.review.criteria,
            permissionMode: permissionMode || "workspace_write",
            timeoutMs: this.roleTaskTimeoutMs,
          },
        });
        for (const result of reviewInputs) {
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
    reviewerVerdict,
  }: {
    input: string;
    runId?: string;
    sessionId?: string;
    relevantMemory: MemoryRecallResult;
    relevantExperiences: ExperienceRecallResult[];
    plan?: PlanSpec;
    subResults: Array<{ agent: string; content: string }>;
    reviewerVerdict?: ReviewerVerdict;
  }): Promise<string> {
    const prompt = [
      `User input: ${input}`,
      `Relevant memory count: ${relevantMemory.semantic.length + relevantMemory.shortTerm.length}`,
      "Relevant active experiences:",
      ...formatExperiences(relevantExperiences),
      "Execution plan:",
      ...(plan ? formatPlan(plan) : ["- (none)"]),
      "Reviewer verdict:",
      ...(reviewerVerdict ? formatReviewerVerdict(reviewerVerdict) : ["- (none)"]),
      "Sub-agent results:",
      ...subResults.map((result) => `- ${result.agent}: ${result.content}`),
      "",
      "Write a concise, helpful response in Chinese.",
    ].join("\n");

    const result = await this.completeWithMainModel({
      agent: this.name,
      role: "Communicate with the user and coordinate sub-agents.",
      prompt,
      runId,
      source: sessionId ? `session:${sessionId}` : "main-agent",
      phase: "synthesize",
    });
    if (reviewerVerdict?.verdict === "fail" && !/(未通过|失败|没有完成|未完成|不能按已完成处理)/.test(result.content)) {
      return [
        "这次执行未通过验证，不能按已完成处理。",
        "",
        result.content,
        "",
        "Reviewer:",
        ...formatReviewerVerdict(reviewerVerdict),
      ].join("\n");
    }
    return result.content;
  }

  async answerDirectChat({
    input,
    runId,
    sessionId,
    relevantMemory,
    relevantExperiences,
  }: {
    input: string;
    runId?: string;
    sessionId?: string;
    relevantMemory: MemoryRecallResult;
    relevantExperiences: ExperienceRecallResult[];
  }): Promise<string> {
    const prompt = [
      "Conversation mode: direct_chat",
      `User input: ${input}`,
      `Relevant memory count: ${relevantMemory.semantic.length + relevantMemory.shortTerm.length}`,
      "Relevant active experiences:",
      ...formatExperiences(relevantExperiences),
      "",
      "Reply naturally and concisely in Chinese.",
      "Do not create a task plan, delegate to sub-agents, or ask for task scope unless the user explicitly asks you to do work.",
    ].join("\n");

    const result = await this.completeWithMainModel({
      agent: this.name,
      role: "Direct conversation without task delegation.",
      prompt,
      runId,
      source: sessionId ? `session:${sessionId}` : "main-agent",
      phase: "direct_chat",
    });
    return result.content;
  }

  private async completeWithMainModel({
    agent,
    role,
    prompt,
    runId,
    source,
    phase,
  }: {
    agent: string;
    role: string;
    prompt: string;
    runId?: string;
    source?: string;
    phase: string;
  }) {
    const payload = {
      agent,
      role,
      runId: runId || "",
      source: source || "",
      phase,
      providerId: this.model.id,
      model: this.model.model,
    };
    await this.hooks?.emit("beforeModelComplete", { payload });
    try {
      const result = normalizeModelCompleteResult(await this.model.complete({
        agent,
        role,
        prompt,
        runId,
        source,
      }), this.model);
      await this.hooks?.emit("afterModelComplete", {
        payload: {
          ...payload,
          finishReason: result.finishReason || "",
          latencyMs: result.latencyMs || 0,
          providerId: result.providerId || this.model.id,
          model: result.model || this.model.model,
        },
      });
      return result;
    } catch (error) {
      await this.hooks?.emit("afterModelComplete", {
        payload: {
          ...payload,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }
}

export function classifyUserMessageIntent(input: string): "chat" | "task" {
  const normalized = input.trim();
  const compact = normalized.replace(/\s+/g, "");
  const lower = normalized.toLowerCase();
  if (!normalized) return "chat";

  if (/^(?:hi|hello|hey|ping|test|thanks|thank you|你好|您好|在吗|谢谢|测试|测试消息|随便聊聊|聊聊)[。.!！?？]*$/i.test(compact)) {
    return "chat";
  }
  if (/(?:你是谁|你叫什么|你能做什么|介绍一下你自己|你好吗|how are you|who are you|what can you do)/i.test(normalized)) {
    return "chat";
  }

  if (/(?:poc|mvp|uat|production|prod|实现|开发|修复|修改|重构|调试|排查|优化|部署|安装|配置|创建|新增|删除|更新|运行|测试|检查|审查|扫描|生成|写|设计|规划|计划|拆解|拆成|任务图|思维导图|做一个|搭建|接入|迁移|发布|提交|推送|搜索|搜一下|查找|检索|联网|新闻|最新|动态|commit|push|build|implement|fix|debug|refactor|create|update|delete|run|test|review|scan|deploy|install|configure|design|plan|decompose|write|generate|analyze|summarize|search|latest|news)/i.test(normalized)) {
    return "task";
  }
  if (/(?:帮我|请你|麻烦|能不能|可以帮|需要你|我想要|我要|给我).{0,16}(?:做|写|改|查|看|跑|测|建|实现|修|设计|规划|计划|拆解|生成|分析|总结|创建|配置|部署)/.test(normalized)) {
    return "task";
  }
  if (/(?:[\w.-]+\/[\w./-]+|`[^`]+`|```|error:|exception|stack trace|报错|失败|崩溃)/i.test(normalized)) {
    return "task";
  }

  if (/[?？]$/.test(normalized) && !/(?:代码|文件|项目|仓库|repo|bug|接口|api|实现|修复|部署|配置|测试|报错|搜索|查找|联网|新闻|最新|动态|search|latest|news)/i.test(normalized)) {
    return "chat";
  }
  if ([...compact].length <= 18) return "chat";
  return "task";
}

export function isPlanningOnlyRequest(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) return false;
  const asksForPlan = /(?:规划|计划|拆解|拆成|任务图|思维导图|roadmap|plan|decompose|break down)/i.test(normalized);
  if (!asksForPlan) return false;
  return /(?:不要|不用|先别|暂不|别|无需).{0,16}(?:实现|执行|开发|写代码|动手|开工|run|execute|implement|code)|(?:只|仅).{0,8}(?:规划|计划|拆解|列出)|(?:先|先帮我).{0,8}(?:规划|计划|拆解)(?!.*(?:实现|执行|开发|写代码|implement|execute))/i.test(normalized);
}

function shouldOverridePlannerClarification(input: string, plan: PlanSpec): boolean {
  if (!plan.clarificationRequired) return false;
  const assessment = assessTaskComplexity(input);
  if (assessment.kind !== "research_comparison" && assessment.kind !== "research") return false;
  if (!hasActionableResearchSource(input) && !isExplicitWebSearchRequest(input)) return false;
  const questions = plan.clarificationQuestions.join("\n");
  return /无法直接访问|提供.*功能列表|通过其他方式获取信息|本地代码|深入分析|当前工具限制|搜索互联网|新闻来源|允许使用.*web[_-]?search|web[_-]?search|feature list|cannot access|provide.*features|search the internet|use web[_-]?search/i.test(questions);
}

function hasActionableResearchSource(input: string): boolean {
  return /https?:\/\/[^\s`"'<>]+/i.test(input)
    || /(?:^|[\s`'"])(?:\/[A-Za-z0-9._-][^\s`'"]+|~\/[^\s`'"]+)/.test(input)
    || /(?:^|[\s`'"])\.{1,2}\/[^\s`'"]+/.test(input);
}

function isExplicitWebSearchRequest(input: string): boolean {
  return /(?:搜索|搜一下|查找|检索|联网|新闻|最新|动态|互联网|\bsearch\b|\blatest\b|\bnews\b|\bcurrent\b|\binternet\b|\bweb\b)/i.test(input);
}

function runtimeWebSearchMetadata(): Metadata {
  const metadata: Metadata = {};
  if (process.env.EMILY_WEB_SEARCH_PROVIDER) metadata.webSearchProvider = process.env.EMILY_WEB_SEARCH_PROVIDER;
  if (process.env.EMILY_WEB_SEARCH_ENDPOINT) metadata.webSearchEndpoint = process.env.EMILY_WEB_SEARCH_ENDPOINT;
  if (process.env.EMILY_WEB_SEARCH_METHOD) metadata.webSearchMethod = process.env.EMILY_WEB_SEARCH_METHOD;
  return metadata;
}

function isModelIdentityQuestion(input: string): boolean {
  const normalized = input.trim();
  if (/(?:搜索|搜一下|查找|检索|联网|新闻|最新|动态|\bsearch\b|\blatest\b|\bnews\b|\bcurrent\b)/i.test(normalized)) return false;
  if (!/(?:模型|model|provider)/i.test(normalized)) return false;
  return /(?:现在|当前|正在|你|系统|主模型|使用|用的|用的是|哪个|哪一个|什么|啥).{0,20}(?:模型|model|provider)|(?:模型|model|provider).{0,20}(?:哪个|哪一个|什么|啥|版本|名称|名字|provider)/i.test(normalized);
}

function formatCurrentModelAnswer(model: ModelProvider): string {
  return [
    `当前主模型是 ${model.model}。`,
    `Provider: ${model.id}`,
  ].join("\n");
}

function plannerPrompt(input: string, deliveryLevel: string, roleTaskTimeoutMs = DEFAULT_ROLE_TASK_TIMEOUT_MS): string {
  const assessment = assessTaskComplexity(input);
  return [
    "Create a PlanSpec JSON object for an outcome-oriented DAG.",
    "Return only JSON. Do not wrap it in markdown.",
    "",
    "DAG model:",
    "- Treat the DAG like a mind map that decomposes the user's goal from coarse to fine.",
    "- Start from the desired end result and work backward into the process, deliverables, and verification needed to reach it.",
    "- The user should not have to name the decomposition dimensions; infer them from the task type and delivery level.",
    "- parentKey is the decomposition parent: goal/root -> module/workstream -> feature slice -> executable leaf.",
    "- dependsOn is only the execution gate between nodes; do not use it as a substitute for parentKey.",
    "- Early nodes should map and narrow the problem. Leaf nodes should execute or verify concrete work.",
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
        parentKey: "parent decomposition key, or empty for the root layer",
        dependsOn: [],
        dependencyType: "success",
        acceptanceCriteria: ["string"],
        toolHints: [],
        skillHints: [],
        timeoutMs: roleTaskTimeoutMs,
        maxRetries: 1,
        maxResultChars: 12000,
        maxMemoryCandidates: 1,
        wave: 1,
        expandable: false,
        expansionGoal: "",
        maxExpansionDepth: 0,
        permissionMode: "workspace_write",
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
    "- For long product/application work, decompose by goal -> module/workstream -> feature slice -> verification.",
    "- For application or CLI POC work, default to modules like requirements scope, data/domain model, interface or command surface, persistence/state, implementation slices, and validation.",
    "- For bug/fix work, default to reproduce -> isolate -> patch -> regression validation.",
    "- For research/document work, default to research questions -> source strategy -> synthesis -> validation.",
    "- For rolling mode, keep the initial graph coarse and mark non-leaf nodes that should expand later with expandable=true.",
    "- Expandable tasks should describe how to expand one level finer in expansionGoal and maxExpansionDepth.",
    "- Do not flatten a large request directly into implementation tasks; preserve the coarse-to-fine hierarchy.",
    "- A task with parentKey must be a child of an existing task key in the same PlanSpec.",
    "- Each task must have acceptanceCriteria.",
    "- Use dependencies instead of prose ordering.",
    "- Keep the first wave small enough to execute now; use planningMode=rolling for larger goals.",
    "- Use deliveryLevel to decide exit criteria: poc, uat, production.",
    "- Use the task assessment before choosing a decomposition. Long tasks are not only software builds; research comparisons can also be long when they require multiple evidence-gathering and synthesis nodes.",
    "- For research_comparison, do not ask for POC/UAT/production as user-facing standards. Decompose into comparison scope, source inventory, per-subject facts, comparison matrix, synthesis, and validation.",
    "- If the user provides a URL or local source path for research_comparison/research work, do not ask the user to paste feature lists just because a website must be fetched. Create researcher tasks with http_fetch/web_search/browser hints and let execution gather evidence.",
    "- If the user explicitly asks to search, get news, get latest/current information, or use the internet, do not ask whether web_search is allowed. Treat that wording as the user's network-read intent and create researcher tasks with web_search hints.",
    "- For single_long_operation, separate preparation, execution/monitoring, timeout handling, and verification only when those are real work products; do not pretend one blocking wait is many implementation nodes.",
    "- If the user asks to create, write, generate, or save code/files to a path, include one explicit developer leaf that names the target file path(s), requests write_file, and materializes the final artifact. Design-only or setup subtasks should not claim file creation.",
    "- task.permissionMode is optional; omit it to inherit the run mode, or use read_only/workspace_write/danger_full_access when a task needs a narrower or explicit guardrail.",
    "",
    "Task assessment:",
    `- kind: ${assessment.kind}`,
    `- complexityClass: ${assessment.complexityClass}`,
    `- longTask: ${assessment.longTask}`,
    `- splittable: ${assessment.splittable}`,
    `- estimatedNodes: ${assessment.estimatedNodes}`,
    "- reasons:",
    ...assessment.reasons.map((reason) => `  - ${reason}`),
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
    ...plan.tasks.map((task) => `  - ${task.key} [${task.role}] parent=${task.parentKey || "(root)"} wave=${task.wave} dependsOn=${task.dependsOn.join(",") || "(none)"}`),
  ];
}

function formatReviewerVerdict(verdict: ReviewerVerdict): string[] {
  return [
    `- verdict: ${verdict.verdict}`,
    `- confidence: ${verdict.confidence}`,
    `- retrySuggested: ${verdict.retrySuggested}`,
    "- reasons:",
    ...(verdict.reasons.length ? verdict.reasons.map((reason) => `  - ${reason}`) : ["  - (none)"]),
  ];
}

function formatPlanOnlyResponse(plan: PlanSpec, { runId, graphId }: { runId: string; graphId: string }): string {
  const assessment = assessTaskComplexity(plan.goal);
  const standardLabel = assessment.kind === "research_comparison" || assessment.kind === "research"
    ? "内部深度档"
    : "准出等级";
  const childrenByParent = new Map<string, PlanSpec["tasks"]>();
  for (const task of plan.tasks) {
    const parent = task.parentKey || "";
    childrenByParent.set(parent, [...(childrenByParent.get(parent) || []), task]);
  }
  const roots = childrenByParent.get("") || [];
  const moduleParents = roots.length === 1 ? roots.map((root) => root.key) : [""];
  const modules = moduleParents.flatMap((parent) => childrenByParent.get(parent) || [])
    .filter((task) => (childrenByParent.get(task.key) || []).length);
  const leaves = plan.tasks.filter((task) => !(childrenByParent.get(task.key) || []).length);
  return [
    "已按结果导向生成 DAG，暂不执行实现任务。",
    "",
    `Run: ${runId}`,
    graphId ? `Graph: ${graphId}` : "",
    `目标：${plan.goal}`,
    `${standardLabel}：${plan.deliveryLevel.toUpperCase()}`,
    `节点：${plan.tasks.length} 个，叶子任务：${leaves.length} 个`,
    "",
    "反推逻辑：先定义目标和验收结果，再拆模块，最后落到可执行叶子任务和验证节点。",
    "",
    "模块：",
    ...(modules.length ? modules.map((task) => `- ${task.title} (${task.key})`) : ["- 已生成可编辑任务节点"]),
    "",
    "可以继续：",
    `- /dag ${runId} 查看和编辑这棵 DAG`,
    "- /dag list 查看所有 DAG 根节点",
  ].filter(Boolean).join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function legacySelectSubAgents(input: string): string[] {
  const lower = input.toLowerCase();
  const agents = ["planner"];
  const assessment = assessTaskComplexity(input);
  if (assessment.kind === "research_comparison" || assessment.kind === "research") {
    agents.push("researcher");
    return agents;
  }
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
