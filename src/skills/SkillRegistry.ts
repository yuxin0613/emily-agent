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
    includeBuiltIns = true,
  }: {
    skillDir?: string;
    includeBuiltIns?: boolean;
  } = {}): Promise<SkillRegistry> {
    const registry = new SkillRegistry(includeBuiltIns ? DEFAULT_SKILLS : []);
    for (const skill of await readSkillDirectory(skillDir)) {
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

  resolveHints(hints: string[]): SkillHintResolution {
    const requested = unique(hints.map(String).map((hint) => hint.trim()).filter(Boolean));
    const matched: SkillDefinition[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();

    for (const hint of requested) {
      const matches = this.resolveAll(hint);
      if (!matches.length) {
        unknown.push(hint);
        continue;
      }
      for (const match of matches) {
        if (seen.has(match.name)) continue;
        seen.add(match.name);
        matched.push(match);
      }
    }

    return { requested, matched, unknown };
  }

  renderSkillContext(resolution: SkillHintResolution): string[] {
    const lines: string[] = [];
    for (const skill of resolution.matched) {
      lines.push([
        `## ${skill.title} (${skill.name})`,
        skill.description,
        skill.toolHints.length ? `Tool hints: ${skill.toolHints.join(", ")}` : "Tool hints: (none)",
        skill.instructions.trim(),
      ].join("\n"));
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

async function readSkillDirectory(skillDir: string): Promise<SkillDefinition[]> {
  try {
    const entries = await readdir(skillDir, { withFileTypes: true });
    const skills: SkillDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(skillDir, entry.name, "skill.md");
      try {
        skills.push(parseSkillMarkdown(await readFile(filePath, "utf8"), entry.name));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
    return skills;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
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

function cloneSkillDefinition(definition: SkillDefinition): SkillDefinition {
  return {
    ...definition,
    capabilities: [...definition.capabilities],
    toolHints: [...definition.toolHints],
    aliases: [...definition.aliases],
  };
}

const DEFAULT_SKILLS: SkillDefinition[] = [
  {
    name: "planning",
    title: "Planning",
    description: "Break a goal into scoped tasks, dependencies, risks, and exit criteria.",
    capabilities: ["planning", "task decomposition", "architecture", "requirements"],
    toolHints: ["read_file"],
    aliases: ["plan", "task-decomposition"],
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
    source: "builtin",
    instructions: [
      "Separate facts, assumptions, and open questions.",
      "Prefer concise evidence-backed summaries.",
      "Avoid turning raw notes into conclusions without support.",
    ].join("\n"),
  },
  {
    name: "review",
    title: "Review",
    description: "Validate output against acceptance criteria and identify gaps.",
    capabilities: ["review", "quality", "validation", "verification", "quality gate"],
    toolHints: ["read_file"],
    aliases: ["qa", "quality"],
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
    source: "builtin",
    instructions: [
      "Prefer updating an existing lesson over creating duplicates.",
      "Keep only reusable experience with evidence IDs.",
      "Limit daily output to a few high-quality items.",
    ].join("\n"),
  },
];
