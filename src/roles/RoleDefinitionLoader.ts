import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RoleDefinition, ToolPermission } from "../types.ts";

const DEFAULT_TOOLS: ToolPermission[] = ["read_file"];

export async function readRoleDefinition(role: string): Promise<RoleDefinition> {
  const fallback: RoleDefinition = {
    role: `Generic ${role} agent`,
    singleton: true,
    allowedTools: DEFAULT_TOOLS,
    forbiddenTools: [],
    maxConcurrentTasks: 1,
    capabilities: [role],
    instructions: "Follow the task requirements and return a concise result.",
  };

  try {
    const filePath = path.join(process.cwd(), "agents", role, "agent.md");
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
    role: stringValue(frontmatter.role) || legacyRole || fallback.role,
    singleton: booleanValue(frontmatter.singleton, fallback.singleton),
    allowedTools: listValue(frontmatter.allowed_tools, fallback.allowedTools) as ToolPermission[],
    forbiddenTools: listValue(frontmatter.forbidden_tools, fallback.forbiddenTools) as ToolPermission[],
    maxConcurrentTasks: numberValue(frontmatter.max_concurrent_tasks, fallback.maxConcurrentTasks),
    capabilities: listValue(frontmatter.capabilities, legacyCapabilities
      ? legacyCapabilities.split(",").map((item) => item.trim()).filter(Boolean)
      : fallback.capabilities),
    instructions: body.trim() || fallback.instructions,
  };
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

function listValue(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return fallback;
}
