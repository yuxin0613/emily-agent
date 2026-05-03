import type { SkillCandidate, SkillCandidateProposal, SkillDefinition, Task, ToolPermission } from "../types.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import { parseTaskResult } from "../tasks/TaskResult.ts";
import type { SkillCandidateStore } from "./SkillCandidateStore.ts";
import type { SkillRegistry } from "./SkillRegistry.ts";

interface BuildSkillCandidateResult {
  candidates: SkillCandidate[];
  updates: Array<{
    action: "create" | "update";
    candidateId: string;
    proposalType: SkillCandidate["proposalType"];
    name: string;
    targetSkillName: string | null;
    score: number;
  }>;
}

interface WorkflowGroup {
  key: string;
  tasks: Task[];
}

export class SkillBuilder {
  taskStore: TaskStore;
  skillCandidateStore: SkillCandidateStore;
  skillRegistry: SkillRegistry;

  constructor({
    taskStore,
    skillCandidateStore,
    skillRegistry,
  }: {
    taskStore: TaskStore;
    skillCandidateStore: SkillCandidateStore;
    skillRegistry: SkillRegistry;
  }) {
    this.taskStore = taskStore;
    this.skillCandidateStore = skillCandidateStore;
    this.skillRegistry = skillRegistry;
  }

  buildSkillCandidates({
    day = new Date(),
    lookbackDays = 2,
    minOccurrences = 3,
    minScore = 0.68,
    dailyLimit = 3,
  }: {
    day?: Date;
    lookbackDays?: number;
    minOccurrences?: number;
    minScore?: number;
    dailyLimit?: number;
  } = {}): BuildSkillCandidateResult {
    const { start, end } = dayRange(day, lookbackDays);
    const tasks = this.taskStore.getTerminalTasksBetween({
      start,
      end,
      limit: 500,
    });

    const proposals = this.groupTasks(tasks)
      .map((group) => this.groupToProposal(group, { minOccurrences }))
      .filter((proposal): proposal is SkillCandidateProposal => Boolean(proposal))
      .filter((proposal) => proposal.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, dailyLimit);

    const updates = proposals.map((proposal) => {
      const result = this.skillCandidateStore.proposeCandidate(proposal);
      return {
        action: result.action,
        candidateId: result.candidate.id,
        proposalType: result.candidate.proposalType,
        name: result.candidate.name,
        targetSkillName: result.candidate.targetSkillName,
        score: result.candidate.score,
      };
    });

    return {
      candidates: updates.map((update) => this.skillCandidateStore.getCandidateOrThrow(update.candidateId)),
      updates,
    };
  }

  private groupTasks(tasks: Task[]): WorkflowGroup[] {
    const groups = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.status === "cancelled") continue;
      const key = workflowKey(task);
      const current = groups.get(key) || [];
      current.push(task);
      groups.set(key, current);
    }
    return [...groups.entries()].map(([key, groupedTasks]) => ({ key, tasks: groupedTasks }));
  }

  private groupToProposal(group: WorkflowGroup, { minOccurrences }: { minOccurrences: number }): SkillCandidateProposal | null {
    if (group.tasks.length < minOccurrences) return null;
    const successCount = group.tasks.filter((task) => task.status === "done").length;
    const successRate = successCount / group.tasks.length;
    if (successRate < 0.72) return null;

    const workflowSimilarity = averagePairwiseSimilarity(group.tasks.map(taskWorkflowText));
    if (workflowSimilarity < 0.32) return null;

    const verificationQuality = verificationScore(group.tasks);
    const volatility = volatilityScore(group.tasks);
    const projectSpecificity = projectSpecificityScore(group.tasks);
    const evidenceText = group.tasks.map(taskWorkflowText).join("\n");
    const existing = closestSkill(evidenceText, this.skillRegistry.list());
    const overlapWithExisting = existing.score;
    const targetSkillName = existing.skill && existing.score >= 0.5 && existing.skill.source === "file" ? existing.skill.name : null;
    const proposalType: SkillCandidateProposal["proposalType"] = targetSkillName ? "update" : "create";
    const repetition = Math.min(1, group.tasks.length / Math.max(1, minOccurrences));
    const timeSaved = Math.min(1, group.tasks.length / 6);
    const score = clamp01(
      repetition * 0.2
      + successRate * 0.22
      + workflowSimilarity * 0.18
      + verificationQuality * 0.16
      + timeSaved * 0.12
      - volatility * 0.12
      - (targetSkillName ? 0 : overlapWithExisting * 0.08)
      - projectSpecificity * 0.08,
    );
    const title = preferredMetadata(group.tasks, "skillCandidateTitle") || titleFromGroup(group);
    const name = preferredMetadata(group.tasks, "skillCandidateName") || slug(title);
    const toolHints = uniqueTools(group.tasks.flatMap((task) => readStringArray(task.metadata.toolHints)));
    const trigger = triggerLines(group.tasks, title);

    return {
      proposalType,
      workflowKey: group.key,
      name,
      title,
      description: `Repeatable workflow inferred from ${group.tasks.length} similar successful task runs.`,
      trigger,
      antiTrigger: [
        "Do not use when the task has different acceptance criteria, safety constraints, or validation commands.",
        "Do not use for one-off facts that should remain memory or experience.",
      ],
      toolHints,
      body: workflowBody(group.tasks),
      targetSkillName,
      evidenceTaskIds: group.tasks.map((task) => task.id),
      evidenceEventIds: [],
      frequency: group.tasks.length,
      successRate,
      workflowSimilarity,
      verificationQuality,
      volatility,
      overlapWithExisting,
      projectSpecificity,
      score,
    };
  }
}

function dayRange(day: Date, lookbackDays: number): { start: string; end: string } {
  const startDate = new Date(day);
  startDate.setUTCHours(0, 0, 0, 0);
  startDate.setUTCDate(startDate.getUTCDate() - Math.max(0, Math.floor(lookbackDays) - 1));
  const endDate = new Date(day);
  endDate.setUTCHours(0, 0, 0, 0);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  };
}

function workflowKey(task: Task): string {
  const explicit = stringMetadata(task, "skillCandidateKey") || stringMetadata(task, "workflowKey");
  if (explicit) return slug(explicit);
  const skillHints = readStringArray(task.metadata.skillHints).sort().join(".");
  const toolHints = readStringArray(task.metadata.toolHints).sort().join(".");
  const tokens = topTokens([task.title, task.input].join(" "), 4).join(".");
  return slug([task.role, skillHints, toolHints, tokens].filter(Boolean).join("."));
}

function taskWorkflowText(task: Task): string {
  const result = parseTaskResult(task.result)?.summary || task.result || "";
  return [
    task.role,
    task.title,
    task.input,
    readStringArray(task.metadata.toolHints).join(" "),
    readStringArray(task.metadata.skillHints).join(" "),
    result,
  ].join("\n");
}

function workflowBody(tasks: Task[]): string {
  const commonTools = uniqueTools(tasks.flatMap((task) => readStringArray(task.metadata.toolHints)));
  const commonSkills = unique(tasks.flatMap((task) => readStringArray(task.metadata.skillHints)));
  const representative = tasks[0];
  const result = parseTaskResult(representative.result)?.summary || representative.result || "";
  const validation = validationLines(tasks);

  return [
    "1. Confirm the current task matches the trigger and acceptance criteria.",
    commonSkills.length ? `2. Apply these skill hints as context: ${commonSkills.join(", ")}.` : "2. Read the task input and identify the repeated workflow shape.",
    commonTools.length ? `3. Use only permitted tools from this set when they are allowed by the role: ${commonTools.join(", ")}.` : "3. Use only tools allowed by the current role.",
    "4. Follow the proven sequence from the evidence tasks:",
    ...extractActionLines(tasks).map((line) => `   - ${line}`),
    validation.length ? "5. Validate with:" : "5. Validate against the task acceptance criteria.",
    ...validation.map((line) => `   - ${line}`),
    result ? "6. Return the concise result, verification notes, and remaining risks." : "6. Return the concise result and remaining risks.",
  ].join("\n");
}

function triggerLines(tasks: Task[], title: string): string[] {
  const hints = unique(tasks.flatMap((task) => readStringArray(task.metadata.skillHints)));
  const tokens = topTokens(tasks.map((task) => `${task.title} ${task.input}`).join(" "), 5);
  return unique([
    title,
    hints.length ? `Tasks that need ${hints.join(", ")} workflow.` : "",
    tokens.length ? `Requests mentioning ${tokens.join(", ")}.` : "",
  ].filter(Boolean));
}

function titleFromGroup(group: WorkflowGroup): string {
  const explicit = preferredMetadata(group.tasks, "skillCandidateTitle");
  if (explicit) return explicit;
  const tokens = topTokens(group.tasks.map((task) => `${task.title} ${task.input}`).join(" "), 3);
  return titleCase(tokens.length ? tokens.join(" ") : `${group.tasks[0].role} workflow`);
}

function preferredMetadata(tasks: Task[], key: string): string | null {
  for (const task of tasks) {
    const value = stringMetadata(task, key);
    if (value) return value;
  }
  return null;
}

function stringMetadata(task: Task, key: string): string | null {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractActionLines(tasks: Task[]): string[] {
  const lines = unique(tasks.flatMap((task) => [
    ...sentenceFragments(task.input),
    ...sentenceFragments(parseTaskResult(task.result)?.summary || task.result || ""),
  ]))
    .filter((line) => /(check|inspect|read|update|run|verify|test|review|检查|读取|更新|运行|验证|测试|审查|确认)/i.test(line))
    .slice(0, 5);
  return lines.length ? lines : ["Use the same ordered checks and validation path shown by the evidence tasks."];
}

function validationLines(tasks: Task[]): string[] {
  return unique(tasks.flatMap((task) => {
    const text = [task.input, task.result || ""].join("\n");
    const lines = sentenceFragments(text).filter((line) => /(test|check|verify|pass|npm|node|测试|验证|通过|检查)/i.test(line));
    if (readStringArray(task.metadata.toolHints).includes("run_tests")) {
      lines.push("Run the relevant test or check command for this workflow.");
    }
    return lines;
  })).slice(0, 4);
}

function verificationScore(tasks: Task[]): number {
  const verified = tasks.filter((task) => {
    const text = [task.input, task.result || ""].join("\n");
    return readStringArray(task.metadata.toolHints).includes("run_tests")
      || /(test|check|verify|pass|npm run|node test|测试|验证|通过|检查)/i.test(text);
  }).length;
  return verified / Math.max(1, tasks.length);
}

function volatilityScore(tasks: Task[]): number {
  const failed = tasks.filter((task) => task.status !== "done").length / Math.max(1, tasks.length);
  const text = tasks.map(taskWorkflowText).join("\n");
  const temporary = /(temporary|one-off|临时|一次性|试一下|随便)/i.test(text) ? 0.35 : 0;
  return clamp01(failed + temporary);
}

function projectSpecificityScore(tasks: Task[]): number {
  const text = tasks.map((task) => `${task.title}\n${task.input}`).join("\n");
  const pathMatches = text.match(/(?:src|test|agents|skills)\/[A-Za-z0-9._/-]+/g) || [];
  const idMatches = text.match(/[a-f0-9]{8,}/gi) || [];
  return clamp01((pathMatches.length + idMatches.length) / 12);
}

function closestSkill(text: string, skills: SkillDefinition[]): { skill: SkillDefinition | null; score: number } {
  const textTokens = tokenize(text);
  let best: { skill: SkillDefinition | null; score: number } = { skill: null, score: 0 };
  for (const skill of skills) {
    const score = tokenOverlap(textTokens, tokenize([
      skill.name,
      skill.title,
      skill.description,
      skill.capabilities.join(" "),
      skill.instructions,
    ].join("\n")));
    if (score > best.score) best = { skill, score };
  }
  return best;
}

function averagePairwiseSimilarity(texts: string[]): number {
  if (texts.length < 2) return 1;
  let total = 0;
  let count = 0;
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      total += tokenOverlap(tokenize(texts[i]), tokenize(texts[j]));
      count += 1;
    }
  }
  return count ? total / count : 0;
}

function tokenOverlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) shared += 1;
  }
  return shared / Math.max(1, Math.min(leftSet.size, rightSet.size));
}

function topTokens(text: string, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token));
}

function sentenceFragments(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/[。；;.\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8)
    .slice(0, 12);
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueTools(values: string[]): ToolPermission[] {
  return unique(values).filter((value): value is ToolPermission => TOOL_NAMES.has(value as ToolPermission));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "generated-skill";
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

const TOOL_NAMES = new Set<ToolPermission>([
  "read_file",
  "write_file",
  "run_tests",
  "shell",
  "network",
  "http_fetch",
  "web_search",
  "browser",
  "github",
  "create_task",
  "inspect_task",
  "git_reset",
  "delete_file",
]);

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "task",
  "result",
  "workflow",
  "skill",
  "agent",
  "use",
  "using",
  "from",
  "into",
  "return",
  "verify",
]);
