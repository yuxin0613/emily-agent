import type { RoleDefinition } from "../types.ts";
import type { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import { listRoleNames, readRoleDefinition, writeRoleDefinition } from "./RoleDefinitionLoader.ts";

export class RoleManager {
  roleDir: string;
  providerRegistry: ProviderRegistry | null;

  constructor({ roleDir, providerRegistry = null }: { roleDir: string; providerRegistry?: ProviderRegistry | null }) {
    this.roleDir = roleDir;
    this.providerRegistry = providerRegistry;
  }

  async listRoles(): Promise<RoleDefinition[]> {
    const names = await listRoleNames({ roleDir: this.roleDir });
    return Promise.all(names.map((name) => readRoleDefinition(name, { roleDir: this.roleDir })));
  }

  async getRole(name: string): Promise<RoleDefinition> {
    return readRoleDefinition(name, { roleDir: this.roleDir });
  }

  async addRole(input: {
    name: string;
    role: string;
    provider?: string;
    model?: string;
    temperature?: number;
    allowedTools?: RoleDefinition["allowedTools"];
    forbiddenTools?: RoleDefinition["forbiddenTools"];
    maxConcurrentTasks?: number;
    capabilities?: string[];
    skills?: string[];
    skillAllowlist?: string[];
    outputContract?: string;
    instructions: string;
  }): Promise<RoleDefinition> {
    this.validateRoleInput(input);
    await writeRoleDefinition(input.name, {
      name: input.name,
      role: input.role,
      provider: input.provider,
      model: input.model,
      temperature: input.temperature,
      allowedTools: input.allowedTools,
      forbiddenTools: input.forbiddenTools,
      maxConcurrentTasks: input.maxConcurrentTasks,
      capabilities: input.capabilities,
      skills: input.skills,
      skillAllowlist: input.skillAllowlist,
      outputContract: input.outputContract,
      instructions: input.instructions,
    }, { roleDir: this.roleDir });
    return this.getRole(input.name);
  }

  async updateRoleProvider(name: string, {
    provider,
    model,
    temperature,
  }: {
    provider?: string;
    model?: string;
    temperature?: number;
  }): Promise<RoleDefinition> {
    const current = await this.getRole(name);
    const next = {
      ...current,
      ...(provider !== undefined ? { provider } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };
    this.validateProviderBinding({
      provider: next.provider,
      model: next.model,
      temperature: next.temperature,
    });
    await writeRoleDefinition(name, {
      ...next,
    }, { roleDir: this.roleDir });
    return this.getRole(name);
  }

  async initializeDefaultRoles({ overwrite = false }: { overwrite?: boolean } = {}): Promise<RoleDefinition[]> {
    const existing = new Set(await listRoleNames({ roleDir: this.roleDir }));
    const created: RoleDefinition[] = [];
    for (const preset of DEFAULT_ROLE_PRESETS) {
      const rolePreset = this.withDefaultProvider(preset);
      if (!overwrite && existing.has(preset.name)) {
        created.push(await this.getRole(preset.name));
        continue;
      }
      created.push(await this.addRole(rolePreset));
    }
    return created;
  }

  private validateRoleInput(input: {
    name: string;
    role: string;
    provider?: string;
    model?: string;
    temperature?: number;
    allowedTools?: RoleDefinition["allowedTools"];
    forbiddenTools?: RoleDefinition["forbiddenTools"];
    capabilities?: string[];
    skills?: string[];
    skillAllowlist?: string[];
    outputContract?: string;
    instructions: string;
  }): void {
    if (!/^[A-Za-z0-9._-]+$/.test(input.name || "")) {
      throw new Error("Role name must be non-empty and contain only letters, numbers, dot, underscore, or dash.");
    }
    if (!input.instructions?.trim()) {
      throw new Error("Role instructions must be non-empty.");
    }
    if (!input.role?.trim()) {
      throw new Error("Role description must be non-empty.");
    }
    if (input.outputContract !== undefined && !input.outputContract.trim()) {
      throw new Error("Role outputContract must be non-empty when provided.");
    }
    this.validateProviderBinding(input);
    const allowed = new Set(input.allowedTools || []);
    for (const tool of input.forbiddenTools || []) {
      if (allowed.has(tool)) throw new Error(`Tool cannot be both allowed and forbidden: ${tool}`);
    }
    for (const skill of input.skills || []) {
      if (!/^[A-Za-z0-9._-]+$/.test(skill)) {
        throw new Error(`Skill name must contain only letters, numbers, dot, underscore, or dash: ${skill}`);
      }
    }
    for (const skill of input.skillAllowlist || []) {
      if (!/^[A-Za-z0-9._-]+$/.test(skill)) {
        throw new Error(`Skill allowlist entry must contain only letters, numbers, dot, underscore, or dash: ${skill}`);
      }
    }
  }

  private validateProviderBinding(input: { provider?: string; model?: string; temperature?: number }): void {
    if (input.provider) {
      this.providerRegistry?.getConfig(input.provider);
    }
    if (input.model !== undefined && !input.model.trim()) {
      throw new Error("Role model must be non-empty when provided.");
    }
    if (input.temperature !== undefined && (input.temperature < 0 || input.temperature > 2)) {
      throw new Error("Role temperature must be between 0 and 2.");
    }
  }

  private withDefaultProvider(input: Parameters<RoleManager["addRole"]>[0]): Parameters<RoleManager["addRole"]>[0] {
    if (!this.providerRegistry) return input;
    if (input.provider && !this.providerRegistry.list().some((provider) => provider.id === input.provider)) {
      return {
        ...input,
        provider: this.providerRegistry.defaultProviderId,
      };
    }
    return input;
  }
}

const DEFAULT_ROLE_PRESETS: Array<Parameters<RoleManager["addRole"]>[0]> = [
  {
    name: "planner",
    role: "Break user goals into concrete execution steps.",
    temperature: 0.1,
    allowedTools: ["read_file"],
    forbiddenTools: ["write_file", "shell", "network"],
    capabilities: ["planning", "task decomposition", "risk spotting"],
    skills: ["planning"],
    instructions: [
      "## Workflow",
      "1. Read the task input and any provided memory.",
      "2. Identify the smallest useful next steps.",
      "3. Call out blockers or missing context.",
      "4. Return a concise plan that the main agent can summarize.",
      "",
      "## Limits",
      "- Do not modify files.",
      "- Do not execute tools.",
    ].join("\n"),
  },
  {
    name: "developer",
    role: "Solve implementation tasks and produce technical next actions.",
    temperature: 0.2,
    allowedTools: ["read_file", "write_file", "run_tests"],
    forbiddenTools: ["git_reset", "delete_file"],
    capabilities: ["coding", "debugging", "architecture"],
    skills: ["coding"],
    instructions: "Implement the assigned task carefully, keep edits scoped, and return important verification steps.",
  },
  {
    name: "researcher",
    role: "Collect and organize context from available memory and local inputs.",
    temperature: 0.2,
    allowedTools: ["read_file"],
    forbiddenTools: ["write_file", "shell"],
    capabilities: ["summarization", "context gathering", "comparison"],
    skills: ["research"],
    instructions: "Gather relevant context, separate facts from assumptions, and return a concise research summary.",
  },
  {
    name: "reviewer",
    role: "Review subagent outputs before the main agent summarizes them.",
    temperature: 0,
    allowedTools: ["read_file"],
    forbiddenTools: ["write_file", "shell", "network"],
    capabilities: ["validation", "result review", "quality gate"],
    skills: ["review"],
    instructions: "Review the result against the user request and return pass/fail/needs_user_input guidance.",
  },
  {
    name: "inspector",
    role: "Inspect incomplete or suspicious tasks after worker failure.",
    temperature: 0,
    allowedTools: ["read_file", "inspect_task"],
    forbiddenTools: ["write_file", "shell", "network"],
    capabilities: ["recovery", "verification", "task inspection"],
    skills: ["recovery"],
    instructions: "Inspect task state and report whether the target task has a usable persisted result.",
  },
  {
    name: "memory-curator",
    role: "Promote valuable daily work into concise reusable experience.",
    temperature: 0.1,
    allowedTools: ["read_file", "inspect_task"],
    forbiddenTools: ["write_file", "shell", "network"],
    capabilities: ["experience extraction", "memory curation", "best-practice revision"],
    skills: ["memory-curation"],
    instructions: "Promote only high-value reusable lessons, update existing topics when appropriate, and keep evidence IDs.",
  },
];
