import type { ToolDefinition, ToolPermission } from "../types.ts";

export class ToolRegistry {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly aliases: Map<string, string>;

  constructor(definitions: ToolDefinition[] = DEFAULT_TOOL_DEFINITIONS) {
    this.tools = new Map();
    this.aliases = new Map();
    for (const definition of definitions) {
      this.add(definition);
    }
  }

  add(definition: ToolDefinition): void {
    this.tools.set(normalizeToolName(definition.name), cloneToolDefinition(definition));
    for (const alias of definition.aliases) {
      this.aliases.set(normalizeToolName(alias), definition.name);
    }
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map(cloneToolDefinition).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ToolDefinition | null {
    const resolved = this.resolve(name);
    return resolved ? cloneToolDefinition(resolved) : null;
  }

  resolve(name: string): ToolDefinition | null {
    const key = normalizeToolName(name);
    const canonical = this.aliases.get(key) || key;
    return this.tools.get(canonical) || null;
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(DEFAULT_TOOL_DEFINITIONS);
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_");
}

function cloneToolDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    ...definition,
    aliases: [...definition.aliases],
  };
}

const DEFAULT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    permission: "read_file",
    category: "filesystem",
    sideEffects: "read",
    requiresApproval: false,
    aliases: ["read", "cat", "open_file"],
    description: "Read local workspace files or task artifacts.",
    instructions: "Use only for reading context needed by the assigned task.",
  },
  {
    name: "write_file",
    permission: "write_file",
    category: "filesystem",
    sideEffects: "write",
    requiresApproval: false,
    aliases: ["edit_file", "patch_file"],
    description: "Create or edit files inside the workspace.",
    instructions: "Keep edits scoped to the assigned task and preserve unrelated user changes.",
  },
  {
    name: "run_tests",
    permission: "run_tests",
    category: "process",
    sideEffects: "execute",
    requiresApproval: false,
    aliases: ["test", "tests", "check"],
    description: "Run project verification commands.",
    instructions: "Prefer the repository's existing test or check scripts and report failures clearly.",
  },
  {
    name: "shell",
    permission: "shell",
    category: "process",
    sideEffects: "execute",
    requiresApproval: true,
    aliases: ["terminal", "exec"],
    description: "Run shell commands.",
    instructions: "Use only when a narrower tool cannot do the work.",
  },
  {
    name: "network",
    permission: "network",
    category: "network",
    sideEffects: "network",
    requiresApproval: true,
    aliases: ["web", "http", "fetch"],
    description: "Access external network resources.",
    instructions: "Use only when current external information is required.",
  },
  {
    name: "http_fetch",
    permission: "http_fetch",
    category: "network",
    sideEffects: "network",
    requiresApproval: true,
    aliases: ["fetch", "http_get", "http_request"],
    description: "Fetch HTTP or HTTPS resources with bounded body size.",
    instructions: "Use for explicit URL retrieval after approval; prefer GET or HEAD and keep responses small.",
  },
  {
    name: "browser",
    permission: "browser",
    category: "network",
    sideEffects: "network",
    requiresApproval: true,
    aliases: ["open_url", "browser_open", "browser_snapshot"],
    description: "Take a lightweight page snapshot for a URL.",
    instructions: "Use only after approval when page title or rendered HTML context is needed.",
  },
  {
    name: "github",
    permission: "github",
    category: "vcs",
    sideEffects: "network",
    requiresApproval: true,
    aliases: ["gh", "github_cli"],
    description: "Run approved GitHub CLI read or workflow commands.",
    instructions: "Use only after approval with a narrow gh subcommand and no shell interpolation.",
  },
  {
    name: "create_task",
    permission: "create_task",
    category: "task",
    sideEffects: "write",
    requiresApproval: false,
    aliases: ["delegate", "spawn_task"],
    description: "Create follow-up tasks in the runtime task graph.",
    instructions: "Create tasks only when they are necessary to satisfy the run exit criteria.",
  },
  {
    name: "inspect_task",
    permission: "inspect_task",
    category: "task",
    sideEffects: "read",
    requiresApproval: false,
    aliases: ["task_trace", "task_status"],
    description: "Inspect task state, result, errors, and trace.",
    instructions: "Use for recovery, review, or dependency diagnosis.",
  },
  {
    name: "git_reset",
    permission: "git_reset",
    category: "vcs",
    sideEffects: "destructive",
    requiresApproval: true,
    aliases: ["reset_hard", "checkout_discard"],
    description: "Discard or reset repository state.",
    instructions: "Treat as destructive and require explicit user approval.",
  },
  {
    name: "delete_file",
    permission: "delete_file",
    category: "filesystem",
    sideEffects: "destructive",
    requiresApproval: true,
    aliases: ["remove_file", "rm"],
    description: "Delete files from the workspace.",
    instructions: "Use only with explicit task need and approval.",
  },
];
