import type { PlanSpec, PlanTaskSpec } from "./PlanSpec.ts";

const MAX_REQUESTED_TASK_NODES = 50;

export function requestedMinimumTaskNodes(input: string): number | null {
  const patterns = [
    /(?:不少于|至少|最少|不低于|>=|大于等于)\s*(\d{1,3})\s*(?:个)?\s*(?:任务节点|任务|节点)/i,
    /(?:任务节点|任务|节点|task\s*nodes?|tasks?|nodes?).{0,16}(?:不少于|至少|最少|不低于|>=|大于等于)\s*(\d{1,3})/i,
    /(?:at\s+least|minimum(?:\s+of)?|no\s+fewer\s+than)\s*(\d{1,3})\s*(?:task\s*nodes?|tasks?|nodes?)/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (!match?.[1]) continue;
    const value = Number.parseInt(match[1], 10);
    if (Number.isFinite(value) && value > 0) return Math.min(value, MAX_REQUESTED_TASK_NODES);
  }
  return null;
}

export function ensureMinimumTaskNodePlan(plan: PlanSpec, input: string): PlanSpec {
  const minimum = requestedMinimumTaskNodes(input);
  if (!minimum || plan.tasks.length >= minimum) return plan;

  const existingKeys = new Set(plan.tasks.map((task) => task.key));
  const anchorKey = preferredParentKey(plan);
  const labels = taskNodeLabels(input);
  const additions: PlanTaskSpec[] = [];
  const needed = minimum - plan.tasks.length;
  const wave = Math.min(Math.max(2, ...plan.tasks.map((task) => task.wave || 1)), Math.max(plan.maxWaves, 2));

  for (let index = 0; index < needed; index += 1) {
    const label = labels[index] || `验收切片 ${index + 1}`;
    const key = uniqueTaskKey(`requested_node_${index + 1}`, existingKeys);
    existingKeys.add(key);
    additions.push({
      key,
      role: "developer",
      title: `任务节点 ${index + 1}: ${label}`,
      input: [
        `Goal: ${plan.goal}`,
        `Slice: ${label}`,
        "Return a concise implementation note for this slice so the final delivery node can incorporate the decision.",
        "Return text only for this node.",
        "Include user-visible behavior, state impact, edge cases, and one verification check.",
      ].join("\n"),
      parentKey: anchorKey || undefined,
      dependsOn: anchorKey ? [anchorKey] : [],
      dependencyType: "success",
      acceptanceCriteria: [
        `${label} has clear user-visible behavior or delivery scope.`,
        "State, interaction, or data impact is explicit.",
        "A concrete verification check is listed.",
      ],
      toolHints: ["read_file"],
      skillHints: ["coding", "implementation"],
      timeoutMs: 30000,
      maxRetries: 1,
      maxResultChars: 6000,
      maxMemoryCandidates: 1,
      wave,
      expandable: false,
      expansionGoal: "",
      maxExpansionDepth: 0,
      metadata: {
        generatedForMinimumTaskNodes: true,
        requestedMinimumTaskNodes: minimum,
        slice: label,
      },
    });
  }

  return {
    ...plan,
    maxWaves: Math.max(plan.maxWaves, wave),
    tasks: [...plan.tasks, ...additions],
  };
}

function preferredParentKey(plan: PlanSpec): string {
  const preferred = [
    "implementation_slices",
    "interface_surface",
    "architecture",
    "domain_model",
    "requirements_scope",
    "scope",
    "goal",
  ];
  for (const key of preferred) {
    const task = plan.tasks.find((item) => item.key === key && item.role !== "reviewer" && item.metadata?.materializationTask !== true);
    if (task) return task.key;
  }
  return plan.tasks.find((task) => task.role !== "reviewer" && task.metadata?.materializationTask !== true)?.key || "";
}

function taskNodeLabels(input: string): string[] {
  const labels: string[] = [];
  for (const match of input.matchAll(/^\s*\d+[.、)]\s*(.+)$/gm)) {
    const label = sanitizeLabel(match[1] || "");
    if (label) labels.push(label);
  }
  const qualityIndex = input.search(/质量要求[:：]/);
  if (qualityIndex >= 0) {
    for (const match of input.slice(qualityIndex).matchAll(/^\s*[-*]\s*(.+)$/gm)) {
      const label = sanitizeLabel(match[1] || "");
      if (label) labels.push(label);
    }
  }
  return unique(labels);
}

function sanitizeLabel(value: string): string {
  const normalized = value
    .replace(/[`"'<>]/g, "")
    .replace(/(?:~\/|\/|\.{1,2}\/)?[A-Za-z0-9_./-]+\.(?:html|css|js|jsx|ts|tsx|json|md|txt)/gi, "交付文档")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, 80);
}

function uniqueTaskKey(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const key = `${base}_${index}`;
    if (!existing.has(key)) return key;
  }
  throw new Error(`Unable to create unique task key for ${base}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
