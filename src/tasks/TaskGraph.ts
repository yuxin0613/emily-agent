import type { Metadata, Task, TaskDependency } from "../types.ts";
import type { TaskStore } from "./TaskStore.ts";

export interface TaskGraphSpec {
  tasks: Array<{
    key: string;
    role: string;
    title: string;
    input: string;
    dependsOn?: string[];
    dependencyType?: TaskDependency["dependencyType"];
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
