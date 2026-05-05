import type { PermissionMode, ToolPermission } from "../types.ts";

const READ_ONLY_TOOLS = new Set<ToolPermission>(["read_file", "inspect_task"]);
const WORKSPACE_WRITE_TOOLS = new Set<ToolPermission>([
  "read_file",
  "write_file",
  "run_tests",
  "create_task",
  "inspect_task",
  "http_fetch",
  "web_search",
  "browser",
]);

export function parsePermissionMode(value: unknown, fallback: PermissionMode = "workspace_write"): PermissionMode {
  if (value === "read_only" || value === "workspace_write" || value === "danger_full_access") return value;
  return fallback;
}

export function clampPermissionMode(requested: unknown, inherited: unknown = "workspace_write"): PermissionMode {
  const inheritedMode = parsePermissionMode(inherited);
  const requestedMode = parsePermissionMode(requested, inheritedMode);
  return permissionRank(requestedMode) <= permissionRank(inheritedMode) ? requestedMode : inheritedMode;
}

export function permissionModeAllows(mode: PermissionMode, tool: ToolPermission): boolean {
  if (mode === "danger_full_access") return true;
  if (mode === "workspace_write") return WORKSPACE_WRITE_TOOLS.has(tool);
  return READ_ONLY_TOOLS.has(tool);
}

export function filterToolsByPermissionMode(tools: ToolPermission[], mode: PermissionMode): ToolPermission[] {
  return tools.filter((tool) => permissionModeAllows(mode, tool));
}

export function permissionModeToolList(mode: PermissionMode): ToolPermission[] | "role_defined" {
  if (mode === "danger_full_access") return "role_defined";
  return mode === "workspace_write" ? [...WORKSPACE_WRITE_TOOLS] : [...READ_ONLY_TOOLS];
}

function permissionRank(mode: PermissionMode): number {
  if (mode === "danger_full_access") return 2;
  if (mode === "workspace_write") return 1;
  return 0;
}
