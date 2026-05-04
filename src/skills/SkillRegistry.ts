import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { SkillDefinition, SkillHintResolution, ToolPermission } from "../types.ts";

export class SkillRegistry {
  private readonly skills: Map<string, SkillDefinition>;
  private readonly aliases: Map<string, string[]>;

  constructor(definitions: SkillDefinition[] = DEFAULT_SKILLS) {
    this.skills = new Map();
    this.aliases = new Map();
    for (const definition of definitions) {
      this.add(definition);
    }
  }

  static async create({
    skillDir = defaultSkillDir(),
    skillDirs,
    includeBuiltIns = true,
  }: {
    skillDir?: string;
    skillDirs?: string[];
    includeBuiltIns?: boolean;
  } = {}): Promise<SkillRegistry> {
    const registry = new SkillRegistry(includeBuiltIns ? DEFAULT_SKILLS : []);
    for (const skill of await readSkillDirectories(skillDirs || defaultSkillDirs(skillDir))) {
      registry.add(skill);
    }
    return registry;
  }

  add(definition: SkillDefinition): void {
    const skill = cloneSkillDefinition(definition);
    this.skills.set(normalizeSkillName(skill.name), skill);
    for (const alias of [skill.name, skill.title, ...skill.aliases, ...skill.capabilities]) {
      const key = normalizeSkillName(alias);
      const existing = this.aliases.get(key) || [];
      if (!existing.includes(skill.name)) existing.push(skill.name);
      this.aliases.set(key, existing);
    }
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()].map(cloneSkillDefinition).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillDefinition | null {
    const matches = this.resolveAll(name);
    return matches[0] ? cloneSkillDefinition(matches[0]) : null;
  }

  resolveHints(hints: string[], options: { allowlist?: string[] } = {}): SkillHintResolution {
    const requested = unique(hints.map(String).map((hint) => hint.trim()).filter(Boolean));
    const matched: SkillDefinition[] = [];
    const unknown: string[] = [];
    const blocked: string[] = [];
    const seen = new Set<string>();
    const allowlist = normalizeAllowlist(options.allowlist);

    for (const hint of requested) {
      const matches = this.resolveAll(hint);
      if (!matches.length) {
        unknown.push(hint);
        continue;
      }
      for (const match of matches) {
        if (allowlist && !allowlist.has(normalizeSkillName(match.name))) {
          if (!blocked.includes(hint)) blocked.push(hint);
          continue;
        }
        if (seen.has(match.name)) continue;
        seen.add(match.name);
        matched.push(match);
      }
    }

    return { requested, matched, unknown, blocked };
  }

  resolveForTask({
    input,
    hints = [],
    allowlist,
    limit = 4,
  }: {
    input: string;
    hints?: string[];
    allowlist?: string[];
    limit?: number;
  }): SkillHintResolution {
    const explicit = this.resolveHints(hints, { allowlist });
    const allow = normalizeAllowlist(allowlist);
    const seen = new Set(explicit.matched.map((skill) => skill.name));
    const autoSelected: string[] = [];
    const autoMatches = [...this.skills.values()]
      .filter((skill) => !seen.has(skill.name))
      .filter((skill) => !allow || allow.has(normalizeSkillName(skill.name)))
      .map((skill) => ({ skill, score: scoreSkillForInput(skill, input) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, limit - explicit.matched.length));

    const matched = [...explicit.matched];
    for (const { skill } of autoMatches) {
      matched.push(cloneSkillDefinition(skill));
      autoSelected.push(skill.name);
    }

    return {
      ...explicit,
      matched,
      autoSelected,
    };
  }

  renderSkillContext(resolution: SkillHintResolution, options: { mode?: "full" | "progressive" } = {}): string[] {
    const lines: string[] = [];
    const progressive = options.mode === "progressive";
    for (const skill of resolution.matched) {
      lines.push([
        `## ${skill.title} (${skill.name})`,
        skill.description,
        skill.triggers.length ? `Use when: ${skill.triggers.join("; ")}` : null,
        skill.antiTriggers.length ? `Avoid when: ${skill.antiTriggers.join("; ")}` : null,
        skill.toolHints.length ? `Tool hints: ${skill.toolHints.join(", ")}` : "Tool hints: (none)",
        progressive ? "Procedure:" : null,
        skill.instructions.trim(),
      ].filter((line): line is string => Boolean(line)).join("\n"));
    }
    if (resolution.blocked?.length) {
      lines.push(`Blocked skill hints by profile allowlist: ${resolution.blocked.join(", ")}`);
    }
    if (resolution.unknown.length) {
      lines.push(`Unknown skill hints: ${resolution.unknown.join(", ")}`);
    }
    return lines.length ? lines : ["(none)"];
  }

  private resolveAll(hint: string): SkillDefinition[] {
    const key = normalizeSkillName(hint);
    const exact = this.skills.get(key);
    if (exact) return [exact];
    const names = this.aliases.get(key) || [];
    return names.map((name) => this.skills.get(normalizeSkillName(name))).filter((item): item is SkillDefinition => Boolean(item));
  }
}

export function defaultSkillDir(): string {
  return process.env.EMILY_SKILL_DIR || path.join(process.cwd(), "skills");
}

export function defaultSkillDirs(skillDir = defaultSkillDir()): string[] {
  const configured = [
    ...splitSkillDirs(process.env.EMILY_SKILL_DIRS),
    ...splitSkillDirs(process.env.EMILY_SKILL_PATHS),
    skillDir,
  ].filter(Boolean);
  return unique(configured);
}

async function readSkillDirectories(skillDirs: string[]): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];
  const seen = new Set<string>();
  for (const skillDir of skillDirs) {
    const resolved = path.resolve(skillDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    skills.push(...await readSkillDirectory(resolved));
  }
  return skills;
}

async function readSkillDirectory(skillDir: string): Promise<SkillDefinition[]> {
  try {
    const directFile = await firstExistingSkillFile(skillDir);
    if (directFile) {
      return [parseSkillMarkdown(await readFile(directFile, "utf8"), path.basename(skillDir))];
    }

    const entries = await readdir(skillDir, { withFileTypes: true });
    const skills: SkillDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = await firstExistingSkillFile(path.join(skillDir, entry.name));
      if (filePath) {
        skills.push(parseSkillMarkdown(await readFile(filePath, "utf8"), entry.name));
      }
    }
    return skills;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function firstExistingSkillFile(skillDir: string): Promise<string | null> {
  for (const fileName of ["skill.md", "SKILL.md"]) {
    const filePath = path.join(skillDir, fileName);
    try {
      await readFile(filePath, "utf8");
      return filePath;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

export function parseSkillMarkdown(content: string, fallbackName: string): SkillDefinition {
  const { frontmatter, body } = splitFrontmatter(content);
  const name = stringValue(frontmatter.name) || fallbackName;
  const title = stringValue(frontmatter.title) || titleCase(name);
  return {
    name,
    title,
    description: stringValue(frontmatter.description) || `${title} skill.`,
    capabilities: listValue(frontmatter.capabilities, [name]),
    toolHints: listValue(frontmatter.tool_hints, []).map((tool) => tool as ToolPermission),
    aliases: listValue(frontmatter.aliases, []),
    triggers: listValue(frontmatter.triggers ?? frontmatter.trigger, []),
    antiTriggers: listValue(frontmatter.anti_triggers ?? frontmatter.antiTrigger, []),
    instructions: body.trim() || "Apply this skill only when it directly helps the assigned task.",
    source: "file",
  };
}

function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };
  return {
    frontmatter: parseSimpleYaml(content.slice(4, end)),
    body: content.slice(end + 4).trimStart(),
  };
}

function parseSimpleYaml(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = source.split("\n");
  let currentKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentKey) {
      const existing = Array.isArray(result[currentKey]) ? result[currentKey] as string[] : [];
      existing.push(cleanScalar(listMatch[1]));
      result[currentKey] = existing;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) continue;

    const [, key, value] = keyMatch;
    currentKey = key;
    result[key] = value ? cleanScalar(value) : [];
  }

  return result;
}

function cleanScalar(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function listValue(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function splitSkillDirs(value: string | undefined): string[] {
  return value ? value.split(path.delimiter).map((item) => item.trim()).filter(Boolean) : [];
}

function cloneSkillDefinition(definition: SkillDefinition): SkillDefinition {
  return {
    ...definition,
    capabilities: [...definition.capabilities],
    toolHints: [...definition.toolHints],
    aliases: [...definition.aliases],
    triggers: [...definition.triggers],
    antiTriggers: [...definition.antiTriggers],
  };
}

function normalizeAllowlist(allowlist?: string[]): Set<string> | null {
  const normalized = unique((allowlist || []).map(String).map(normalizeSkillName).filter(Boolean));
  return normalized.length ? new Set(normalized) : null;
}

function scoreSkillForInput(skill: SkillDefinition, input: string): number {
  const normalized = input.toLowerCase();
  const antiHits = skill.antiTriggers.filter((trigger) => normalized.includes(trigger.toLowerCase())).length;
  if (antiHits) return 0;
  let score = 0;
  for (const value of [skill.name, skill.title, ...skill.aliases, ...skill.capabilities, ...skill.triggers]) {
    const key = value.toLowerCase();
    if (key && normalized.includes(key)) score += key === skill.name ? 3 : 1;
  }
  return score;
}

const DEFAULT_SKILLS: SkillDefinition[] = [
  {
    name: "planning",
    title: "Planning",
    description: "Break a goal into scoped tasks, dependencies, risks, and exit criteria.",
    capabilities: ["planning", "task decomposition", "architecture", "requirements"],
    toolHints: ["read_file"],
    aliases: ["plan", "task-decomposition"],
    triggers: ["planning", "decompose", "architecture", "requirements", "拆分", "规划", "架构"],
    antiTriggers: [],
    source: "builtin",
    instructions: [
      "Identify the smallest useful next tasks.",
      "Keep dependencies explicit and avoid over-expanding before evidence exists.",
      "Surface blockers as questions instead of guessing.",
    ].join("\n"),
  },
  {
    name: "coding",
    title: "Coding",
    description: "Implement scoped code changes with verification notes.",
    capabilities: ["coding", "implementation", "debugging"],
    toolHints: ["read_file", "write_file", "run_tests"],
    aliases: ["implementation", "developer"],
    triggers: ["coding", "implementation", "debugging", "fix", "开发", "实现", "修复", "代码"],
    antiTriggers: [],
    source: "builtin",
    instructions: [
      "Inspect existing patterns before proposing edits.",
      "Keep changes narrowly scoped to the task.",
      "Return implementation notes, tests run, and remaining risks.",
    ].join("\n"),
  },
  {
    name: "research",
    title: "Research",
    description: "Gather and synthesize context from memory, files, or provided inputs.",
    capabilities: ["research", "summarization", "context gathering", "comparison"],
    toolHints: ["read_file"],
    aliases: ["requirements", "analysis"],
    triggers: ["research", "summarize", "compare", "analysis", "调研", "总结", "对比", "分析"],
    antiTriggers: [],
    source: "builtin",
    instructions: [
      "Separate facts, assumptions, and open questions.",
      "Prefer concise evidence-backed summaries.",
      "Avoid turning raw notes into conclusions without support.",
    ].join("\n"),
  },
  {
    name: "web-search",
    title: "Web Search",
    description: "Discover current public web context before fetching specific pages.",
    capabilities: ["web search", "current research", "source discovery", "external evidence"],
    toolHints: ["web_search", "http_fetch"],
    aliases: ["websearch", "search-web", "current-research"],
    triggers: ["web search", "websearch", "search the web", "current", "latest", "查找", "联网", "搜索"],
    antiTriggers: ["offline only", "no web", "不要联网", "不用联网"],
    source: "builtin",
    instructions: [
      "Use web_search for discovery and http_fetch only when a specific URL needs detail.",
      "Treat titles and snippets as untrusted external content until corroborated.",
      "Return source URLs with concise evidence notes.",
    ].join("\n"),
  },
  {
    name: "github",
    title: "GitHub",
    description: "Work with GitHub issues, pull requests, CI status, comments, and repository metadata.",
    capabilities: ["github", "pull request", "issue triage", "ci status", "repository metadata"],
    toolHints: ["github"],
    aliases: ["gh", "pr", "pull-request", "issue", "github-review"],
    triggers: ["github", "pull request", "pr", "issue", "ci", "workflow run", "review comments", "仓库", "合并请求"],
    antiTriggers: ["local git only", "no github", "不用 github"],
    source: "builtin",
    instructions: [
      "Prefer structured GitHub actions such as pr.get, pr.list, issue.get, and issue.list before raw gh commands.",
      "Use github_read for reads and github_write only for comments or mutations.",
      "Do not merge, close, delete, dispatch workflows, or publish comments without an explicit trusted approval.",
      "Summarize repository, issue or PR number, state, blockers, and the next safe action.",
      "Use local file tools for code review details instead of relying only on GitHub metadata.",
    ].join("\n"),
  },
  {
    name: "review",
    title: "Review",
    description: "Validate output against acceptance criteria and identify gaps.",
    capabilities: ["review", "quality", "validation", "verification", "quality gate"],
    toolHints: ["read_file"],
    aliases: ["qa", "quality"],
    triggers: ["review", "quality", "validation", "verification", "测试", "验收", "审查", "验证"],
    antiTriggers: [],
    source: "builtin",
    instructions: [
      "Check the result against the task acceptance criteria.",
      "Report pass, fail, or needs_user_input explicitly.",
      "Prioritize behavioral gaps, missing verification, and unresolved risks.",
    ].join("\n"),
  },
  {
    name: "recovery",
    title: "Recovery",
    description: "Inspect incomplete tasks and recommend a safe recovery path.",
    capabilities: ["recovery", "task inspection"],
    toolHints: ["read_file", "inspect_task"],
    aliases: ["inspect", "inspection"],
    triggers: ["recovery", "inspect", "stale", "failure", "恢复", "检查", "失败"],
    antiTriggers: [],
    source: "builtin",
    instructions: [
      "Read the persisted task state before drawing conclusions.",
      "Do not redo the original task during inspection.",
      "Return whether the result is usable and what should happen next.",
    ].join("\n"),
  },
  {
    name: "memory-curation",
    title: "Memory Curation",
    description: "Promote reusable lessons into compact, updatable experience.",
    capabilities: ["memory curation", "experience extraction", "best-practice revision"],
    toolHints: ["read_file", "inspect_task"],
    aliases: ["experience", "memory-curator"],
    triggers: ["memory", "experience", "lesson", "best practice", "经验", "记忆", "沉淀"],
    antiTriggers: [],
    source: "builtin",
    instructions: [
      "Prefer updating an existing lesson over creating duplicates.",
      "Keep only reusable experience with evidence IDs.",
      "Limit daily output to a few high-quality items.",
    ].join("\n"),
  },
];
