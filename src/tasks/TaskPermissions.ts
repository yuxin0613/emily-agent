import type { Metadata, PermissionMode } from "../types.ts";
import { clampPermissionMode, parsePermissionMode } from "../tools/PermissionMode.ts";

export interface GraphTaskPermissionInput {
  role: string;
  title: string;
  input: string;
  acceptanceCriteria?: unknown;
  toolHints?: unknown;
  metadata?: Metadata;
}

export function graphTaskPermissionMode(
  task: GraphTaskPermissionInput,
  requested: unknown,
  inherited: unknown,
): PermissionMode {
  const inheritedMode = parsePermissionMode(inherited);
  const clamped = clampPermissionMode(requested, inheritedMode);
  if (inheritedMode === "read_only") return clamped;
  if (clamped === "read_only" && needsWorkspaceWrite(task)) return "workspace_write";
  return clamped;
}

export function needsWorkspaceWrite(task: GraphTaskPermissionInput): boolean {
  if (task.role !== "developer") return false;
  const toolHints = readStringArray(task.toolHints);
  if (toolHints.includes("write_file")) return true;
  const requiredFiles = readStringArray(task.metadata?.requiredFiles);
  if (requiredFiles.length) return true;
  const text = [
    task.title,
    task.input,
    readStringArray(task.acceptanceCriteria).join("\n"),
    readStringArray(task.metadata?.acceptanceCriteria).join("\n"),
    requiredFiles.join("\n"),
  ].join("\n");
  if (/(?:^|[\s`'"])(?:~\/|\/|\.{1,2}\/)?[A-Za-z0-9_./-]+\.(?:html|css|js|jsx|ts|tsx|json|md|txt)(?:[:\s`'",)]|$)/i.test(text)) return true;
  return /(?:保存|保存到|输出到|写入|落盘|生成|编写|写一个|写代码|创建|新建|修改|更新|编辑).{0,40}(?:文件|代码|源码|网页|页面|HTML|html|index|artifact|file|code|source)/i.test(text)
    || /(?:write|wire up|create|generate|edit|update|scaffold).{0,40}(?:file|code|source|html|page|artifact|module)/i.test(text);
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}
