import type { Metadata, Task, TaskDependency, TaskStatus } from "../types.ts";
import type { TaskStore } from "./TaskStore.ts";
import { DEFAULT_ROLE_TASK_TIMEOUT_MS, MAX_ROLE_TASK_TIMEOUT_MS, normalizeRoleTaskTimeoutMs } from "../runtime/RoleTaskTimeout.ts";
import { graphTaskPermissionMode } from "./TaskPermissions.ts";

export interface TaskMindMapNode {
  id: string;
  key: string;
  parentKey: string;
  role: string;
  status: TaskStatus;
  title: string;
  input: string;
  result: string | null;
  error: string | null;
  editable: boolean;
  addable: boolean;
  leaf: boolean;
  children: string[];
  dependencies: TaskMindMapEdge[];
  dependents: TaskMindMapEdge[];
  metadata: Metadata;
  createdAt: string;
  updatedAt: string;
}

export interface TaskMindMapEdge {
  fromKey: string;
  fromTaskId: string;
  toKey: string;
  toTaskId: string;
  dependencyType: TaskDependency["dependencyType"];
  status: TaskStatus;
}

export interface TaskMindMap {
  runId: string;
  graphId: string;
  goal: string;
  roots: string[];
  nodes: TaskMindMapNode[];
  dependencies: TaskMindMapEdge[];
}

export interface TaskMindMapRootSummary {
  rootId: string;
  runId: string;
  graphId: string;
  graphIds: string[];
  graphCount: number;
  runStatus: string;
  graphStatus: string;
  goal: string;
  roots: Array<{ key: string; taskId: string; title: string; status: TaskStatus }>;
  queued: number;
  running: number;
  pending: number;
  editable: number;
  updatedAt: string;
}

export interface TaskMindMapRootListOptions {
  activeOnly?: boolean;
  limit?: number;
}

export interface TaskGraphNodeMutationInput {
  runId: string;
  selector: string;
  role?: string;
  title?: string;
  input?: string;
  dependsOn?: string[];
  dependencyType?: TaskDependency["dependencyType"];
  acceptanceCriteria?: string[];
  toolHints?: string[];
  skillHints?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  maxResultChars?: number;
  maxMemoryCandidates?: number;
  expandable?: boolean;
  expansionGoal?: string;
  maxExpansionDepth?: number;
  metadata?: Metadata;
  reopenBlocked?: boolean;
}

export interface TaskGraphNodeAddInput {
  runId: string;
  parent: string;
  key?: string;
  role: string;
  title: string;
  input: string;
  dependsOn?: string[];
  dependencyType?: TaskDependency["dependencyType"];
  acceptanceCriteria?: string[];
  toolHints?: string[];
  skillHints?: string[];
  timeoutMs?: number;
  maxRetries?: number;
  maxResultChars?: number;
  maxMemoryCandidates?: number;
  expandable?: boolean;
  expansionGoal?: string;
  maxExpansionDepth?: number;
  permissionMode?: string;
  metadata?: Metadata;
}

export interface TaskGraphNodeSiblingInput extends Omit<TaskGraphNodeAddInput, "parent" | "role"> {
  selector: string;
  role?: string;
}

export interface TaskGraphNodeDeleteInput {
  runId: string;
  selector: string;
  reason?: string;
}

const EDITABLE_STATUSES = new Set<TaskStatus>(["pending", "blocked"]);
const ADDABLE_STATUSES = new Set<TaskStatus>(["pending", "blocked", "done"]);
const ACTIVE_STATUSES = new Set<TaskStatus>(["pending", "queued", "running", "blocked", "needs_inspection"]);

export function buildTaskMindMap(taskStore: TaskStore, runId: string): TaskMindMap {
  const run = taskStore.getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  const tasks = taskStore.getTasksForRun(runId)
    .filter((task) => isVisibleGraphTask(task));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const byKey = new Map(tasks.map((task) => [graphKey(task), task]));
  const children = new Map<string, string[]>();
  const dependencies: TaskMindMapEdge[] = [];
  const dependentsByKey = new Map<string, TaskMindMapEdge[]>();
  const dependenciesByKey = new Map<string, TaskMindMapEdge[]>();

  for (const task of tasks) {
    const key = graphKey(task);
    const parentKey = parentKeyFor(task);
    if (parentKey && byKey.has(parentKey)) {
      const childKeys = children.get(parentKey) || [];
      childKeys.push(key);
      children.set(parentKey, childKeys);
    }
  }

  for (const task of tasks) {
    const toKey = graphKey(task);
    for (const dependency of taskStore.getDependencies(task.id)) {
      const from = byId.get(dependency.dependsOnTaskId);
      if (!from) continue;
      const edge: TaskMindMapEdge = {
        fromKey: graphKey(from),
        fromTaskId: from.id,
        toKey,
        toTaskId: task.id,
        dependencyType: dependency.dependencyType,
        status: from.status,
      };
      dependencies.push(edge);
      dependenciesByKey.set(toKey, [...(dependenciesByKey.get(toKey) || []), edge]);
      dependentsByKey.set(edge.fromKey, [...(dependentsByKey.get(edge.fromKey) || []), edge]);
    }
  }

  for (const childKeys of children.values()) {
    childKeys.sort((left, right) => taskSort(byKey.get(left), byKey.get(right)));
  }
  tasks.sort((left, right) => taskSort(left, right));

  const nodes = tasks.map((task) => {
    const key = graphKey(task);
    const childKeys = children.get(key) || [];
    return {
      id: task.id,
      key,
      parentKey: parentKeyFor(task),
      role: task.role,
      status: task.status,
      title: task.title,
      input: task.input,
      result: task.result,
      error: task.error,
      editable: isNodeEditable(task),
      addable: isNodeAddable(task),
      leaf: childKeys.length === 0,
      children: childKeys,
      dependencies: dependenciesByKey.get(key) || [],
      dependents: dependentsByKey.get(key) || [],
      metadata: task.metadata,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    } satisfies TaskMindMapNode;
  });

  const rootKeys = nodes
    .filter((node) => !node.parentKey || !byKey.has(node.parentKey))
    .map((node) => node.key);

  return {
    runId,
    graphId: firstGraphId(tasks),
    goal: run.userInput,
    roots: rootKeys,
    nodes,
    dependencies,
  };
}

export function listActiveTaskMindMapRoots(taskStore: TaskStore, options: TaskMindMapRootListOptions = {}): TaskMindMapRootSummary[] {
  const summaries: TaskMindMapRootSummary[] = [];
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  const graphs = options.activeOnly
    ? taskStore.getOpenTaskGraphs()
    : taskStore.getRecentTaskGraphs({ limit: Math.min(100, limit * 4) });
  const graphsByRun = new Map<string, typeof graphs>();
  for (const graph of graphs) {
    if (!graph.runId) continue;
    graphsByRun.set(graph.runId, [...(graphsByRun.get(graph.runId) || []), graph]);
  }
  for (const [runId, runGraphs] of graphsByRun) {
    const run = taskStore.getRun(runId);
    const map = run ? buildTaskMindMap(taskStore, runId) : null;
    if (!run || !map || !map.nodes.length) continue;
    const active = map.nodes.filter((task) => ACTIVE_STATUSES.has(task.status));
    if (options.activeOnly && !active.length) continue;
    const nodesByKey = new Map(map.nodes.map((node) => [node.key, node]));
    const roots = map.roots
      .map((key) => nodesByKey.get(key))
      .filter((node): node is TaskMindMapNode => Boolean(node))
      .map((node) => ({
        key: node.key,
        taskId: node.id,
        title: node.title,
        status: node.status,
      }));
    const graphIds = unique(runGraphs.map((graph) => graph.id));
    summaries.push({
      rootId: run.id,
      runId: run.id,
      graphId: graphIds[0] || map.graphId,
      graphIds,
      graphCount: graphIds.length,
      runStatus: run.status,
      graphStatus: combinedGraphStatus(runGraphs.map((graph) => graph.status)),
      goal: run.userInput,
      roots,
      queued: map.nodes.filter((task) => task.status === "queued").length,
      running: map.nodes.filter((task) => task.status === "running").length,
      pending: map.nodes.filter((task) => task.status === "pending" || task.status === "blocked").length,
      editable: map.nodes.filter((node) => node.editable).length,
      updatedAt: [
        ...map.nodes.map((node) => node.updatedAt),
        ...runGraphs.map((graph) => graph.completedAt || graph.createdAt),
      ].reduce((latest, value) => value > latest ? value : latest, run.startedAt),
    });
  }
  return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, limit);
}

export function renderTaskMindMapRootList(roots: TaskMindMapRootSummary[]): string {
  if (!roots.length) return "No recent DAG roots.";
  const lines = ["DAG Roots", ""];
  roots.forEach((root, index) => {
    const rootLabels = root.roots.map((node) => `${node.key}:${statusLabel(node.status)}`).join(", ") || "(none)";
    lines.push(`${index + 1}. ${root.rootId}`);
    const graphLabel = root.graphCount > 1 ? `${root.graphCount} graphs, latest ${root.graphId}` : root.graphId;
    lines.push(`   graph: ${graphLabel} | run: ${runStatusLabel(root.runStatus)} | graph: ${graphStatusLabel(root.graphStatus)}`);
    lines.push(`   active: ${root.running} 进行中, ${root.queued} 排队中, ${root.pending} 未开始/阻塞 | editable: ${root.editable}`);
    lines.push(`   roots: ${rootLabels}`);
    lines.push(`   goal: ${root.goal}`);
  });
  return lines.join("\n");
}

export function renderTaskMindMap(map: TaskMindMap): string {
  const byKey = new Map(map.nodes.map((node) => [node.key, node]));
  const lines = [
    `Task Mind Map: ${map.runId}`,
    `Graph: ${map.graphId || "(none)"} | Nodes: ${map.nodes.length} | Editable: ${map.nodes.filter((node) => node.editable).length}`,
    `Goal: ${map.goal}`,
    "",
  ];
  for (const rootKey of map.roots) {
    const root = byKey.get(rootKey);
    if (root) renderNode(lines, root, byKey, "", true);
  }
  if (map.dependencies.length) {
    lines.push("", "Execution dependencies:");
    for (const edge of map.dependencies) {
      lines.push(`  ${edge.toKey} <- ${edge.fromKey} (${edge.dependencyType}, ${statusLabel(edge.status)})`);
    }
  }
  return lines.join("\n");
}

export function renderTaskMindMapNode(node: TaskMindMapNode): string {
  const lines = [
    `Task Node: ${node.key}`,
    `Task: ${node.id}`,
    `Status: ${statusLabel(node.status)}${node.editable ? " (editable)" : ""}`,
    `Role: ${node.role}`,
    `Title: ${node.title}`,
    `Parent: ${node.parentKey || "(root)"}`,
    `Children: ${node.children.length ? node.children.join(", ") : "(none)"}`,
    `Depends on: ${node.dependencies.length ? node.dependencies.map((edge) => `${edge.fromKey} (${edge.dependencyType}, ${statusLabel(edge.status)})`).join(", ") : "(none)"}`,
    `Dependents: ${node.dependents.length ? node.dependents.map((edge) => edge.toKey).join(", ") : "(none)"}`,
    `Updated: ${node.updatedAt}`,
    "",
    "Input:",
    indent(node.input || "(empty)", "  "),
  ];
  if (node.result) lines.push("", "Result:", indent(node.result, "  "));
  if (node.error) lines.push("", "Error:", indent(node.error, "  "));
  return lines.join("\n");
}

export function getTaskMindMapNode(taskStore: TaskStore, runId: string, selector: string): TaskMindMapNode {
  const map = buildTaskMindMap(taskStore, runId);
  return resolveNode(map, selector);
}

export function addTaskMindMapNode(taskStore: TaskStore, input: TaskGraphNodeAddInput): {
  map: TaskMindMap;
  node: TaskMindMapNode;
} {
  const map = buildTaskMindMap(taskStore, input.runId);
  const parent = resolveNode(map, input.parent);
  if (!parent.addable) {
    throw new Error(`Cannot add child under ${parent.key}; task status is ${parent.status}. Only pending or blocked nodes can be expanded manually.`);
  }
  const existingKeys = new Set(map.nodes.map((node) => node.key));
  const key = normalizeGraphKey(input.key || uniqueChildKey(parent.key, existingKeys));
  if (!key) throw new Error("graph node key is required");
  if (existingKeys.has(key)) throw new Error(`graph node key already exists: ${key}`);
  const parentTask = taskStore.getTaskOrThrow(parent.id);
  const dependencyKeys = input.dependsOn?.length ? input.dependsOn : [parent.key];
  const dependencyTasks = dependencyKeys.map((dependency) => resolveNode(map, dependency));
  assertNoDependencyCycle(map, key, dependencyTasks.map((dependency) => dependency.key));
  const sanitizedMetadata = sanitizeGraphMutationMetadata(input.metadata);
  const inheritedPermissionMode = typeof parent.metadata.permissionMode === "string" ? parent.metadata.permissionMode : "";
  const runPermissionMode = typeof parent.metadata.runPermissionMode === "string"
    ? parent.metadata.runPermissionMode
    : inheritedPermissionMode || "workspace_write";
  const role = normalizeRole(input.role);
  const title = input.title.trim();
  const taskInput = input.input.trim();
  const permissionMode = graphTaskPermissionMode({
    role,
    title,
    input: taskInput,
    acceptanceCriteria: input.acceptanceCriteria,
    toolHints: input.toolHints,
    metadata: sanitizedMetadata,
  }, input.permissionMode || inheritedPermissionMode, runPermissionMode);
  const inheritedTimeoutMs = normalizeRoleTaskTimeoutMs(parentTask.metadata.timeoutMs, DEFAULT_ROLE_TASK_TIMEOUT_MS);
  const metadata: Metadata = {
    ...inheritedGraphMetadata(parentTask.metadata),
    ...sanitizedMetadata,
    graphKey: key,
    graphId: parent.metadata.graphId || "",
    graphRole: role,
    parentKey: parent.key,
    acceptanceCriteria: stringList(input.acceptanceCriteria, ["The task produces a useful result for this branch."]),
    toolHints: stringList(input.toolHints, []),
    skillHints: stringList(input.skillHints, []),
    timeoutMs: boundedNumber(input.timeoutMs, inheritedTimeoutMs, 1000, MAX_ROLE_TASK_TIMEOUT_MS),
    maxResultChars: boundedNumber(input.maxResultChars, 12000, 1000, 100000),
    maxMemoryCandidates: boundedNumber(input.maxMemoryCandidates, 1, 0, 20),
    wave: nextWave(parent),
    expandable: input.expandable === true,
    expansionGoal: input.expansionGoal || "",
    maxExpansionDepth: boundedNumber(input.maxExpansionDepth, 0, 0, 20),
    manuallyAdded: true,
    graphMutation: {
      type: "add",
      at: new Date().toISOString(),
      parentKey: parent.key,
    },
    permissionMode,
    runPermissionMode,
  };

  const created = taskStore.createTask({
    role,
    title,
    input: taskInput,
    parentTaskId: parent.id,
    maxRetries: normalizeRetries(input.maxRetries, 1),
    metadata,
  });
  for (const dependency of dependencyTasks) {
    taskStore.addTaskDependency(created.id, dependency.id, input.dependencyType || "success");
  }
  taskStore.addEvent({
    type: "task_graph.node_added",
    taskId: created.id,
    payload: {
      runId: input.runId,
      graphId: parent.metadata.graphId || "",
      key,
      parentKey: parent.key,
      dependencies: dependencyTasks.map((dependency) => dependency.key),
    },
  });
  const updatedMap = buildTaskMindMap(taskStore, input.runId);
  return { map: updatedMap, node: resolveNode(updatedMap, key) };
}

export function addTaskMindMapNodeBefore(taskStore: TaskStore, input: TaskGraphNodeSiblingInput): {
  map: TaskMindMap;
  node: TaskMindMapNode;
} {
  const map = buildTaskMindMap(taskStore, input.runId);
  const target = resolveNode(map, input.selector);
  if (!target.editable) throw new Error(`Cannot insert before ${target.key}; task status is ${target.status}.`);
  if (!target.parentKey) throw new Error(`Cannot insert before root node ${target.key}.`);
  const dependencies = target.dependencies.length ? target.dependencies.map((edge) => edge.fromKey) : [target.parentKey];
  const added = addTaskMindMapNode(taskStore, {
    ...input,
    parent: target.parentKey,
    dependsOn: input.dependsOn?.length ? input.dependsOn : dependencies,
    role: input.role || target.role,
  });
  updateTaskMindMapNode(taskStore, {
    runId: input.runId,
    selector: target.key,
    dependsOn: [added.node.key],
    dependencyType: "success",
  });
  const updatedMap = buildTaskMindMap(taskStore, input.runId);
  return { map: updatedMap, node: resolveNode(updatedMap, added.node.key) };
}

export function addTaskMindMapNodeAfter(taskStore: TaskStore, input: TaskGraphNodeSiblingInput): {
  map: TaskMindMap;
  node: TaskMindMapNode;
} {
  const map = buildTaskMindMap(taskStore, input.runId);
  const target = resolveNode(map, input.selector);
  if (!target.editable) throw new Error(`Cannot insert after ${target.key}; task status is ${target.status}.`);
  if (!target.parentKey) throw new Error(`Cannot insert after root node ${target.key}.`);
  const added = addTaskMindMapNode(taskStore, {
    ...input,
    parent: target.parentKey,
    dependsOn: input.dependsOn?.length ? input.dependsOn : [target.key],
    role: input.role || target.role,
  });
  const refreshed = buildTaskMindMap(taskStore, input.runId);
  const selected = resolveNode(refreshed, target.key);
  for (const edge of selected.dependents) {
    if (edge.toKey === added.node.key) continue;
    const dependent = resolveNode(refreshed, edge.toKey);
    if (!dependent.editable) continue;
    updateTaskMindMapNode(taskStore, {
      runId: input.runId,
      selector: dependent.key,
      dependsOn: dependent.dependencies.map((dependency) => dependency.fromKey === target.key ? added.node.key : dependency.fromKey),
      dependencyType: edge.dependencyType,
    });
  }
  const updatedMap = buildTaskMindMap(taskStore, input.runId);
  return { map: updatedMap, node: resolveNode(updatedMap, added.node.key) };
}

export function updateTaskMindMapNode(taskStore: TaskStore, input: TaskGraphNodeMutationInput): {
  map: TaskMindMap;
  node: TaskMindMapNode;
} {
  const map = buildTaskMindMap(taskStore, input.runId);
  const node = resolveNode(map, input.selector);
  if (!node.editable) {
    throw new Error(`Cannot edit ${node.key}; task status is ${node.status}. Only pending or blocked nodes can be changed.`);
  }
  const task = taskStore.getTaskOrThrow(node.id);
  const role = input.role === undefined ? task.role : normalizeRole(input.role);
  const title = input.title === undefined ? task.title : input.title.trim();
  const taskInput = input.input === undefined ? task.input : input.input.trim();
  if (!title) throw new Error("title must not be empty");
  if (!taskInput) throw new Error("input must not be empty");

  const sanitizedMetadata = sanitizeGraphMutationMetadata(input.metadata);
  const metadata = {
    ...task.metadata,
    ...sanitizedMetadata,
    graphRole: role,
    acceptanceCriteria: input.acceptanceCriteria === undefined
      ? task.metadata.acceptanceCriteria
      : stringList(input.acceptanceCriteria, ["The task produces a useful result for this branch."]),
    toolHints: input.toolHints === undefined ? task.metadata.toolHints : stringList(input.toolHints, []),
    skillHints: input.skillHints === undefined ? task.metadata.skillHints : stringList(input.skillHints, []),
    timeoutMs: input.timeoutMs === undefined ? task.metadata.timeoutMs : boundedNumber(input.timeoutMs, DEFAULT_ROLE_TASK_TIMEOUT_MS, 1000, MAX_ROLE_TASK_TIMEOUT_MS),
    maxResultChars: input.maxResultChars === undefined ? task.metadata.maxResultChars : boundedNumber(input.maxResultChars, 12000, 1000, 100000),
    maxMemoryCandidates: input.maxMemoryCandidates === undefined ? task.metadata.maxMemoryCandidates : boundedNumber(input.maxMemoryCandidates, 1, 0, 20),
    expandable: input.expandable === undefined ? task.metadata.expandable : input.expandable === true,
    expansionGoal: input.expansionGoal === undefined ? task.metadata.expansionGoal : input.expansionGoal,
    maxExpansionDepth: input.maxExpansionDepth === undefined ? task.metadata.maxExpansionDepth : boundedNumber(input.maxExpansionDepth, 0, 0, 20),
    manuallyEdited: true,
    graphMutation: {
      type: "update",
      at: new Date().toISOString(),
    },
  } satisfies Metadata;

  taskStore.updateUnstartedTask(node.id, {
    role,
    title,
    input: taskInput,
    maxRetries: input.maxRetries === undefined ? task.maxRetries : normalizeRetries(input.maxRetries, task.maxRetries),
    metadata,
    reopenBlocked: input.reopenBlocked !== false,
  });

  if (input.dependsOn !== undefined) {
    const dependencyNodes = input.dependsOn.map((dependency) => resolveNode(map, dependency));
    assertNoDependencyCycle(map, node.key, dependencyNodes.map((dependency) => dependency.key));
    taskStore.replaceTaskDependencies(node.id, dependencyNodes.map((dependency) => ({
      dependsOnTaskId: dependency.id,
      dependencyType: input.dependencyType || "success",
    })), {
      reason: "mind map node dependency update",
    });
  }

  taskStore.addEvent({
    type: "task_graph.node_updated",
    taskId: node.id,
    payload: {
      runId: input.runId,
      graphId: node.metadata.graphId || "",
      key: node.key,
      fields: changedFields(input),
    },
  });
  const updatedMap = buildTaskMindMap(taskStore, input.runId);
  return { map: updatedMap, node: resolveNode(updatedMap, node.key) };
}

export function deleteTaskMindMapNode(taskStore: TaskStore, input: TaskGraphNodeDeleteInput): {
  map: TaskMindMap;
  deleted: string[];
} {
  const map = buildTaskMindMap(taskStore, input.runId);
  const target = resolveNode(map, input.selector);
  const subtree = collectSubtree(map, target.key);
  const locked = subtree.filter((node) => !node.editable);
  if (locked.length) {
    throw new Error(`Cannot delete executed or running nodes: ${locked.map((node) => `${node.key}:${node.status}`).join(", ")}`);
  }

  const subtreeKeys = new Set(subtree.map((node) => node.key));
  const targetDependencyKeys = target.dependencies.map((edge) => edge.fromKey).filter((key) => !subtreeKeys.has(key));
  const rewiredDependents = new Set<string>();
  for (const deletedNode of subtree) {
    for (const edge of deletedNode.dependents) {
      if (subtreeKeys.has(edge.toKey) || rewiredDependents.has(edge.toKey)) continue;
      const dependent = resolveNode(map, edge.toKey);
      if (!dependent.editable) {
        throw new Error(`Cannot delete ${target.key}; dependent ${dependent.key} is ${dependent.status}.`);
      }
      updateTaskMindMapNode(taskStore, {
        runId: input.runId,
        selector: dependent.key,
        dependsOn: unique([
          ...dependent.dependencies.filter((dependency) => !subtreeKeys.has(dependency.fromKey)).map((dependency) => dependency.fromKey),
          ...targetDependencyKeys,
        ]),
        dependencyType: edge.dependencyType,
      });
      rewiredDependents.add(edge.toKey);
    }
  }

  const deleted: string[] = [];
  for (const node of subtree.reverse()) {
    const task = taskStore.getTaskOrThrow(node.id);
    taskStore.updateTaskMetadata(task.id, {
      ...task.metadata,
      graphDeleted: true,
      graphDeletedAt: new Date().toISOString(),
      graphDeleteReason: input.reason || "deleted from DAG editor",
    }, {
      reason: "mind map node deleted",
    });
    taskStore.cancelTask(task.id, {
      reason: input.reason || "deleted from DAG editor",
      bypassLease: true,
    });
    deleted.push(node.key);
  }
  taskStore.addEvent({
    type: "task_graph.node_deleted",
    taskId: target.id,
    payload: {
      runId: input.runId,
      graphId: target.metadata.graphId || "",
      key: target.key,
      deleted,
    },
  });
  return { map: buildTaskMindMap(taskStore, input.runId), deleted };
}

export function resolveNode(map: TaskMindMap, selector: string): TaskMindMapNode {
  const normalized = selector.trim();
  if (!normalized) throw new Error("node selector is required");
  const exact = map.nodes.find((node) => node.key === normalized || node.id === normalized);
  if (exact) return exact;
  const prefixMatches = map.nodes.filter((node) => node.id.startsWith(normalized));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) throw new Error(`Ambiguous task id prefix: ${selector}`);
  throw new Error(`Task graph node not found: ${selector}`);
}

function renderNode(lines: string[], node: TaskMindMapNode, byKey: Map<string, TaskMindMapNode>, prefix: string, last: boolean): void {
  const connector = prefix ? (last ? "`- " : "+- ") : "";
  lines.push(`${prefix}${connector}${statusGlyph(node.status)} ${node.key} ${node.role} - ${node.title} · ${statusLabel(node.status)}${node.editable ? " *" : ""}`);
  const nextPrefix = prefix ? `${prefix}${last ? "   " : "|  "}` : "";
  node.children.forEach((childKey, index) => {
    const child = byKey.get(childKey);
    if (child) renderNode(lines, child, byKey, nextPrefix, index === node.children.length - 1);
  });
}

export function statusLabel(status: TaskStatus | string): string {
  switch (status) {
    case "pending":
      return "未开始";
    case "queued":
      return "排队中";
    case "running":
      return "进行中";
    case "blocked":
      return "已阻塞";
    case "needs_inspection":
      return "待检查";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "dead_letter":
      return "死信";
    default:
      return String(status || "未知");
  }
}

function runStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "进行中";
    case "reviewing":
      return "评审中";
    case "recovering":
      return "恢复中";
    case "partially_done":
      return "部分完成";
    case "waiting_user":
      return "等待输入";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    case "blocked":
      return "已阻塞";
    case "cancelled":
      return "已取消";
    default:
      return status || "未知";
  }
}

function graphStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "未开始";
    case "running":
      return "进行中";
    case "done":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status || "未知";
  }
}

function combinedGraphStatus(statuses: string[]): string {
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "pending")) return "pending";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.length && statuses.every((status) => status === "done")) return "done";
  return statuses[0] || "unknown";
}

function statusGlyph(status: TaskStatus): string {
  if (status === "done") return "x";
  if (status === "running" || status === "queued") return ">";
  if (status === "failed" || status === "dead_letter") return "!";
  if (status === "blocked" || status === "needs_inspection") return "?";
  if (status === "cancelled") return "-";
  return "o";
}

function graphKey(task: Task): string {
  return typeof task.metadata.graphKey === "string" ? task.metadata.graphKey : task.id;
}

function parentKeyFor(task: Task): string {
  return typeof task.metadata.parentKey === "string" ? task.metadata.parentKey : "";
}

function isNodeEditable(task: Task): boolean {
  return EDITABLE_STATUSES.has(task.status);
}

function isNodeAddable(task: Task): boolean {
  return ADDABLE_STATUSES.has(task.status);
}

function taskSort(left?: Task, right?: Task): number {
  const leftWave = numberMeta(left?.metadata.wave, 1);
  const rightWave = numberMeta(right?.metadata.wave, 1);
  if (leftWave !== rightWave) return leftWave - rightWave;
  return String(left?.createdAt || "").localeCompare(String(right?.createdAt || ""));
}

function firstGraphId(tasks: Task[]): string {
  for (const task of tasks) {
    if (typeof task.metadata.graphId === "string" && task.metadata.graphId) return task.metadata.graphId;
  }
  return "";
}

function normalizeGraphKey(value: string): string {
  return value.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^_+|_+$/g, "");
}

function normalizeRole(value: string): string {
  const role = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(role)) throw new Error(`invalid role: ${value}`);
  return role;
}

function uniqueChildKey(parentKey: string, existingKeys: Set<string>): string {
  const base = normalizeGraphKey(`${parentKey}_child`);
  if (!existingKeys.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const key = `${base}_${index}`;
    if (!existingKeys.has(key)) return key;
  }
  return `${base}_${Date.now()}`;
}

function inheritedGraphMetadata(metadata: Metadata): Metadata {
  const inherited: Metadata = {};
  for (const key of ["runId", "sessionId", "source", "permissionMode", "runPermissionMode", "planGoal", "deliveryLevel", "planningMode", "failureStrategy", "exitCriteria", "maxWaves"]) {
    const value = metadata[key];
    if (value !== undefined) inherited[key] = value;
  }
  return inherited;
}

function sanitizeGraphMutationMetadata(metadata: Metadata | undefined): Metadata {
  const sanitized = { ...(metadata || {}) };
  delete sanitized.permissionMode;
  delete sanitized.runPermissionMode;
  return sanitized;
}

function nextWave(parent: TaskMindMapNode): number {
  return numberMeta(parent.metadata.wave, 1) + 1;
}

function numberMeta(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return Math.trunc(parsed);
}

function normalizeRetries(value: unknown, fallback: number): number {
  return boundedNumber(value, fallback, 0, 5);
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function indent(value: string, prefix: string): string {
  return String(value).split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
}

function assertNoDependencyCycle(map: TaskMindMap, targetKey: string, nextDependencies: string[]): void {
  const dependenciesByKey = new Map<string, string[]>();
  for (const node of map.nodes) {
    dependenciesByKey.set(node.key, node.dependencies.map((edge) => edge.fromKey));
  }
  dependenciesByKey.set(targetKey, nextDependencies);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, path: string[]) => {
    if (visiting.has(key)) throw new Error(`dependency cycle detected: ${[...path, key].join(" -> ")}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of dependenciesByKey.get(key) || []) {
      if (dependency === targetKey || dependenciesByKey.has(dependency)) visit(dependency, [...path, key]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  visit(targetKey, []);
}

function changedFields(input: TaskGraphNodeMutationInput): string[] {
  return [
    "role",
    "title",
    "input",
    "dependsOn",
    "acceptanceCriteria",
    "toolHints",
    "skillHints",
    "timeoutMs",
    "maxRetries",
    "maxResultChars",
    "maxMemoryCandidates",
    "expandable",
    "expansionGoal",
    "maxExpansionDepth",
    "metadata",
  ].filter((key) => (input as unknown as Record<string, unknown>)[key] !== undefined);
}

function isVisibleGraphTask(task: Task): boolean {
  return typeof task.metadata.graphKey === "string"
    && task.metadata.internalGraph !== true
    && task.metadata.graphDeleted !== true;
}

function collectSubtree(map: TaskMindMap, rootKey: string): TaskMindMapNode[] {
  const byKey = new Map(map.nodes.map((node) => [node.key, node]));
  const result: TaskMindMapNode[] = [];
  const visit = (key: string) => {
    const node = byKey.get(key);
    if (!node) return;
    result.push(node);
    for (const child of node.children) visit(child);
  };
  visit(rootKey);
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
