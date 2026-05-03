import type { RoleDefinition, ToolPermission } from "../types.ts";

export class ToolGateway {
  role: string;
  allowedTools: Set<ToolPermission>;
  forbiddenTools: Set<ToolPermission>;

  constructor(definition: RoleDefinition) {
    this.role = definition.role;
    this.allowedTools = new Set(definition.allowedTools);
    this.forbiddenTools = new Set(definition.forbiddenTools);
  }

  assertAllowed(tool: ToolPermission): void {
    if (this.forbiddenTools.has(tool) || !this.allowedTools.has(tool)) {
      throw new Error(`Tool "${tool}" is not allowed for role "${this.role}"`);
    }
  }

  canUse(tool: ToolPermission): boolean {
    return this.allowedTools.has(tool) && !this.forbiddenTools.has(tool);
  }

  listAllowed(): ToolPermission[] {
    return [...this.allowedTools].filter((tool) => !this.forbiddenTools.has(tool));
  }
}
