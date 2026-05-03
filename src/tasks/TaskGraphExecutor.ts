import {
  createFallbackGraphPatch,
  parseGraphPatchSpec,
  validateGraphPatchSpec,
  type GraphPatchSpec,
  type PlanSpec,
  type PlanTaskSpec,
} from "../planning/PlanSpec.ts";
import { taskResultSummary } from "./TaskResult.ts";
import type { Metadata, Task, TaskDependency, TaskStatus } from "../types.ts";
import type { RoleAgentManager } from "./RoleAgentManager.ts";
import type { TaskStore } from "./TaskStore.ts";

const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed", "blocked", "cancelled", "dead_letter"]);

export interface TaskGraphExecutionResult {
  completed: Task[];
  blocked: Task[];
  failed: Task[];
  graphId: string | null;
  expanded: Task[];
  internal: Task[];
  pause: TaskGraphPause | null;
  quality: TaskGraphQuality;
}

export interface TaskGraphQuality {
  score: number;
  issues: string[];
  recommendations: string[];
  taskCount: number;
  failedCount: number;
  activeFailedCount: number;
  recoveredFailureCount: number;
  blockedCount: number;
  dynamicCount: number;
  failureClusters: Record<string, number>;
  failureRisk: number;
  budget: {
    maxParallelTasks: number;
    finalParallelTasks: number;
    maxDynamicTasks: number;
    maxReplanAttempts: number;
    expandedTasks: number;
  };
}

export interface TaskGraphPause {
  reason: string;
  questions: string[];
  taskId: string;
  plannerTaskId?: string;
  source: "planner" | "fallback";
}

interface ExpansionResult {
  plannerTask: Task | null;
  created: Task[];
  pause: TaskGraphPause | null;
}

export class TaskGraphExecutor {
  taskStore: TaskStore;
  roleAgentManager: RoleAgentManager;
  maxParallelTasks: number;
  maxDynamicTasks: number;
  maxReplanAttempts: number;
  plan: PlanSpec | null;

  constructor({
    taskStore,
    roleAgentManager,
    maxParallelTasks = 4,
    maxDynamicTasks = 200,
    maxReplanAttempts = 2,
    plan = null,
  }: {
    taskStore: TaskStore;
    roleAgentManager: RoleAgentManager;
    maxParallelTasks?: number;
    maxDynamicTasks?: number;
    maxReplanAttempts?: number;
    plan?: PlanSpec | null;
  }) {
    this.taskStore = taskStore;
    this.roleAgentManager = roleAgentManager;
    this.maxParallelTasks = maxParallelTasks;
    this.maxDynamicTasks = maxDynamicTasks;
    this.maxReplanAttempts = maxReplanAttempts;
    this.plan = plan;
  }

  async execute(tasksByKey: Record<string, Task>): Promise<TaskGraphExecutionResult> {
    const keys = Object.keys(tasksByKey);
    const pending = new Set(keys);
    const completed: Task[] = [];
    const blocked: Task[] = [];
    const failed: Task[] = [];
    const expanded: Task[] = [];
    const internal: Task[] = [];
    let pause: TaskGraphPause | null = null;
    const recorded = new Set<string>();
    const recordedInternal = new Set<string>();
    const clusteredTerminal = new Set<string>();
    const graphId = graphIdFrom(tasksByKey);
    let effectiveParallelTasks = this.maxParallelTasks;

    const record = (task: Task | null) => {
      if (!task || recorded.has(task.id)) return;
      if (!TERMINAL_STATUSES.has(task.status)) return;
      recorded.add(task.id);
      completed.push(task);
      if (task.status === "blocked") blocked.push(task);
      if (task.status === "failed" || task.status === "dead_letter") failed.push(task);
      if ((task.status === "blocked" || task.status === "failed" || task.status === "dead_letter" || task.status === "cancelled")
        && !clusteredTerminal.has(task.id)) {
        clusteredTerminal.add(task.id);
        this.recordFailureCluster(task, tasksByKey);
      }
    };
    const recordInternal = (task: Task | null) => {
      if (!task || recordedInternal.has(task.id)) return;
      if (!TERMINAL_STATUSES.has(task.status)) return;
      recordedInternal.add(task.id);
      internal.push(task);
    };

    while (pending.size) {
      for (const task of await this.blockUnreachable([...pending].map((key) => tasksByKey[key]).filter(Boolean))) {
        pending.delete(keyFor(tasksByKey, task.id));
        record(task);
      }

      const adjustedParallelTasks = this.adaptiveParallelLimit({
        current: effectiveParallelTasks,
        failedCount: failed.length,
        blockedCount: blocked.length,
        pendingCount: pending.size,
        expandedCount: expanded.length,
        failureRisk: failureRiskForTasks([...failed, ...blocked]),
      });
      if (adjustedParallelTasks !== effectiveParallelTasks) {
        effectiveParallelTasks = adjustedParallelTasks;
        this.taskStore.addEvent({
          type: "task_graph.budget_adjusted",
          payload: {
            graphId: graphId || "",
            runId: runIdFrom(tasksByKey) || "",
            maxParallelTasks: this.maxParallelTasks,
            effectiveParallelTasks,
            failedCount: failed.length,
            blockedCount: blocked.length,
            pendingCount: pending.size,
          },
        });
      }

      const ready = [...pending]
        .map((key) => tasksByKey[key])
        .filter((task) => {
          const status = task ? this.taskStore.getTask(task.id)?.status : null;
          return status === "pending" || status === "queued";
        })
        .filter((task) => this.taskStore.dependenciesSatisfied(task.id))
        .slice(0, effectiveParallelTasks);

      if (!ready.length) {
        for (const task of await this.blockRemaining([...pending].map((key) => tasksByKey[key]).filter(Boolean), "no executable tasks remain")) {
          pending.delete(keyFor(tasksByKey, task.id));
          record(task);
        }
        break;
      }

      const finished = await Promise.all(ready.map((task) => this.runOne(task)));
      for (const task of finished) {
        pending.delete(keyFor(tasksByKey, task.id));
        record(task);
        if (pause) continue;
        const replan = await this.replanTaskIfNeeded(task, tasksByKey);
        recordInternal(replan.plannerTask);
        if (replan.pause) {
          pause = replan.pause;
          for (const blockedTask of await this.blockRemaining(
            [...pending].map((key) => tasksByKey[key]).filter(Boolean),
            `waiting for user input: ${replan.pause.reason}`,
          )) {
            pending.delete(keyFor(tasksByKey, blockedTask.id));
            record(blockedTask);
          }
          pending.clear();
          continue;
        }
        for (const replannedTask of replan.created) {
          pending.add(String(replannedTask.metadata.graphKey));
          expanded.push(replannedTask);
        }
        const expansion = await this.expandTaskIfNeeded(task, tasksByKey);
        recordInternal(expansion.plannerTask);
        if (expansion.pause) {
          pause = expansion.pause;
          for (const blockedTask of await this.blockRemaining(
            [...pending].map((key) => tasksByKey[key]).filter(Boolean),
            `waiting for user input: ${expansion.pause.reason}`,
          )) {
            pending.delete(keyFor(tasksByKey, blockedTask.id));
            record(blockedTask);
          }
          pending.clear();
          continue;
        }
        for (const expandedTask of expansion.created) {
          pending.add(String(expandedTask.metadata.graphKey));
          expanded.push(expandedTask);
        }
      }
    }

    this.taskStore.refreshTaskGraphStatuses();
    const quality = assessGraphQuality({
      tasksByKey,
      completed,
      blocked,
      failed,
      expanded,
      budget: {
        maxParallelTasks: this.maxParallelTasks,
        finalParallelTasks: effectiveParallelTasks,
        maxDynamicTasks: this.maxDynamicTasks,
        maxReplanAttempts: this.maxReplanAttempts,
        expandedTasks: expanded.length,
      },
    });
    if (graphId) {
      this.taskStore.addEvent({
        type: "task_graph.quality",
        payload: {
          graphId,
          runId: runIdFrom(tasksByKey) || "",
          ...quality,
        },
      });
    }
    return { completed, blocked, failed, graphId, expanded, internal, pause, quality };
  }

  private async runOne(task: Task): Promise<Task> {
    try {
      return await this.roleAgentManager.runTask(task, {
        timeoutMs: readPositiveNumber(task.metadata.timeoutMs, 60000),
      });
    } catch {
      return this.taskStore.getTask(task.id) || task;
    }
  }

  private async blockUnreachable(tasks: Task[]): Promise<Task[]> {
    const blocked: Task[] = [];
    for (const task of tasks) {
      const current = this.taskStore.getTask(task.id);
      if (!current || current.status !== "pending") continue;
      const failedDependency = this.failedSuccessDependency(current.id);
      if (!failedDependency) continue;
      blocked.push(await this.blockTask(current, `dependency ${failedDependency.dependsOnTaskId} finished with status ${failedDependency.status}`));
    }
    return blocked;
  }

  private async blockRemaining(tasks: Task[], reason: string): Promise<Task[]> {
    const blocked: Task[] = [];
    for (const task of tasks) {
      const current = this.taskStore.getTask(task.id);
      if (!current || current.status !== "pending") continue;
      blocked.push(await this.blockTask(current, reason));
    }
    return blocked;
  }

  private async blockTask(task: Task, reason: string): Promise<Task> {
    this.taskStore.transitionTask(task.id, "blocked", {
      reason,
      error: reason,
      metadata: {
        ...task.metadata,
        blockedReason: reason,
        blockedAt: new Date().toISOString(),
      },
    });
    await this.taskStore.writeTaskMarkdown(task.id);
    return this.taskStore.getTaskOrThrow(task.id);
  }

  private failedSuccessDependency(taskId: string): (TaskDependency & { status: TaskStatus }) | null {
    for (const dependency of this.taskStore.getDependencies(taskId)) {
      if (dependency.dependencyType !== "success") continue;
      const dependsOn = this.taskStore.getTask(dependency.dependsOnTaskId);
      if (!dependsOn || !TERMINAL_STATUSES.has(dependsOn.status)) continue;
      if (dependsOn.status !== "done") {
        return {
          ...dependency,
          status: dependsOn.status,
        };
      }
    }
    return null;
  }

  private async expandTaskIfNeeded(task: Task, tasksByKey: Record<string, Task>): Promise<ExpansionResult> {
    if (!this.plan || this.plan.planningMode !== "rolling") return emptyExpansion();
    if (task.status !== "done") return emptyExpansion();
    if (task.metadata.expandable !== true) return emptyExpansion();
    const parentKey = typeof task.metadata.graphKey === "string" ? task.metadata.graphKey : "";
    if (!parentKey) return emptyExpansion();
    const currentDepth = readNonNegativeNumber(task.metadata.expansionDepth, 0);
    const maxDepth = readNonNegativeNumber(task.metadata.maxExpansionDepth, 0);
    if (currentDepth >= maxDepth) return emptyExpansion();
    const availableSlots = this.maxDynamicTasks - Object.keys(tasksByKey).length;
    if (availableSlots <= 0) {
      this.taskStore.addEvent({
        type: "task_graph.budget_exhausted",
        taskId: task.id,
        payload: {
          graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
          maxDynamicTasks: this.maxDynamicTasks,
          currentTasks: Object.keys(tasksByKey).length,
        },
      });
      return emptyExpansion();
    }

    const planned = await this.planGraphPatch({
      task,
      tasksByKey,
      currentDepth,
      maxDepth,
      availableSlots,
    });
    const patch = planned.patch;
    if (patch.needsUserInput) {
      const pause: TaskGraphPause = {
        reason: patch.reason,
        questions: patch.questions,
        taskId: task.id,
        plannerTaskId: planned.plannerTask?.id,
        source: planned.source,
      };
      this.taskStore.addEvent({
        type: "task_graph.waiting_user",
        taskId: task.id,
        payload: {
          graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
          parentKey,
          reason: patch.reason,
          source: planned.source,
          plannerTaskId: planned.plannerTask?.id || "",
          questions: patch.questions,
        },
      });
      return { plannerTask: planned.plannerTask, created: [], pause };
    }
    const taskSpecs = patch.tasks.slice(0, availableSlots);
    if (!taskSpecs.length) return { plannerTask: planned.plannerTask, created: [], pause: null };
    this.taskStore.addEvent({
      type: "task_graph.expanded",
      taskId: task.id,
      payload: {
        graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
        parentKey,
        reason: patch.reason,
        source: planned.source,
        plannerTaskId: planned.plannerTask?.id || "",
        addedTasks: taskSpecs.map((item) => item.key),
      },
    });
    const created = this.createDynamicTasks(taskSpecs, task, tasksByKey, currentDepth + 1);
    return { plannerTask: planned.plannerTask, created, pause: null };
  }

  private async replanTaskIfNeeded(task: Task, tasksByKey: Record<string, Task>): Promise<ExpansionResult> {
    if (!this.plan || this.plan.failureStrategy !== "replan") return emptyExpansion();
    if (task.status !== "failed" && task.status !== "dead_letter") return emptyExpansion();
    const graphKey = typeof task.metadata.graphKey === "string" ? task.metadata.graphKey : "";
    if (!graphKey) return emptyExpansion();
    const attempts = Object.values(tasksByKey).filter((item) => item.metadata.replannedFromTaskId === task.id).length;
    if (attempts >= this.maxReplanAttempts) {
      this.taskStore.addEvent({
        type: "task_graph.replan_skipped",
        taskId: task.id,
        payload: {
          graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
          graphKey,
          reason: "replan budget exhausted",
          attempts,
          maxReplanAttempts: this.maxReplanAttempts,
        },
      });
      return emptyExpansion();
    }
    const availableSlots = this.maxDynamicTasks - Object.keys(tasksByKey).length;
    if (availableSlots <= 0) return emptyExpansion();
    const failureCluster = classifyFailure(task);
    const maxNewTasks = this.replanTaskBudget({
      availableSlots,
      failureCluster,
      attempt: attempts + 1,
    });

    const plannerTask = this.createReplanPlannerTask({
      failedTask: task,
      existingKeys: new Set(Object.keys(tasksByKey)),
      maxNewTasks,
      attempt: attempts + 1,
      failureCluster,
    });
    this.taskStore.addTaskDependency(plannerTask.id, task.id, "finished");
    const finishedPlanner = await this.runOne(plannerTask);
    this.taskStore.addEvent({
      type: "task_graph.replan_planned",
      taskId: task.id,
      payload: {
        graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
        graphKey,
        plannerTaskId: finishedPlanner.id,
        plannerStatus: finishedPlanner.status,
        attempt: attempts + 1,
        failureCluster,
        maxNewTasks,
      },
    });

    if (finishedPlanner.status !== "done") {
      this.recordPatchAnomaly(finishedPlanner, "planner_replan_failed", [`Replan planner finished with status ${finishedPlanner.status}.`]);
      return { plannerTask: finishedPlanner, created: [], pause: null };
    }
    const parsed = parseGraphPatchSpec(taskResultSummary(finishedPlanner.result, ""), { parentKey: graphKey });
    if (!parsed) {
      this.recordPatchAnomaly(finishedPlanner, "planner_replan_unparseable", ["Replan planner returned no valid GraphPatchSpec JSON."]);
      return { plannerTask: finishedPlanner, created: [], pause: null };
    }
    const validation = validateGraphPatchSpec(parsed, {
      parentKey: graphKey,
      existingKeys: new Set(Object.keys(tasksByKey)),
      maxTasks: maxNewTasks,
      maxWave: readNonNegativeNumber(task.metadata.maxWaves, this.plan.maxWaves || 100),
    });
    if (!validation.ok) {
      this.recordPatchAnomaly(finishedPlanner, "planner_replan_invalid", validation.errors);
      return { plannerTask: finishedPlanner, created: [], pause: null };
    }
    const replanQuality = assessPatchQuality(parsed, {
      failedTask: task,
      existingKeys: new Set(Object.keys(tasksByKey)),
      failureCluster,
      maxNewTasks,
    });
    this.taskStore.addEvent({
      type: "task_graph.replan_quality",
      taskId: task.id,
      payload: {
        graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
        graphKey,
        plannerTaskId: finishedPlanner.id,
        failureCluster,
        ...replanQuality,
      },
    });
    if (parsed.needsUserInput) {
      return {
        plannerTask: finishedPlanner,
        created: [],
        pause: {
          reason: parsed.reason,
          questions: parsed.questions,
          taskId: task.id,
          plannerTaskId: finishedPlanner.id,
          source: "planner",
        },
      };
    }
    const specs = parsed.tasks.slice(0, availableSlots).map((spec) => ({
      ...spec,
      metadata: {
        ...(spec.metadata || {}),
        replannedFromTaskId: task.id,
        replanAttempt: attempts + 1,
      },
      dependencyType: spec.dependsOn.includes(graphKey) ? "finished" as const : spec.dependencyType,
    }));
    if (!specs.length) return { plannerTask: finishedPlanner, created: [], pause: null };
    this.taskStore.addEvent({
      type: "task_graph.replanned",
      taskId: task.id,
      payload: {
        graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
        graphKey,
        plannerTaskId: finishedPlanner.id,
        addedTasks: specs.map((item) => item.key),
        qualityScore: replanQuality.score,
        qualityIssues: replanQuality.issues,
      },
    });
    this.markTaskReplanSuperseded(task, {
      plannerTaskId: finishedPlanner.id,
      recoveryKeys: specs.map((item) => item.key),
      qualityScore: replanQuality.score,
    });
    return {
      plannerTask: finishedPlanner,
      created: this.createDynamicTasks(specs, task, tasksByKey, readNonNegativeNumber(task.metadata.expansionDepth, 0) + 1),
      pause: null,
    };
  }

  private async planGraphPatch({
    task,
    tasksByKey,
    currentDepth,
    maxDepth,
    availableSlots,
  }: {
    task: Task;
    tasksByKey: Record<string, Task>;
    currentDepth: number;
    maxDepth: number;
    availableSlots: number;
  }): Promise<{
    patch: GraphPatchSpec;
    plannerTask: Task | null;
    source: "planner" | "fallback";
  }> {
    const parentKey = String(task.metadata.graphKey || "");
    const existingKeys = new Set(Object.keys(tasksByKey));
    const plannerTask = this.createExpansionPlannerTask({
      parentTask: task,
      existingKeys,
      currentDepth,
      maxDepth,
      maxNewTasks: availableSlots,
    });
    this.taskStore.addTaskDependency(plannerTask.id, task.id, "success");

    const finishedPlanner = await this.runOne(plannerTask);
    this.taskStore.addEvent({
      type: "task_graph.expansion_planned",
      taskId: task.id,
      payload: {
        graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
        parentKey,
        plannerTaskId: finishedPlanner.id,
        plannerStatus: finishedPlanner.status,
      },
    });

    if (finishedPlanner.status === "done") {
      const parsed = parseGraphPatchSpec(taskResultSummary(finishedPlanner.result, ""), { parentKey });
      if (parsed) {
        const validation = validateGraphPatchSpec(parsed, {
          parentKey,
          existingKeys,
          maxTasks: availableSlots,
          maxWave: readNonNegativeNumber(task.metadata.maxWaves, this.plan?.maxWaves || 100),
        });
        if (validation.ok) {
          return { patch: parsed, plannerTask: finishedPlanner, source: "planner" };
        }
        this.recordPatchAnomaly(finishedPlanner, "planner_graph_patch_invalid", validation.errors);
      } else {
        this.recordPatchAnomaly(finishedPlanner, "planner_graph_patch_unparseable", ["Planner returned no valid GraphPatchSpec JSON."]);
      }
    } else {
      this.recordPatchAnomaly(finishedPlanner, "planner_graph_patch_failed", [`Planner expansion task finished with status ${finishedPlanner.status}.`]);
    }

    return {
      patch: createFallbackGraphPatch({
        plan: this.plan!,
        parentKey,
        existingKeys,
      }),
      plannerTask: finishedPlanner,
      source: "fallback",
    };
  }

  private createExpansionPlannerTask({
    parentTask,
    existingKeys,
    currentDepth,
    maxDepth,
    maxNewTasks,
  }: {
    parentTask: Task;
    existingKeys: Set<string>;
    currentDepth: number;
    maxDepth: number;
    maxNewTasks: number;
  }): Task {
    const parentKey = String(parentTask.metadata.graphKey || "");
    const parentGraphId = typeof parentTask.metadata.graphId === "string" ? parentTask.metadata.graphId : "";
    const graphKey = uniqueInternalKey(`expand_${parentKey}_${currentDepth + 1}`, existingKeys);
    const metadata: Metadata = {
      ...baseGraphMetadata(parentTask),
      graphId: "",
      graphKey,
      graphRole: "planner",
      internalGraph: true,
      parentGraphId,
      planPhase: "graph_expansion",
      parentKey,
      expandsTaskId: parentTask.id,
      expansionDepth: currentDepth,
      maxExpansionDepth: maxDepth,
      timeoutMs: readPositiveNumber(parentTask.metadata.timeoutMs, 30000),
      maxResultChars: 20000,
      maxMemoryCandidates: 0,
      acceptanceCriteria: [
        "Return one valid GraphPatchSpec JSON object.",
        "Only create tasks that move the current graph toward the exit criteria.",
      ],
    };
    return this.taskStore.createTask({
      role: "planner",
      title: `expand graph: ${parentKey}`,
      input: this.graphPatchPrompt({
        parentTask,
        existingKeys,
        currentDepth,
        maxDepth,
        maxNewTasks,
      }),
      parentTaskId: parentTask.id,
      maxRetries: 1,
      metadata,
    });
  }

  private graphPatchPrompt({
    parentTask,
    existingKeys,
    currentDepth,
    maxDepth,
    maxNewTasks,
  }: {
    parentTask: Task;
    existingKeys: Set<string>;
    currentDepth: number;
    maxDepth: number;
    maxNewTasks: number;
  }): string {
    const parentKey = String(parentTask.metadata.graphKey || "");
    return [
      "Create a GraphPatchSpec JSON object to adaptively expand the current rolling task graph.",
      "Return only JSON. Do not wrap it in markdown.",
      "",
      "Required shape:",
      JSON.stringify({
        reason: "why these tasks are the right next decomposition",
        parentKey,
        stop: false,
        needsUserInput: false,
        questions: [],
        tasks: [{
          key: "unique_task_key",
          role: "developer",
          title: "short task title",
          input: "full task instructions with enough context",
          parentKey,
          dependsOn: [parentKey],
          dependencyType: "success",
          acceptanceCriteria: ["string"],
          toolHints: [],
          skillHints: [],
          timeoutMs: 30000,
          maxRetries: 1,
          maxResultChars: 12000,
          maxMemoryCandidates: 1,
          wave: currentDepth + 2,
          expandable: false,
          expansionGoal: "",
          maxExpansionDepth: 0,
          permissionMode: "workspace_write",
        }],
      }, null, 2),
      "",
      "Rules:",
      `- parentKey must be exactly ${parentKey}.`,
      `- Add at most ${Math.max(0, maxNewTasks)} tasks.`,
      "- Task keys must be unique and may contain only letters, numbers, dot, underscore, or dash.",
      "- dependsOn may reference existing graph keys or keys created in this patch.",
      "- If no more work is useful, return stop=true and tasks=[].",
      "- If user input is required, return needsUserInput=true with questions and tasks=[].",
      "- Keep the patch focused on the next executable layer, not the entire project.",
      "- Mark a new task expandable=true only when it should be decomposed again after completion.",
      "- permissionMode is optional; omit it to inherit the run mode, or use read_only/workspace_write/danger_full_access when appropriate.",
      "",
      "Current plan:",
      `goal: ${this.plan?.goal || ""}`,
      `deliveryLevel: ${this.plan?.deliveryLevel || ""}`,
      `planningMode: ${this.plan?.planningMode || ""}`,
      `currentDepth: ${currentDepth}`,
      `maxDepth: ${maxDepth}`,
      "exitCriteria:",
      ...((this.plan?.exitCriteria || []).map((item) => `- ${item}`)),
      "",
      "Existing graph keys:",
      ...[...existingKeys].map((key) => `- ${key}`),
      "",
      "Parent task:",
      `key: ${parentKey}`,
      `role: ${parentTask.role}`,
      `title: ${parentTask.title}`,
      "acceptanceCriteria:",
      ...(Array.isArray(parentTask.metadata.acceptanceCriteria) ? parentTask.metadata.acceptanceCriteria.map((item) => `- ${String(item)}`) : ["- (none)"]),
      "parent result:",
      taskResultSummary(parentTask.result, parentTask.error || "(no result)").slice(0, 6000),
    ].join("\n");
  }

  private recordPatchAnomaly(task: Task, code: string, errors: string[]): void {
    this.taskStore.addEvent({
      type: "runtime.anomaly",
      taskId: task.id,
      payload: {
        severity: "warning",
        code,
        message: "Planner graph patch was not usable; fallback patch will be used.",
        errors,
        repaired: true,
      },
    });
  }

  private createReplanPlannerTask({
    failedTask,
    existingKeys,
    maxNewTasks,
    attempt,
    failureCluster,
  }: {
    failedTask: Task;
    existingKeys: Set<string>;
    maxNewTasks: number;
    attempt: number;
    failureCluster: string;
  }): Task {
    const parentKey = String(failedTask.metadata.graphKey || "");
    const graphKey = uniqueInternalKey(`replan_${parentKey}_${attempt}`, existingKeys);
    const metadata: Metadata = {
      ...baseGraphMetadata(failedTask),
      graphId: "",
      graphKey,
      graphRole: "planner",
      internalGraph: true,
      parentGraphId: typeof failedTask.metadata.graphId === "string" ? failedTask.metadata.graphId : "",
      planPhase: "graph_replan",
      parentKey,
      replansTaskId: failedTask.id,
      replanAttempt: attempt,
      timeoutMs: readPositiveNumber(failedTask.metadata.timeoutMs, 30000),
      maxResultChars: 20000,
      maxMemoryCandidates: 0,
      acceptanceCriteria: [
        "Return one valid GraphPatchSpec JSON object.",
        "Create only recovery tasks that can make progress after the failed task.",
      ],
    };
    return this.taskStore.createTask({
      role: "planner",
      title: `replan graph: ${parentKey}`,
      input: this.replanPrompt({ failedTask, maxNewTasks, attempt, failureCluster }),
      parentTaskId: failedTask.id,
      maxRetries: 1,
      metadata,
    });
  }

  private replanPrompt({
    failedTask,
    maxNewTasks,
    attempt,
    failureCluster,
  }: {
    failedTask: Task;
    maxNewTasks: number;
    attempt: number;
    failureCluster: string;
  }): string {
    const parentKey = String(failedTask.metadata.graphKey || "");
    return [
      "Create a GraphPatchSpec JSON object to replan after a failed task in the current task graph.",
      "Return only JSON. Do not wrap it in markdown.",
      "",
      "Required shape:",
      JSON.stringify({
        reason: "why these recovery tasks are the right next move",
        parentKey,
        stop: false,
        needsUserInput: false,
        questions: [],
        tasks: [{
          key: `recover_${parentKey}`,
          role: failedTask.role,
          title: "recover failed task",
          input: "recover or narrow the failed task",
          parentKey,
          dependsOn: [parentKey],
          dependencyType: "finished",
          acceptanceCriteria: ["Recovery task produces a usable result or a concrete blocker."],
          toolHints: [],
          skillHints: [],
          timeoutMs: 30000,
          maxRetries: 1,
          maxResultChars: 12000,
          maxMemoryCandidates: 1,
          wave: readNonNegativeNumber(failedTask.metadata.wave, 1) + 1,
          expandable: false,
          expansionGoal: "",
          maxExpansionDepth: 0,
          permissionMode: failedTask.metadata.permissionMode || "workspace_write",
        }],
      }, null, 2),
      "",
      "Rules:",
      `- parentKey must be exactly ${parentKey}.`,
      `- Add at most ${Math.max(0, maxNewTasks)} recovery tasks.`,
      "- Recovery tasks may depend on the failed parent with dependencyType=finished.",
      "- Ask for user input if the failure cannot be resolved with current context.",
      "- Do not recreate the same failing task without narrowing scope or changing approach.",
      "- Prefer fewer high-confidence recovery tasks over a broad retry fan-out.",
      "",
      `attempt: ${attempt}`,
      `failure cluster: ${failureCluster}`,
      `failed task role: ${failedTask.role}`,
      `failed task title: ${failedTask.title}`,
      `failed task error: ${failedTask.error || "(none)"}`,
      "failed task result:",
      taskResultSummary(failedTask.result, failedTask.error || "(no result)").slice(0, 6000),
    ].join("\n");
  }

  private createDynamicTasks(
    specs: PlanTaskSpec[],
    parentTask: Task,
    tasksByKey: Record<string, Task>,
    expansionDepth: number,
  ): Task[] {
    const created = specs.map((spec) => {
      const task = this.createDynamicTask(spec, parentTask, expansionDepth);
      tasksByKey[String(task.metadata.graphKey)] = task;
      return { spec, task };
    });

    for (const { spec, task } of created) {
      for (const dependencyKey of spec.dependsOn.length ? spec.dependsOn : [String(parentTask.metadata.graphKey || "")]) {
        const dependency = tasksByKey[dependencyKey];
        if (dependency) {
          this.taskStore.addTaskDependency(task.id, dependency.id, spec.dependencyType);
        } else {
          this.taskStore.addEvent({
            type: "runtime.anomaly",
            taskId: task.id,
            payload: {
              severity: "warning",
              code: "dynamic_dependency_missing",
              message: `Dynamic task dependency was missing: ${dependencyKey}.`,
              dependencyKey,
              repaired: false,
            },
          });
        }
      }
    }

    return created.map((item) => this.taskStore.getTaskOrThrow(item.task.id));
  }

  private adaptiveParallelLimit({
    current,
    failedCount,
    blockedCount,
    pendingCount,
    expandedCount,
    failureRisk,
  }: {
    current: number;
    failedCount: number;
    blockedCount: number;
    pendingCount: number;
    expandedCount: number;
    failureRisk: number;
  }): number {
    const dynamicPressure = this.maxDynamicTasks > 0 ? expandedCount / this.maxDynamicTasks : 1;
    if (failureRisk >= 1.4 || failedCount + blockedCount >= 3) return 1;
    if (dynamicPressure >= 0.9) return 1;
    if (failureRisk >= 0.7 || failedCount || blockedCount) return Math.max(1, Math.min(current, Math.ceil(this.maxParallelTasks / 2)));
    if (dynamicPressure >= 0.75) return Math.max(1, Math.min(current, 2));
    if (pendingCount > this.maxParallelTasks * 2) return this.maxParallelTasks;
    return Math.max(1, Math.min(this.maxParallelTasks, current));
  }

  private replanTaskBudget({
    availableSlots,
    failureCluster,
    attempt,
  }: {
    availableSlots: number;
    failureCluster: string;
    attempt: number;
  }): number {
    return calibratedReplanBudget({
      availableSlots,
      failureCluster,
      attempt,
      deliveryLevel: this.plan?.deliveryLevel,
    });
  }

  private recordFailureCluster(task: Task, tasksByKey: Record<string, Task>): void {
    const graphId = typeof task.metadata.graphId === "string" ? task.metadata.graphId : graphIdFrom(tasksByKey) || "";
    this.taskStore.addEvent({
      type: "task_graph.failure_clustered",
      taskId: task.id,
      payload: {
        graphId,
        runId: runIdFrom(tasksByKey) || "",
        graphKey: typeof task.metadata.graphKey === "string" ? task.metadata.graphKey : "",
        status: task.status,
        cluster: classifyFailure(task),
        retryCount: task.retryCount,
      },
    });
  }

  private markTaskReplanSuperseded(task: Task, {
    plannerTaskId,
    recoveryKeys,
    qualityScore,
  }: {
    plannerTaskId: string;
    recoveryKeys: string[];
    qualityScore: number;
  }): void {
    this.taskStore.updateTaskMetadata(task.id, {
      ...task.metadata,
      replanSupersededAt: new Date().toISOString(),
      replanPlannerTaskId: plannerTaskId,
      replanRecoveryKeys: recoveryKeys,
      replanQualityScore: qualityScore,
    }, {
      reason: "failed task superseded by replan recovery tasks",
    });
  }

  private createDynamicTask(spec: PlanTaskSpec, parentTask: Task, expansionDepth: number): Task {
    const metadata: Metadata = {
      ...baseGraphMetadata(parentTask),
      ...(spec.metadata || {}),
      graphKey: spec.key,
      graphRole: spec.role,
      parentKey: spec.parentKey || String(parentTask.metadata.graphKey || ""),
      expandedFromTaskId: parentTask.id,
      expandedAt: new Date().toISOString(),
      expansionDepth,
      acceptanceCriteria: spec.acceptanceCriteria,
      toolHints: spec.toolHints,
      skillHints: spec.skillHints,
      permissionMode: spec.permissionMode || parentTask.metadata.permissionMode || "workspace_write",
      timeoutMs: spec.timeoutMs,
      maxResultChars: spec.maxResultChars,
      maxMemoryCandidates: spec.maxMemoryCandidates,
      wave: spec.wave,
      expandable: spec.expandable,
      expansionGoal: spec.expansionGoal,
      maxExpansionDepth: spec.maxExpansionDepth,
    };
    const created = this.taskStore.createTask({
      role: spec.role,
      title: spec.title,
      input: spec.input,
      parentTaskId: parentTask.id,
      maxRetries: spec.maxRetries,
      metadata,
    });
    return this.taskStore.getTaskOrThrow(created.id);
  }
}

function graphIdFrom(tasksByKey: Record<string, Task>): string | null {
  for (const task of Object.values(tasksByKey)) {
    if (typeof task.metadata.graphId === "string") return task.metadata.graphId;
  }
  return null;
}

function runIdFrom(tasksByKey: Record<string, Task>): string | null {
  for (const task of Object.values(tasksByKey)) {
    if (typeof task.metadata.runId === "string") return task.metadata.runId;
  }
  return null;
}

function keyFor(tasksByKey: Record<string, Task>, taskId: string): string {
  return Object.entries(tasksByKey).find(([, task]) => task.id === taskId)?.[0] || "";
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function emptyExpansion(): ExpansionResult {
  return {
    plannerTask: null,
    created: [],
    pause: null,
  };
}

function assessGraphQuality({
  tasksByKey,
  completed,
  blocked,
  failed,
  expanded,
  budget,
}: {
  tasksByKey: Record<string, Task>;
  completed: Task[];
  blocked: Task[];
  failed: Task[];
  expanded: Task[];
  budget: TaskGraphQuality["budget"];
}): TaskGraphQuality {
  const issues: string[] = [];
  const recommendations: string[] = [];
  const tasks = Object.values(tasksByKey);
  const missingAcceptance = tasks.filter((task) => !Array.isArray(task.metadata.acceptanceCriteria) || !task.metadata.acceptanceCriteria.length).length;
  const recoveredFailures = failed.filter(isReplanSupersededTerminal);
  const activeFailures = failed.filter((task) => !isReplanSupersededTerminal(task));
  const failedCount = failed.length;
  const activeFailedCount = activeFailures.length;
  const recoveredFailureCount = recoveredFailures.length;
  const blockedCount = blocked.length;
  const failureClusters = countFailureClusters([...failed, ...blocked]);
  const failureRisk = failureRiskForTasks([...activeFailures, ...blocked]) + recoveredFailureCount * 0.15;
  if (missingAcceptance) issues.push(`${missingAcceptance} task(s) lack acceptance criteria`);
  if (activeFailedCount) issues.push(`${activeFailedCount} active task failure(s) remain`);
  if (recoveredFailureCount) issues.push(`${recoveredFailureCount} task failure(s) were superseded by replan recovery`);
  if (blockedCount) issues.push(`${blockedCount} task(s) blocked`);
  if (!completed.length) issues.push("no terminal task was recorded");
  if (failureClusters.permission_or_policy) recommendations.push("narrow role permissions or request explicit approval before retrying the affected branch");
  if (failureClusters.timeout) recommendations.push("split timeout-prone tasks into smaller recovery tasks with shorter acceptance criteria");
  if (failureClusters.provider) recommendations.push("retry provider-sensitive work through fallback provider or reduce prompt size");
  if (failureClusters.verification) recommendations.push("create a targeted fix plus verification branch before final review");
  if (failureClusters.dependency) recommendations.push("repair or bypass failed upstream dependencies before scheduling downstream tasks");
  if (failureClusters.resource_budget) recommendations.push("lower concurrency or scope before adding more dynamic tasks");
  if (blockedCount) recommendations.push("surface blocked dependencies before adding more dynamic work");
  const terminalRatio = tasks.length ? completed.length / tasks.length : 0;
  const acceptancePenalty = tasks.length ? missingAcceptance / tasks.length : 0;
  const failurePenalty = tasks.length ? (activeFailedCount + blockedCount * 0.7 + recoveredFailureCount * 0.25 + failureRisk * 0.4) / tasks.length : 0;
  const score = clamp01(0.38 + terminalRatio * 0.44 - acceptancePenalty * 0.14 - failurePenalty * 0.34 + Math.min(0.08, expanded.length * 0.015));
  return {
    score: Number(score.toFixed(3)),
    issues,
    recommendations,
    taskCount: tasks.length,
    failedCount,
    activeFailedCount,
    recoveredFailureCount,
    blockedCount,
    dynamicCount: expanded.length,
    failureClusters,
    failureRisk: Number(failureRisk.toFixed(3)),
    budget,
  };
}

function assessPatchQuality(
  patch: GraphPatchSpec,
  {
    failedTask,
    existingKeys,
    failureCluster,
    maxNewTasks,
  }: {
    failedTask: Task;
    existingKeys: Set<string>;
    failureCluster: string;
    maxNewTasks: number;
  },
): { score: number; issues: string[]; taskCount: number; asksUser: boolean } {
  const issues: string[] = [];
  if (patch.tasks.length > maxNewTasks) issues.push(`patch exceeds adaptive replan budget ${maxNewTasks}`);
  if (!patch.tasks.length && !patch.needsUserInput && !patch.stop) issues.push("patch did not add recovery work or ask for input");
  if (patch.tasks.some((task) => existingKeys.has(task.key))) issues.push("patch reuses existing graph keys");
  if (patch.tasks.some((task) => task.dependsOn.includes(String(failedTask.metadata.graphKey || "")) && task.dependencyType !== "finished")) {
    issues.push("recovery task depends on failed parent with success dependency");
  }
  if (failureCluster === "permission_or_policy" && !patch.needsUserInput && patch.tasks.some((task) => task.permissionMode === "danger_full_access")) {
    issues.push("permission failure recovery escalates to danger_full_access without asking user");
  }
  if (failureCluster === "timeout" && patch.tasks.some((task) => sameText(task.input, failedTask.input))) {
    issues.push("timeout recovery keeps the original task scope");
  }
  if (failureCluster === "verification" && patch.tasks.length && !patch.tasks.some((task) => /test|verify|check|assert|review/i.test(`${task.title}\n${task.input}`))) {
    issues.push("verification recovery lacks an explicit verification step");
  }
  if (failureCluster === "provider" && patch.tasks.length && !patch.tasks.some((task) => /fallback|reduce|simpl|json|parse|provider|model/i.test(`${task.title}\n${task.input}`))) {
    issues.push("provider recovery does not address model/output fragility");
  }
  if (failureCluster === "resource_budget" && patch.tasks.length > 1) {
    issues.push("resource budget recovery should prefer one narrow unblocker");
  }
  const narrowed = patch.tasks.some((task) => !sameText(task.input, failedTask.input) || task.role !== failedTask.role);
  if (patch.tasks.length && !narrowed) issues.push("recovery tasks look identical to the failed task");
  const sizePenalty = Math.max(0, patch.tasks.length - Math.max(1, Math.ceil(maxNewTasks * 0.7))) * 0.04;
  const clusterPenalty = (FAILURE_CLUSTER_WEIGHTS[failureCluster] || 0.6) * 0.04;
  const score = clamp01(1 - issues.length * 0.18 - Math.max(0, patch.tasks.length - maxNewTasks) * 0.1 - sizePenalty - clusterPenalty);
  return {
    score: Number(score.toFixed(3)),
    issues,
    taskCount: patch.tasks.length,
    asksUser: patch.needsUserInput,
  };
}

function countFailureClusters(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const cluster = classifyFailure(task);
    counts[cluster] = (counts[cluster] || 0) + 1;
  }
  return counts;
}

const FAILURE_CLUSTER_WEIGHTS: Record<string, number> = {
  permission_or_policy: 0.95,
  dependency: 0.85,
  resource_budget: 0.82,
  provider: 0.75,
  needs_user_input: 0.72,
  timeout: 0.65,
  verification: 0.55,
  cancelled: 0.4,
  unknown: 0.6,
};

export function classifyFailure(task: Task): string {
  const text = `${task.status}\n${task.error || ""}\n${task.result || ""}\n${String(task.metadata.lastError || "")}`.toLowerCase();
  if (task.status === "cancelled" || /cancel/.test(text)) return "cancelled";
  if (/budget exhausted|max dynamic|quota|too many|resource|out of memory|oom/.test(text)) return "resource_budget";
  if (/dependency|upstream|downstream|depends on|blocked by/.test(text)) return "dependency";
  if (/timed out|timeout|lease expired|stale/.test(text)) return "timeout";
  if (/provider|model|llm|rate limit|json|parse/.test(text)) return "provider";
  if (/not allowed|permission|forbidden|approval|policy|tool/.test(text)) return "permission_or_policy";
  if (/user input|clarification|missing context|blocked/.test(text)) return "needs_user_input";
  if (/test|assert|verification|review/.test(text)) return "verification";
  return "unknown";
}

function failureRiskForTasks(tasks: Task[]): number {
  return tasks.reduce((sum, task) => sum + (FAILURE_CLUSTER_WEIGHTS[classifyFailure(task)] || FAILURE_CLUSTER_WEIGHTS.unknown), 0);
}

function isReplanSupersededTerminal(task: Task): boolean {
  return Boolean((task.status === "failed" || task.status === "dead_letter") && task.metadata.replanSupersededAt);
}

export function calibratedReplanBudget({
  availableSlots,
  failureCluster,
  attempt,
  deliveryLevel,
}: {
  availableSlots: number;
  failureCluster: string;
  attempt: number;
  deliveryLevel?: unknown;
}): number {
  const base = failureCluster === "permission_or_policy" || failureCluster === "needs_user_input" || failureCluster === "resource_budget"
    ? 2
    : failureCluster === "dependency"
      ? 3
      : failureCluster === "timeout" || failureCluster === "provider"
        ? 3
        : failureCluster === "verification"
          ? 4
          : 5;
  const deliveryBoost = deliveryLevel === "production" || deliveryLevel === "prod" ? 1 : 0;
  const attemptDampener = Math.max(1, 7 - attempt);
  return Math.max(1, Math.min(availableSlots, base + deliveryBoost, attemptDampener));
}

function sameText(left: string, right: string): boolean {
  return left.replace(/\s+/g, " ").trim() === right.replace(/\s+/g, " ").trim();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function uniqueInternalKey(base: string, existingKeys: Set<string>): string {
  if (!existingKeys.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const key = `${base}_${index}`;
    if (!existingKeys.has(key)) return key;
  }
  return `${base}_${Date.now()}`;
}

function baseGraphMetadata(task: Task): Metadata {
  return {
    sessionId: typeof task.metadata.sessionId === "string" ? task.metadata.sessionId : "",
    source: typeof task.metadata.source === "string" ? task.metadata.source : "",
    runId: typeof task.metadata.runId === "string" ? task.metadata.runId : "",
    createdBy: typeof task.metadata.createdBy === "string" ? task.metadata.createdBy : "",
    graphId: typeof task.metadata.graphId === "string" ? task.metadata.graphId : "",
    planGoal: typeof task.metadata.planGoal === "string" ? task.metadata.planGoal : "",
    deliveryLevel: typeof task.metadata.deliveryLevel === "string" ? task.metadata.deliveryLevel : "",
    planningMode: typeof task.metadata.planningMode === "string" ? task.metadata.planningMode : "",
    failureStrategy: typeof task.metadata.failureStrategy === "string" ? task.metadata.failureStrategy : "",
    exitCriteria: Array.isArray(task.metadata.exitCriteria) ? task.metadata.exitCriteria : [],
    maxWaves: typeof task.metadata.maxWaves === "number" ? task.metadata.maxWaves : 1,
    permissionMode: typeof task.metadata.permissionMode === "string" ? task.metadata.permissionMode : "workspace_write",
  };
}
