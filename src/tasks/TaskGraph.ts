import type { Metadata, Task, TaskDependency } from "../types.ts";
import { sanitizePlannerMetadata, type PlanSpec } from "../planning/PlanSpec.ts";
import type { TaskStore } from "./TaskStore.ts";
import { clampPermissionMode } from "../tools/PermissionMode.ts";

export interface TaskGraphSpec {
  tasks: Array<{
    key: string;
    role: string;
    title: string;
    input: string;
    dependsOn?: string[];
    dependencyType?: TaskDependency["dependencyType"];
    maxRetries?: number;
    metadata?: Metadata;
  }>;
}

export function createTaskGraph({
  taskStore,
  spec,
  baseMetadata = {},
}: {
  taskStore: TaskStore;
  spec: TaskGraphSpec;
  baseMetadata?: Metadata;
}): Record<string, Task> {
  const tasks: Record<string, Task> = {};
  const graph = taskStore.createTaskGraph({
    runId: typeof baseMetadata.runId === "string" ? baseMetadata.runId : null,
  });

  for (const node of spec.tasks) {
    tasks[node.key] = taskStore.createTask({
      role: node.role,
      title: node.title,
      input: node.input,
      maxRetries: node.maxRetries,
      metadata: {
        ...baseMetadata,
        ...(node.metadata || {}),
        graphKey: node.key,
        graphId: graph.id,
      },
    });
  }

  for (const node of spec.tasks) {
    for (const dependencyKey of node.dependsOn || []) {
      const task = tasks[node.key];
      const dependency = tasks[dependencyKey];
      if (!task || !dependency) {
        throw new Error(`Invalid task graph dependency: ${node.key} depends on ${dependencyKey}`);
      }
      taskStore.addTaskDependency(task.id, dependency.id, node.dependencyType || "success");
    }
  }

  return tasks;
}

export function createTaskGraphFromPlan({
  taskStore,
  plan,
  baseMetadata = {},
}: {
  taskStore: TaskStore;
  plan: PlanSpec;
  baseMetadata?: Metadata;
}): Record<string, Task> {
  return createTaskGraph({
    taskStore,
    baseMetadata: {
      ...baseMetadata,
      planGoal: plan.goal,
      deliveryLevel: plan.deliveryLevel,
      planningMode: plan.planningMode,
      failureStrategy: plan.failureStrategy,
      exitCriteria: plan.exitCriteria,
      maxWaves: plan.maxWaves,
    },
    spec: {
      tasks: plan.tasks.map((task) => ({
        key: task.key,
        role: task.role,
        title: task.title,
        input: task.input,
        dependsOn: task.dependsOn,
        dependencyType: task.dependencyType,
        maxRetries: task.maxRetries,
        metadata: {
          ...(sanitizePlannerMetadata(task.metadata) || {}),
          graphRole: task.role,
          acceptanceCriteria: task.acceptanceCriteria,
          toolHints: task.toolHints,
          skillHints: task.skillHints,
          parentKey: task.parentKey || "",
          permissionMode: clampPermissionMode(task.permissionMode, baseMetadata.permissionMode),
          timeoutMs: task.timeoutMs,
          maxResultChars: task.maxResultChars,
          maxMemoryCandidates: task.maxMemoryCandidates,
          wave: task.wave,
          expandable: task.expandable,
          expansionGoal: task.expansionGoal,
          maxExpansionDepth: task.maxExpansionDepth,
        },
      })),
    },
  });
}
