import type { PermissionMode, RoleDefinition, ToolDefinition, ToolHintResolution, ToolPermission } from "../types.ts";
import { filterToolsByPermissionMode, permissionModeToolList } from "./PermissionMode.ts";
import { createDefaultToolRegistry, ToolRegistry } from "./ToolRegistry.ts";

export class ToolGateway {
  role: string;
  allowedTools: Set<ToolPermission>;
  forbiddenTools: Set<ToolPermission>;
  registry: ToolRegistry;
  permissionMode: PermissionMode;

  constructor(
    definition: RoleDefinition,
    { registry = createDefaultToolRegistry(), permissionMode = "workspace_write" }: { registry?: ToolRegistry; permissionMode?: PermissionMode } = {},
  ) {
    this.role = definition.role;
    this.permissionMode = permissionMode;
    this.allowedTools = new Set(filterToolsByPermissionMode(definition.allowedTools, permissionMode));
    this.forbiddenTools = new Set(definition.forbiddenTools);
    this.registry = registry;
  }

  assertAllowed(tool: ToolPermission | string): ToolDefinition {
    const definition = this.registry.resolve(tool);
    const toolName = definition?.name || String(tool);
    if (!definition || this.forbiddenTools.has(definition.permission) || !this.allowedTools.has(definition.permission)) {
      throw new Error(`Tool "${toolName}" is not allowed for role "${this.role}"`);
    }
    return definition;
  }

  canUse(tool: ToolPermission | string): boolean {
    const definition = this.registry.resolve(tool);
    return Boolean(definition && this.allowedTools.has(definition.permission) && !this.forbiddenTools.has(definition.permission));
  }

  listAllowed(): ToolPermission[] {
    return this.listAllowedDefinitions().map((tool) => tool.name);
  }

  listAllowedDefinitions(): ToolDefinition[] {
    return this.registry.list().filter((tool) => this.canUse(tool.name));
  }

  resolveHints(hints: string[]): ToolHintResolution {
    const requested = unique(hints.map(String).map((hint) => hint.trim()).filter(Boolean));
    const allowed: ToolDefinition[] = [];
    const denied: string[] = [];
    const unknown: string[] = [];
    const seenAllowed = new Set<string>();
    const seenDenied = new Set<string>();

    for (const hint of requested) {
      const definition = this.registry.resolve(hint);
      if (!definition) {
        unknown.push(hint);
        continue;
      }
      if (this.canUse(definition.name)) {
        if (!seenAllowed.has(definition.name)) {
          seenAllowed.add(definition.name);
          allowed.push(definition);
        }
        continue;
      }
      if (!seenDenied.has(definition.name)) {
        seenDenied.add(definition.name);
        denied.push(definition.name);
      }
    }

    return { requested, allowed, denied, unknown, permissionMode: this.permissionMode };
  }

  renderToolContext(resolution: ToolHintResolution): string[] {
    const relevant = resolution.allowed.length ? resolution.allowed : this.listAllowedDefinitions();
    const modeTools = permissionModeToolList(this.permissionMode);
    const lines = [
      `Permission mode: ${this.permissionMode}`,
      `Permission mode tools: ${Array.isArray(modeTools) ? modeTools.join(", ") : "role_defined"}`,
    ];
    lines.push(...relevant.map((tool) => [
      `- ${tool.name}: ${tool.description}`,
      `  category=${tool.category}; sideEffects=${tool.sideEffects}; approval=${tool.requiresApproval ? "required" : "not_required"}`,
      `  ${tool.instructions}`,
    ].join("\n")));

    if (resolution.denied.length) {
      lines.push(`Denied tool hints: ${resolution.denied.join(", ")}`);
    }
    if (resolution.unknown.length) {
      lines.push(`Unknown tool hints: ${resolution.unknown.join(", ")}`);
    }

    return lines.length ? lines : ["(none)"];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
