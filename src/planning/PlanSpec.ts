import type { Metadata, PermissionMode, TaskDependency } from "../types.ts";

export type DeliveryLevel = "poc" | "uat" | "production";
export type PlanningMode = "single_wave" | "rolling";
export type GraphFailureStrategy = "fail_graph" | "block_dependents" | "replan";

export interface PlanTaskSpec {
  key: string;
  role: string;
  title: string;
  input: string;
  parentKey?: string;
  dependsOn: string[];
  dependencyType: TaskDependency["dependencyType"];
  acceptanceCriteria: string[];
  toolHints: string[];
  skillHints: string[];
  timeoutMs: number;
  maxRetries: number;
  maxResultChars: number;
  maxMemoryCandidates: number;
  wave: number;
  expandable: boolean;
  expansionGoal: string;
  maxExpansionDepth: number;
  permissionMode?: PermissionMode;
  metadata?: Metadata;
}

export interface PlanReviewSpec {
  required: boolean;
  criteria: string[];
}

export interface PlanSpec {
  goal: string;
  deliveryLevel: DeliveryLevel;
  exitCriteria: string[];
  planningMode: PlanningMode;
  maxWaves: number;
  failureStrategy: GraphFailureStrategy;
  tasks: PlanTaskSpec[];
  review: PlanReviewSpec;
  clarificationRequired: boolean;
  clarificationQuestions: string[];
}

export interface GraphPatchSpec {
  reason: string;
  parentKey: string;
  tasks: PlanTaskSpec[];
  stop: boolean;
  needsUserInput: boolean;
  questions: string[];
}

export interface PlanValidationResult {
  ok: boolean;
  errors: string[];
}

const DELIVERY_LEVELS = new Set<DeliveryLevel>(["poc", "uat", "production"]);
const PLANNING_MODES = new Set<PlanningMode>(["single_wave", "rolling"]);
const FAILURE_STRATEGIES = new Set<GraphFailureStrategy>(["fail_graph", "block_dependents", "replan"]);

export function parsePlanSpec(raw: string): PlanSpec | null {
  const parsed = parseJsonCandidate(raw);
  const source = planSourceFrom(parsed);
  if (!source) return null;
  return normalizePlanSpec(source);
}

export function parseGraphPatchSpec(raw: string, { parentKey }: { parentKey: string }): GraphPatchSpec | null {
  const parsed = parseJsonCandidate(raw);
  const source = graphPatchSourceFrom(parsed);
  if (!source) return null;
  return normalizeGraphPatchSpec(source, parentKey);
}

export function createFallbackPlanSpec(input: string, selectedAgents: string[]): PlanSpec {
  const deliveryLevel = inferDeliveryLevel(input) || "poc";
  const longGoal = isOutcomeOrLongTask(input);
  const targetRole = selectedAgents.includes("developer") ? "developer" : "researcher";
  const goal = input.trim();
  const exitCriteria = defaultExitCriteria(deliveryLevel, goal);
  const taskInputPrefix = [
    `Goal: ${goal}`,
    `Delivery level: ${deliveryLevel}`,
    "Exit criteria:",
    ...exitCriteria.map((item) => `- ${item}`),
    "",
  ].join("\n");

  const scopeTask = planTask({
    key: "scope",
    role: "researcher",
    title: `scope: ${goal.slice(0, 60)}`,
    input: `${taskInputPrefix}Create the root mind-map node for this request: clarify scope, coarse modules, assumptions, and open risks before execution details are expanded.`,
    acceptanceCriteria: [
      "Scope is stated as coarse modules or workstreams.",
      "Assumptions and unknowns are explicit.",
    ],
    wave: 1,
    skillHints: ["research", "requirements"],
  });
  const architectureTask = planTask({
    key: "architecture",
    role: "planner",
    title: `architecture: ${goal.slice(0, 60)}`,
    input: `${taskInputPrefix}Expand the scoped root into a second-level decomposition map: modules, boundaries, dependencies, validation branches, and the next layer that should become executable leaves.`,
    parentKey: "scope",
    dependsOn: ["scope"],
    acceptanceCriteria: [
      "The next decomposition layer is clear.",
      "Execution dependencies are separated from decomposition hierarchy.",
    ],
    wave: 1,
    skillHints: ["planning", "architecture"],
    expandable: longGoal,
    expansionGoal: "Expand architecture from coarse modules into concrete feature slices and verification leaves.",
    maxExpansionDepth: longGoal ? 3 : 0,
  });

  const tasks: PlanTaskSpec[] = longGoal ? [
    scopeTask,
    architectureTask,
  ] : [
    scopeTask,
    architectureTask,
    planTask({
      key: "implementation",
      role: targetRole,
      title: `implementation: ${goal.slice(0, 60)}`,
      input: `${taskInputPrefix}Execute the first leaf implementation slice from the decomposition map. Return artifacts, risks, and remaining child slices.`,
      parentKey: "architecture",
      dependsOn: ["architecture"],
      acceptanceCriteria: [
        "A concrete implementation or executable next action is produced.",
        "Remaining work is listed as follow-up tasks.",
      ],
      wave: longGoal ? 2 : 1,
      skillHints: targetRole === "developer" ? ["coding"] : ["research"],
      toolHints: targetRole === "developer" ? ["read_file", "write_file", "run_tests"] : ["read_file"],
    }),
    planTask({
      key: "verification",
      role: "reviewer",
      title: `verification: ${goal.slice(0, 60)}`,
      input: `${taskInputPrefix}Verify the implementation leaf against the delivery level and exit criteria. Return pass/fail/needs_user_input.`,
      parentKey: "implementation",
      dependsOn: ["implementation"],
      dependencyType: "finished",
      acceptanceCriteria: exitCriteria,
      wave: longGoal ? 2 : 1,
      skillHints: ["review", "quality"],
    }),
  ];

  return {
    goal,
    deliveryLevel,
    exitCriteria,
    planningMode: longGoal ? "rolling" : "single_wave",
    maxWaves: longGoal ? 12 : 1,
    failureStrategy: "block_dependents",
    tasks,
    review: {
      required: true,
      criteria: exitCriteria,
    },
    clarificationRequired: false,
    clarificationQuestions: [],
  };
}

export function createPlanningOnlyPlanSpec(input: string, selectedAgents: string[], seed?: PlanSpec | null): PlanSpec {
  const deliveryLevel = seed?.deliveryLevel || inferDeliveryLevel(input) || "poc";
  const goal = normalizePlanningGoal(seed?.goal || input.trim());
  const exitCriteria = seed?.exitCriteria?.length ? seed.exitCriteria : defaultExitCriteria(deliveryLevel, goal);
  const templates = planningTemplatesFor(goal, selectedAgents);
  const tasks: PlanTaskSpec[] = [
    planTask({
      key: "goal",
      role: "planner",
      title: `目标反推: ${goal.slice(0, 60)}`,
      input: [
        `Goal: ${goal}`,
        `Delivery level: ${deliveryLevel}`,
        "Work backward from the desired result, define the coarse modules, and keep implementation tasks pending until the user explicitly starts execution.",
      ].join("\n"),
      acceptanceCriteria: [
        "The desired result is stated clearly.",
        "The decomposition can be edited before execution.",
      ],
      skillHints: ["planning"],
      metadata: { module: "goal" },
    }),
  ];

  let previousModule = "goal";
  for (const template of templates) {
    tasks.push(planTask({
      key: template.key,
      role: template.role,
      title: template.title,
      input: [
        `Goal: ${goal}`,
        `Module: ${template.title}`,
        template.moduleInstruction,
        "Return the module decision and keep child leaf tasks executable.",
      ].join("\n"),
      parentKey: "goal",
      dependsOn: previousModule === "goal" ? ["goal"] : [previousModule],
      acceptanceCriteria: template.acceptanceCriteria,
      skillHints: template.skillHints,
      toolHints: template.toolHints,
      wave: 1,
      metadata: { module: template.key },
    }));
    for (const leaf of template.leaves) {
      tasks.push(planTask({
        key: leaf.key,
        role: leaf.role || template.leafRole || template.role,
        title: leaf.title,
        input: [
          `Goal: ${goal}`,
          `Parent module: ${template.title}`,
          leaf.instruction,
          "Produce a concrete, reviewable work product when this leaf is executed.",
        ].join("\n"),
        parentKey: template.key,
        dependsOn: [template.key, ...(leaf.dependsOn || [])],
        acceptanceCriteria: leaf.acceptanceCriteria,
        skillHints: leaf.skillHints || template.skillHints,
        toolHints: leaf.toolHints || template.toolHints,
        wave: 2,
        metadata: { module: template.key, slice: leaf.key },
      }));
    }
    previousModule = template.key;
  }

  return {
    goal,
    deliveryLevel,
    exitCriteria,
    planningMode: "single_wave",
    maxWaves: 2,
    failureStrategy: "block_dependents",
    tasks,
    review: {
      required: false,
      criteria: exitCriteria,
    },
    clarificationRequired: false,
    clarificationQuestions: [],
  };
}

export function createFallbackGraphPatch({
  plan,
  parentKey,
  existingKeys,
}: {
  plan: PlanSpec;
  parentKey: string;
  existingKeys: Set<string>;
}): GraphPatchSpec {
  if (parentKey !== "architecture") {
    return emptyPatch(parentKey, "No fallback expansion is defined for this task.");
  }
  const implementationKey = uniqueKey("implementation", existingKeys);
  const verificationKey = uniqueKey("verification", new Set([...existingKeys, implementationKey]));
  const taskInputPrefix = [
    `Goal: ${plan.goal}`,
    `Delivery level: ${plan.deliveryLevel}`,
    `Planning mode: ${plan.planningMode}`,
    "Exit criteria:",
    ...plan.exitCriteria.map((item) => `- ${item}`),
    "",
  ].join("\n");
  return {
    reason: "Fallback rolling expansion from architecture into implementation and verification slices.",
    parentKey,
    stop: false,
    needsUserInput: false,
    questions: [],
    tasks: [
      planTask({
        key: implementationKey,
        parentKey,
        role: "developer",
        title: `implementation: ${plan.goal.slice(0, 60)}`,
        input: `${taskInputPrefix}Implement or specify the first concrete leaf slice under ${parentKey}. Keep scope narrow and return remaining sibling/child slices as next actions.`,
        dependsOn: [parentKey],
        acceptanceCriteria: [
          "A concrete implementation slice or precise executable design is produced.",
          "The result states what remains for later rolling waves.",
        ],
        wave: 2,
        skillHints: ["coding", "implementation"],
        toolHints: ["read_file", "write_file", "run_tests"],
      }),
      planTask({
        key: verificationKey,
        parentKey: implementationKey,
        role: "reviewer",
        title: `verification: ${plan.goal.slice(0, 60)}`,
        input: `${taskInputPrefix}Verify the implementation leaf slice against the exit criteria and return pass/fail/needs_user_input.`,
        dependsOn: [implementationKey],
        dependencyType: "finished",
        acceptanceCriteria: plan.exitCriteria,
        wave: 2,
        skillHints: ["review", "quality"],
      }),
    ],
  };
}

export function validatePlanSpec(spec: PlanSpec): PlanValidationResult {
  const errors: string[] = [];
  if (!spec.goal.trim()) errors.push("goal is required");
  if (!DELIVERY_LEVELS.has(spec.deliveryLevel)) errors.push(`invalid deliveryLevel: ${spec.deliveryLevel}`);
  if (!PLANNING_MODES.has(spec.planningMode)) errors.push(`invalid planningMode: ${spec.planningMode}`);
  if (!FAILURE_STRATEGIES.has(spec.failureStrategy)) errors.push(`invalid failureStrategy: ${spec.failureStrategy}`);
  if (!Number.isInteger(spec.maxWaves) || spec.maxWaves < 1 || spec.maxWaves > 100) errors.push("maxWaves must be between 1 and 100");
  if (!spec.exitCriteria.length) errors.push("exitCriteria must not be empty");
  if (!spec.tasks.length) errors.push("tasks must not be empty");

  const keys = new Set<string>();
  for (const task of spec.tasks) {
    if (!/^[A-Za-z0-9._-]+$/.test(task.key)) errors.push(`invalid task key: ${task.key}`);
    if (keys.has(task.key)) errors.push(`duplicate task key: ${task.key}`);
    keys.add(task.key);
    if (!/^[A-Za-z0-9._-]+$/.test(task.role)) errors.push(`invalid role for ${task.key}: ${task.role}`);
    if (!task.title.trim()) errors.push(`title is required for ${task.key}`);
    if (!task.input.trim()) errors.push(`input is required for ${task.key}`);
    if (!task.acceptanceCriteria.length) errors.push(`acceptanceCriteria is required for ${task.key}`);
    if (task.timeoutMs < 1000 || task.timeoutMs > 10 * 60 * 1000) errors.push(`timeoutMs out of range for ${task.key}`);
    if (task.maxRetries < 0 || task.maxRetries > 5) errors.push(`maxRetries out of range for ${task.key}`);
    if (task.maxResultChars < 1000 || task.maxResultChars > 100000) errors.push(`maxResultChars out of range for ${task.key}`);
    if (task.maxMemoryCandidates < 0 || task.maxMemoryCandidates > 20) errors.push(`maxMemoryCandidates out of range for ${task.key}`);
    if (task.wave < 1 || task.wave > spec.maxWaves) errors.push(`wave out of range for ${task.key}`);
    if (task.maxExpansionDepth < 0 || task.maxExpansionDepth > 20) errors.push(`maxExpansionDepth out of range for ${task.key}`);
    if (task.permissionMode && !isPermissionMode(task.permissionMode)) errors.push(`invalid permissionMode for ${task.key}: ${task.permissionMode}`);
  }

  for (const task of spec.tasks) {
    for (const dependency of task.dependsOn) {
      if (!keys.has(dependency)) errors.push(`unknown dependency for ${task.key}: ${dependency}`);
      if (dependency === task.key) errors.push(`task cannot depend on itself: ${task.key}`);
    }
  }
  errors.push(...detectCycles(spec.tasks));
  errors.push(...validateParentHierarchy(spec.tasks));

  return { ok: errors.length === 0, errors };
}

export function validateGraphPatchSpec(
  patch: GraphPatchSpec,
  {
    parentKey,
    existingKeys = new Set<string>(),
    maxTasks = 50,
    maxWave = 100,
  }: {
    parentKey: string;
    existingKeys?: Set<string>;
    maxTasks?: number;
    maxWave?: number;
  },
): PlanValidationResult {
  const errors: string[] = [];
  if (patch.parentKey !== parentKey) errors.push(`patch parentKey must be ${parentKey}`);
  if (!patch.reason.trim()) errors.push("reason is required");
  if (patch.tasks.length > maxTasks) errors.push(`too many patch tasks: ${patch.tasks.length}`);
  if (patch.stop && patch.tasks.length) errors.push("stop patch must not include tasks");
  if (patch.needsUserInput && !patch.questions.length) errors.push("needsUserInput requires questions");

  const keys = new Set<string>();
  for (const task of patch.tasks) {
    if (!/^[A-Za-z0-9._-]+$/.test(task.key)) errors.push(`invalid task key: ${task.key}`);
    if (keys.has(task.key)) errors.push(`duplicate patch task key: ${task.key}`);
    if (existingKeys.has(task.key)) errors.push(`patch task key already exists: ${task.key}`);
    keys.add(task.key);
    if (!/^[A-Za-z0-9._-]+$/.test(task.role)) errors.push(`invalid role for ${task.key}: ${task.role}`);
    if (!task.title.trim()) errors.push(`title is required for ${task.key}`);
    if (!task.input.trim()) errors.push(`input is required for ${task.key}`);
    if (!task.acceptanceCriteria.length) errors.push(`acceptanceCriteria is required for ${task.key}`);
    if (task.timeoutMs < 1000 || task.timeoutMs > 10 * 60 * 1000) errors.push(`timeoutMs out of range for ${task.key}`);
    if (task.maxRetries < 0 || task.maxRetries > 5) errors.push(`maxRetries out of range for ${task.key}`);
    if (task.maxResultChars < 1000 || task.maxResultChars > 100000) errors.push(`maxResultChars out of range for ${task.key}`);
    if (task.maxMemoryCandidates < 0 || task.maxMemoryCandidates > 20) errors.push(`maxMemoryCandidates out of range for ${task.key}`);
    if (task.wave < 1 || task.wave > maxWave) errors.push(`wave out of range for ${task.key}`);
    if (task.maxExpansionDepth < 0 || task.maxExpansionDepth > 20) errors.push(`maxExpansionDepth out of range for ${task.key}`);
    if (task.permissionMode && !isPermissionMode(task.permissionMode)) errors.push(`invalid permissionMode for ${task.key}: ${task.permissionMode}`);
  }

  const allowedKeys = new Set([...existingKeys, ...keys]);
  for (const task of patch.tasks) {
    for (const dependency of task.dependsOn) {
      if (!allowedKeys.has(dependency)) errors.push(`unknown dependency for ${task.key}: ${dependency}`);
      if (dependency === task.key) errors.push(`task cannot depend on itself: ${task.key}`);
    }
  }
  errors.push(...detectCycles(patch.tasks));
  errors.push(...validateParentHierarchy(patch.tasks, new Set([...existingKeys, parentKey])));

  return { ok: errors.length === 0, errors };
}

export function inferDeliveryLevel(input: string): DeliveryLevel | null {
  const normalized = input.toLowerCase();
  if (/\bprod\b|\bproduction\b|生产|上线|商用|可运维|高可用/.test(normalized)) return "production";
  if (/\buat\b|验收|预发|测试环境|用户验收/.test(normalized)) return "uat";
  if (/\bpoc\b|原型|验证|demo|概念验证|跑通/.test(normalized)) return "poc";
  return null;
}

export function isOutcomeOrLongTask(input: string): boolean {
  return /(做一个|开发一个|实现一个|构建|完整|应用|系统|平台|项目|几十|几百|模块|功能|接口|测试用例|生产|uat|poc)/i.test(input);
}

export function requiresDeliveryLevelClarification(input: string): boolean {
  return isOutcomeOrLongTask(input) && !inferDeliveryLevel(input);
}

export function deliveryLevelQuestion(input: string): string {
  return [
    "这个需求看起来是结果导向的长任务，我需要先确认准出标准再开始自动拆分执行。",
    "",
    "请确认目标等级：",
    "- POC：跑通核心链路，允许简化实现和少量手工验证。",
    "- UAT：面向验收，核心功能完整，有接口/状态/错误处理和测试说明。",
    "- 生产：面向上线，需要可靠性、可观测性、恢复策略、安全边界和较完整测试。",
    "",
    `当前需求：${input.trim()}`,
  ].join("\n");
}

function normalizePlanSpec(input: Record<string, unknown>): PlanSpec | null {
  const deliveryLevel = DELIVERY_LEVELS.has(String(input.deliveryLevel) as DeliveryLevel)
    ? String(input.deliveryLevel) as DeliveryLevel
    : "poc";
  const goal = stringValue(input.goal);
  const exitCriteria = listValue(input.exitCriteria, defaultExitCriteria(deliveryLevel, goal));
  const tasksInput = Array.isArray(input.tasks) ? input.tasks : [];
  const tasks = tasksInput.map((item, index) => normalizeTaskSpec(item, index)).filter((item): item is PlanTaskSpec => Boolean(item));
  if (!goal || !tasks.length) return null;
  return {
    goal,
    deliveryLevel,
    exitCriteria,
    planningMode: PLANNING_MODES.has(String(input.planningMode) as PlanningMode) ? String(input.planningMode) as PlanningMode : "single_wave",
    maxWaves: boundedInteger(input.maxWaves, 1, 1, 100),
    failureStrategy: FAILURE_STRATEGIES.has(String(input.failureStrategy) as GraphFailureStrategy) ? String(input.failureStrategy) as GraphFailureStrategy : "block_dependents",
    tasks,
    review: normalizeReview(input.review, exitCriteria),
    clarificationRequired: input.clarificationRequired === true,
    clarificationQuestions: listValue(input.clarificationQuestions, []),
  };
}

function normalizeGraphPatchSpec(input: Record<string, unknown>, parentKey: string): GraphPatchSpec | null {
  const resolvedParentKey = stringValue(input.parentKey) || parentKey;
  if (!resolvedParentKey) return null;
  const tasksInput = Array.isArray(input.tasks) ? input.tasks : [];
  return {
    reason: stringValue(input.reason) || "Planner graph expansion patch.",
    parentKey: resolvedParentKey,
    tasks: tasksInput
      .map((item, index) => normalizeTaskSpec(item, index, resolvedParentKey))
      .filter((item): item is PlanTaskSpec => Boolean(item)),
    stop: input.stop === true,
    needsUserInput: input.needsUserInput === true,
    questions: listValue(input.questions, []),
  };
}

function normalizeTaskSpec(item: unknown, index: number, defaultParentKey?: string): PlanTaskSpec | null {
  if (!isObject(item)) return null;
  const key = stringValue(item.key) || `task_${index + 1}`;
  const role = stringValue(item.role) || "developer";
  const title = stringValue(item.title) || `${role}: ${key}`;
  const input = stringValue(item.input) || title;
  return planTask({
    key,
    role,
    title,
    input,
    parentKey: stringValue(item.parentKey) || defaultParentKey || undefined,
    dependsOn: listValue(item.dependsOn, []),
    dependencyType: item.dependencyType === "finished" ? "finished" : "success",
    acceptanceCriteria: listValue(item.acceptanceCriteria, ["Task produces a useful result for the graph."]),
    toolHints: listValue(item.toolHints, []),
    skillHints: listValue(item.skillHints, []),
    timeoutMs: boundedInteger(item.timeoutMs, 30000, 1000, 10 * 60 * 1000),
    maxRetries: boundedInteger(item.maxRetries, 1, 0, 5),
    maxResultChars: boundedInteger(item.maxResultChars, 12000, 1000, 100000),
    maxMemoryCandidates: boundedInteger(item.maxMemoryCandidates, 1, 0, 20),
    wave: boundedInteger(item.wave, 1, 1, 100),
    expandable: item.expandable === true,
    expansionGoal: stringValue(item.expansionGoal),
    maxExpansionDepth: boundedInteger(item.maxExpansionDepth, 0, 0, 20),
    permissionMode: parsePermissionModeValue(item.permissionMode),
    metadata: sanitizePlannerMetadata(item.metadata),
  });
}

function planTask(input: Partial<PlanTaskSpec> & {
  key: string;
  role: string;
  title: string;
  input: string;
}): PlanTaskSpec {
  return {
    key: input.key,
    role: input.role,
    title: input.title,
    input: input.input,
    parentKey: input.parentKey,
    dependsOn: input.dependsOn || [],
    dependencyType: input.dependencyType || "success",
    acceptanceCriteria: input.acceptanceCriteria || ["Task produces a useful result for the graph."],
    toolHints: input.toolHints || [],
    skillHints: input.skillHints || [],
    timeoutMs: input.timeoutMs || 30000,
    maxRetries: input.maxRetries ?? 1,
    maxResultChars: input.maxResultChars || 12000,
    maxMemoryCandidates: input.maxMemoryCandidates ?? 1,
    wave: input.wave || 1,
    expandable: input.expandable === true,
    expansionGoal: input.expansionGoal || "",
    maxExpansionDepth: input.maxExpansionDepth ?? 0,
    permissionMode: input.permissionMode,
    metadata: input.metadata,
  };
}

interface PlanningTemplate {
  key: string;
  role: string;
  leafRole?: string;
  title: string;
  moduleInstruction: string;
  acceptanceCriteria: string[];
  toolHints: string[];
  skillHints: string[];
  leaves: Array<{
    key: string;
    role?: string;
    title: string;
    instruction: string;
    acceptanceCriteria: string[];
    dependsOn?: string[];
    toolHints?: string[];
    skillHints?: string[];
  }>;
}

function planningTemplatesFor(goal: string, selectedAgents: string[]): PlanningTemplate[] {
  const normalized = goal.toLowerCase();
  if (/todo|待办|任务清单|cli|命令行/.test(normalized)) return todoCliPlanningTemplates();
  if (/(应用|app|系统|平台|网站|web|api|工具|项目|product)/i.test(goal)) return applicationPlanningTemplates(selectedAgents);
  if (/(bug|报错|修复|排查|debug|fix|崩溃|失败)/i.test(goal)) return fixPlanningTemplates();
  if (/(调研|研究|分析|总结|报告|文档|research|report|document)/i.test(goal)) return researchPlanningTemplates();
  return generalPlanningTemplates(selectedAgents);
}

function todoCliPlanningTemplates(): PlanningTemplate[] {
  return [
    {
      key: "requirements_scope",
      role: "planner",
      leafRole: "researcher",
      title: "需求范围",
      moduleInstruction: "Define the Todo POC boundary from the requested result instead of asking the user to enumerate modules.",
      acceptanceCriteria: ["Core flows and explicit out-of-scope items are defined."],
      toolHints: [],
      skillHints: ["planning", "requirements"],
      leaves: [
        {
          key: "requirements_core_flows",
          title: "列出核心用户流程",
          instruction: "Define add, list, complete, and delete flows plus the expected CLI feedback.",
          acceptanceCriteria: ["Core Todo commands and expected outputs are listed."],
        },
        {
          key: "requirements_poc_limits",
          title: "明确 POC 边界",
          instruction: "State which non-core concerns are intentionally deferred for the POC.",
          acceptanceCriteria: ["POC scope and follow-up scope are separated."],
        },
      ],
    },
    {
      key: "data_model",
      role: "developer",
      title: "数据模型",
      moduleInstruction: "Design the smallest useful Todo data shape for the POC.",
      acceptanceCriteria: ["Todo entity and collection shape are specified."],
      toolHints: ["read_file"],
      skillHints: ["coding"],
      leaves: [
        {
          key: "data_model_todo_entity",
          title: "定义 Todo 实体",
          instruction: "Define id, title, completed, and timestamp fields with validation expectations.",
          acceptanceCriteria: ["Todo fields and constraints are concrete."],
        },
        {
          key: "data_model_storage_shape",
          title: "定义存储结构",
          instruction: "Define the JSON file shape and migration-free POC assumptions.",
          acceptanceCriteria: ["JSON storage structure is reviewable."],
        },
      ],
    },
    {
      key: "cli_commands",
      role: "developer",
      title: "CLI 命令",
      moduleInstruction: "Define the command surface that proves the Todo POC works end to end.",
      acceptanceCriteria: ["Every command has syntax, behavior, and error output."],
      toolHints: ["read_file", "write_file"],
      skillHints: ["coding"],
      leaves: [
        {
          key: "cli_add_list",
          title: "设计 add/list 命令",
          instruction: "Specify add <title> and list command behavior, including empty-list output.",
          acceptanceCriteria: ["Add and list command behavior is executable."],
          dependsOn: ["data_model_storage_shape"],
        },
        {
          key: "cli_complete_delete",
          title: "设计 complete/delete 命令",
          instruction: "Specify complete <id> and delete <id> behavior and invalid id handling.",
          acceptanceCriteria: ["Complete and delete command behavior is executable."],
          dependsOn: ["data_model_todo_entity"],
        },
      ],
    },
    {
      key: "persistence",
      role: "developer",
      title: "持久化",
      moduleInstruction: "Plan the minimal persistence layer required to keep tasks between CLI runs.",
      acceptanceCriteria: ["Read/write behavior and error recovery are specified."],
      toolHints: ["read_file", "write_file"],
      skillHints: ["coding"],
      leaves: [
        {
          key: "persistence_load_save",
          title: "实现读写 JSON 的任务",
          instruction: "Define load/save functions, default file location, and first-run behavior.",
          acceptanceCriteria: ["Load/save behavior can be implemented directly."],
          dependsOn: ["data_model_storage_shape"],
        },
        {
          key: "persistence_error_paths",
          title: "处理文件异常路径",
          instruction: "Define behavior for missing, empty, or malformed storage files.",
          acceptanceCriteria: ["Persistence failure handling is explicit."],
          dependsOn: ["persistence_load_save"],
        },
      ],
    },
    {
      key: "validation",
      role: "reviewer",
      leafRole: "reviewer",
      title: "验证",
      moduleInstruction: "Define how to prove the POC satisfies the requested result without expanding scope.",
      acceptanceCriteria: ["Manual and data-level verification steps are listed."],
      toolHints: ["run_tests"],
      skillHints: ["review", "quality"],
      leaves: [
        {
          key: "validation_manual_flow",
          title: "验证完整 CLI 流程",
          instruction: "Run through add, list, complete, delete, and list again as an acceptance script.",
          acceptanceCriteria: ["The acceptance script covers the core path."],
          dependsOn: ["cli_add_list", "cli_complete_delete", "persistence_load_save"],
        },
        {
          key: "validation_storage_file",
          title: "验证数据文件结果",
          instruction: "Inspect the JSON file after operations to confirm persistence and completed state.",
          acceptanceCriteria: ["Stored data matches the CLI-visible state."],
          dependsOn: ["validation_manual_flow"],
        },
      ],
    },
  ];
}

function applicationPlanningTemplates(selectedAgents: string[]): PlanningTemplate[] {
  const implementationRole = selectedAgents.includes("developer") ? "developer" : "researcher";
  return [
    simpleTemplate("requirements_scope", "planner", "需求范围", "Define the outcome, users, core flows, and non-goals.", ["Core flows and constraints are explicit."]),
    simpleTemplate("domain_model", implementationRole, "领域/数据模型", "Define the domain objects, state transitions, and data boundaries.", ["Domain state is concrete enough for implementation."]),
    simpleTemplate("interface_surface", implementationRole, "接口/交互面", "Define the user-visible commands, screens, APIs, or integration points.", ["The interaction surface proves the core result."]),
    simpleTemplate("implementation_slices", implementationRole, "实现切片", "Break the result into independently executable implementation slices.", ["Leaf slices can be assigned to subagents."]),
    simpleTemplate("validation", "reviewer", "验证", "Define tests, manual checks, and acceptance evidence.", ["Verification proves the requested result."]),
  ];
}

function fixPlanningTemplates(): PlanningTemplate[] {
  return [
    simpleTemplate("reproduce", "developer", "复现", "Define how to reproduce or observe the failure.", ["The failure signal is reproducible or bounded."]),
    simpleTemplate("isolate", "developer", "定位", "Identify likely components, inputs, and failure boundaries.", ["The suspected cause is testable."]),
    simpleTemplate("patch_plan", "developer", "修复方案", "Define the smallest safe patch and rollback considerations.", ["The patch scope is narrow and reviewable."]),
    simpleTemplate("regression_validation", "reviewer", "回归验证", "Define tests or checks that prevent recurrence.", ["Regression coverage is explicit."]),
  ];
}

function researchPlanningTemplates(): PlanningTemplate[] {
  return [
    simpleTemplate("research_questions", "researcher", "研究问题", "Turn the goal into answerable questions and decision criteria.", ["Questions map to the desired deliverable."]),
    simpleTemplate("source_strategy", "researcher", "资料路径", "Define primary sources, search strategy, and freshness requirements.", ["Source requirements are explicit."]),
    simpleTemplate("synthesis", "researcher", "综合分析", "Define comparison dimensions and synthesis output.", ["The synthesis will support a decision or clear answer."]),
    simpleTemplate("validation", "reviewer", "验证", "Define cross-checks, uncertainty notes, and citation expectations.", ["Findings can be audited." ]),
  ];
}

function generalPlanningTemplates(selectedAgents: string[]): PlanningTemplate[] {
  const role = selectedAgents.includes("developer") ? "developer" : "researcher";
  return [
    simpleTemplate("scope", "planner", "范围", "Clarify the desired result, constraints, and explicit non-goals.", ["Scope is actionable."]),
    simpleTemplate("workstreams", role, "工作流", "Break the result into independent workstreams.", ["Workstreams have clear outputs."]),
    simpleTemplate("execution_leaves", role, "可执行叶子任务", "Split workstreams into concrete leaf tasks.", ["Leaves can be assigned and verified."]),
    simpleTemplate("validation", "reviewer", "验证", "Define the acceptance checks.", ["The final result can be reviewed."]),
  ];
}

function simpleTemplate(key: string, role: string, title: string, moduleInstruction: string, acceptanceCriteria: string[]): PlanningTemplate {
  return {
    key,
    role,
    title,
    moduleInstruction,
    acceptanceCriteria,
    toolHints: role === "developer" ? ["read_file"] : [],
    skillHints: role === "reviewer" ? ["review"] : role === "developer" ? ["coding"] : ["planning"],
    leaves: [
      {
        key: `${key}_define`,
        role,
        title: `${title}定义`,
        instruction: `Define the work product for ${title}.`,
        acceptanceCriteria,
      },
      {
        key: `${key}_verify`,
        role: "reviewer",
        title: `${title}检查点`,
        instruction: `Define how to verify the ${title} work product.`,
        acceptanceCriteria: ["A clear check or acceptance note is available."],
        dependsOn: [`${key}_define`],
        skillHints: ["review"],
      },
    ],
  };
}

function normalizePlanningGoal(input: string): string {
  return input
    .replace(/[，,。.;；]?\s*(?:不要|不用|先别|暂不|别|无需).{0,16}(?:实现|执行|开发|写代码|动手|开工|run|execute|implement|code).*$/i, "")
    .replace(/[，,。.;；]?\s*(?:只|仅).{0,8}(?:规划|计划|拆解|拆成|列出).{0,20}$/i, "")
    .trim() || input.trim();
}

function parsePermissionModeValue(value: unknown): PermissionMode | undefined {
  if (value === "read_only" || value === "workspace_write" || value === "danger_full_access") return value;
  return undefined;
}

export function sanitizePlannerMetadata(value: unknown): Metadata | undefined {
  if (!isObject(value)) return undefined;
  const sanitized: Metadata = {};
  for (const [key, item] of Object.entries(value)) {
    if (!PLANNER_METADATA_ALLOWLIST.has(key)) continue;
    const normalized = safePlannerMetadataValue(item);
    if (normalized !== undefined) sanitized[key] = normalized;
  }
  return Object.keys(sanitized).length ? sanitized : undefined;
}

const PLANNER_METADATA_ALLOWLIST = new Set([
  "area",
  "category",
  "component",
  "feature",
  "module",
  "notes",
  "owner",
  "priority",
  "references",
  "risk",
  "slice",
  "tags",
  "target",
]);

function safePlannerMetadataValue(value: unknown): Metadata[string] | undefined {
  if (typeof value === "string") return value.slice(0, 2000);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      .map((item) => typeof item === "string" ? item.slice(0, 500) : item)
      .slice(0, 20);
  }
  return undefined;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "read_only" || value === "workspace_write" || value === "danger_full_access";
}

function emptyPatch(parentKey: string, reason: string): GraphPatchSpec {
  return {
    reason,
    parentKey,
    tasks: [],
    stop: false,
    needsUserInput: false,
    questions: [],
  };
}

function uniqueKey(base: string, existingKeys: Set<string>): string {
  if (!existingKeys.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const key = `${base}_${index}`;
    if (!existingKeys.has(key)) return key;
  }
  return `${base}_${Date.now()}`;
}

function normalizeReview(input: unknown, fallbackCriteria: string[]): PlanReviewSpec {
  if (!isObject(input)) return { required: true, criteria: fallbackCriteria };
  return {
    required: input.required !== false,
    criteria: listValue(input.criteria, fallbackCriteria),
  };
}

function defaultExitCriteria(deliveryLevel: DeliveryLevel, goal: string): string[] {
  if (deliveryLevel === "production") {
    return [
      "Core user-facing requirements are implemented or explicitly blocked.",
      "Critical failure paths, recovery behavior, and operational risks are documented.",
      "Relevant tests or verification steps are available for core flows.",
      "The result is reviewable against production readiness expectations.",
    ];
  }
  if (deliveryLevel === "uat") {
    return [
      "Core flows for the requested outcome are complete enough for acceptance review.",
      "Important edge cases and known limitations are documented.",
      "Verification steps or tests are defined for acceptance.",
    ];
  }
  return [
    `The core path for ${goal.slice(0, 80)} is demonstrably planned or implemented.`,
    "Non-core concerns can be listed as follow-up work.",
    "The result has a concise verification note.",
  ];
}

function hasPlanShape(value: Record<string, unknown>): boolean {
  return typeof value.goal === "string" && Array.isArray(value.tasks);
}

function hasGraphPatchShape(value: Record<string, unknown>): boolean {
  return Array.isArray(value.tasks)
    || value.stop === true
    || value.needsUserInput === true
    || typeof value.reason === "string";
}

function planSourceFrom(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  if (hasPlanShape(value)) return value;
  if (isObject(value.plan)) return value.plan;
  if (typeof value.content === "string") {
    return planSourceFrom(parseJsonCandidate(value.content));
  }
  return null;
}

function graphPatchSourceFrom(value: unknown): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  if (hasGraphPatchShape(value)) return value;
  if (isObject(value.graphPatch)) return value.graphPatch;
  if (isObject(value.patch)) return value.patch;
  if (typeof value.content === "string") {
    return graphPatchSourceFrom(parseJsonCandidate(value.content));
  }
  return null;
}

function parseJsonCandidate(raw: string): unknown | null {
  for (const candidate of jsonCandidates(raw)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function jsonCandidates(raw: string): string[] {
  const candidates: string[] = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const extracted = extractBalancedJson(raw);
  if (extracted) candidates.push(extracted);
  return candidates.filter(Boolean);
}

function extractBalancedJson(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

function detectCycles(tasks: PlanTaskSpec[]): string[] {
  const errors: string[] = [];
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, path: string[]) => {
    if (visiting.has(key)) {
      errors.push(`cycle detected: ${[...path, key].join(" -> ")}`);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn || []) {
      if (byKey.has(dependency)) visit(dependency, [...path, key]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of tasks) visit(task.key, []);
  return errors;
}

function validateParentHierarchy(tasks: PlanTaskSpec[], allowedExternalParents = new Set<string>()): string[] {
  const errors: string[] = [];
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  for (const task of tasks) {
    const parentKey = task.parentKey?.trim();
    if (!parentKey) continue;
    if (parentKey === task.key) errors.push(`task cannot be its own parent: ${task.key}`);
    if (!byKey.has(parentKey) && !allowedExternalParents.has(parentKey)) {
      errors.push(`unknown parentKey for ${task.key}: ${parentKey}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, path: string[]) => {
    if (visiting.has(key)) {
      errors.push(`parent cycle detected: ${[...path, key].join(" -> ")}`);
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    const parentKey = byKey.get(key)?.parentKey || "";
    if (byKey.has(parentKey)) visit(parentKey, [...path, key]);
    visiting.delete(key);
    visited.add(key);
  };
  for (const task of tasks) visit(task.key, []);
  return errors;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function listValue(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
