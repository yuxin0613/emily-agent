import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RoleDefinition, ToolPermission } from "../types.ts";

const DEFAULT_TOOLS: ToolPermission[] = ["read_file"];

export async function readRoleDefinition(role: string, { roleDir = defaultRoleDir() }: { roleDir?: string } = {}): Promise<RoleDefinition> {
  const fallback: RoleDefinition = {
    name: role,
    role: `Generic ${role} agent`,
    singleton: true,
    provider: undefined,
    model: undefined,
    temperature: undefined,
    allowedTools: DEFAULT_TOOLS,
    forbiddenTools: [],
    maxConcurrentTasks: 1,
    capabilities: [role],
    skills: [],
    skillAllowlist: [],
    outputContract: undefined,
    instructions: "Follow the task requirements and return a concise result.",
  };

  try {
    const filePath = roleDefinitionPath(role, roleDir);
    const content = await readFile(filePath, "utf8");
    return parseAgentMarkdown(content, fallback);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function parseAgentMarkdown(content: string, fallback: RoleDefinition): RoleDefinition {
  const { frontmatter, body } = splitFrontmatter(content);
  const legacyRole = body.match(/^Role:\s*(.+)$/m)?.[1]?.trim();
  const legacyCapabilities = body.match(/^Capabilities:\s*(.+)$/m)?.[1];

  return {
    name: stringValue(frontmatter.name) || fallback.name,
    role: stringValue(frontmatter.role) || legacyRole || fallback.role,
    singleton: booleanValue(frontmatter.singleton, fallback.singleton),
    provider: stringValue(frontmatter.provider) || fallback.provider,
    model: stringValue(frontmatter.model) || fallback.model,
    temperature: numberOrUndefined(frontmatter.temperature, fallback.temperature),
    allowedTools: listValue(frontmatter.allowed_tools, fallback.allowedTools) as ToolPermission[],
    forbiddenTools: listValue(frontmatter.forbidden_tools, fallback.forbiddenTools) as ToolPermission[],
    maxConcurrentTasks: numberValue(frontmatter.max_concurrent_tasks, fallback.maxConcurrentTasks),
    capabilities: listValue(frontmatter.capabilities, legacyCapabilities
      ? legacyCapabilities.split(",").map((item) => item.trim()).filter(Boolean)
      : fallback.capabilities),
    skills: listValue(frontmatter.skills, fallback.skills),
    skillAllowlist: listValue(frontmatter.skill_allowlist, fallback.skillAllowlist || []),
    outputContract: stringValue(frontmatter.output_contract) || fallback.outputContract,
    instructions: body.trim() || fallback.instructions,
  };
}

export async function listRoleNames({ roleDir = defaultRoleDir() }: { roleDir?: string } = {}): Promise<string[]> {
  try {
    const entries = await readdir(roleDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeRoleDefinition(
  name: string,
  definition: Partial<RoleDefinition> & { instructions: string },
  { roleDir = defaultRoleDir() }: { roleDir?: string } = {},
): Promise<string> {
  const targetDir = path.join(roleDir, name);
  await mkdir(targetDir, { recursive: true });
  const fullDefinition: RoleDefinition = {
    name,
    role: definition.role || `Generic ${name} agent`,
    singleton: definition.singleton ?? true,
    provider: definition.provider,
    model: definition.model,
    temperature: definition.temperature,
    allowedTools: definition.allowedTools || DEFAULT_TOOLS,
    forbiddenTools: definition.forbiddenTools || [],
    maxConcurrentTasks: definition.maxConcurrentTasks || 1,
    capabilities: definition.capabilities || [name],
    skills: definition.skills || [],
    skillAllowlist: definition.skillAllowlist || [],
    outputContract: definition.outputContract,
    instructions: definition.instructions,
  };
  const filePath = roleDefinitionPath(name, roleDir);
  await writeFile(filePath, renderAgentMarkdown(fullDefinition), "utf8");
  return filePath;
}

export function roleDefinitionPath(role: string, roleDir = defaultRoleDir()): string {
  return path.join(roleDir, role, "agent.md");
}

export function defaultRoleDir(): string {
  return process.env.EMILY_ROLE_DIR || path.join(process.cwd(), "agents");
}

function splitFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content };
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }

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

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return fallback;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function numberOrUndefined(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function listValue(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function renderAgentMarkdown(definition: RoleDefinition): string {
  const frontmatter = [
    "---",
    `name: "${definition.name}"`,
    `role: "${definition.role}"`,
    `singleton: ${definition.singleton}`,
    definition.provider ? `provider: "${definition.provider}"` : null,
    definition.model ? `model: "${definition.model}"` : null,
    typeof definition.temperature === "number" ? `temperature: ${definition.temperature}` : null,
    "allowed_tools:",
    ...definition.allowedTools.map((tool) => `  - ${tool}`),
    "forbidden_tools:",
    ...definition.forbiddenTools.map((tool) => `  - ${tool}`),
    `max_concurrent_tasks: ${definition.maxConcurrentTasks}`,
    "capabilities:",
    ...definition.capabilities.map((capability) => `  - ${capability}`),
    "skills:",
    ...definition.skills.map((skill) => `  - ${skill}`),
    definition.skillAllowlist?.length ? "skill_allowlist:" : null,
    ...(definition.skillAllowlist || []).map((skill) => `  - ${skill}`),
    definition.outputContract ? `output_contract: "${definition.outputContract}"` : null,
    "---",
  ].filter((line): line is string => Boolean(line));

  return [
    frontmatter.join("\n"),
    "",
    `# ${titleCase(definition.name)} Agent`,
    "",
    definition.instructions.trim(),
    "",
  ].join("\n");
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}
