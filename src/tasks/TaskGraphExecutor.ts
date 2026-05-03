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
  plan: PlanSpec | null;

  constructor({
    taskStore,
    roleAgentManager,
    maxParallelTasks = 4,
    maxDynamicTasks = 200,
    plan = null,
  }: {
    taskStore: TaskStore;
    roleAgentManager: RoleAgentManager;
    maxParallelTasks?: number;
    maxDynamicTasks?: number;
    plan?: PlanSpec | null;
  }) {
    this.taskStore = taskStore;
    this.roleAgentManager = roleAgentManager;
    this.maxParallelTasks = maxParallelTasks;
    this.maxDynamicTasks = maxDynamicTasks;
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
    const graphId = graphIdFrom(tasksByKey);

    const record = (task: Task | null) => {
      if (!task || recorded.has(task.id)) return;
      if (!TERMINAL_STATUSES.has(task.status)) return;
      recorded.add(task.id);
      completed.push(task);
      if (task.status === "blocked") blocked.push(task);
      if (task.status === "failed" || task.status === "dead_letter") failed.push(task);
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

      const ready = [...pending]
        .map((key) => tasksByKey[key])
        .filter((task) => {
          const status = task ? this.taskStore.getTask(task.id)?.status : null;
          return status === "pending" || status === "queued";
        })
        .filter((task) => this.taskStore.dependenciesSatisfied(task.id))
        .slice(0, this.maxParallelTasks);

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
    return { completed, blocked, failed, graphId, expanded, internal, pause };
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
    if (availableSlots <= 0) return emptyExpansion();

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
  };
}
