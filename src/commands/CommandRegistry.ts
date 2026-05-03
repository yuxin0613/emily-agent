export type CommandPermission = "read" | "write" | "danger";

export interface CommandInputSchema {
  args: string[];
  examples: string[];
  required?: string[];
  properties?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
}

export interface RuntimeCommand {
  name: string;
  aliases: string[];
  description: string;
  permission: CommandPermission;
  inputSchema: CommandInputSchema;
  run: (input: { args: string[]; input: Record<string, unknown>; format: "json" | "text" }) => Promise<unknown> | unknown;
  renderText?: (result: unknown) => string;
}

export class CommandRegistry {
  private readonly commands = new Map<string, RuntimeCommand>();
  private readonly aliases = new Map<string, string>();

  add(command: RuntimeCommand): void {
    this.commands.set(command.name, command);
    for (const alias of command.aliases) {
      this.aliases.set(alias, command.name);
    }
  }

  list(): Array<Omit<RuntimeCommand, "run" | "renderText">> {
    return [...this.commands.values()]
      .map(({ run: _run, renderText: _renderText, ...command }) => command)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(
    name: string,
    args: string[] = [],
    options: { format?: "json" | "text"; input?: Record<string, unknown> } = {},
  ): Promise<unknown> {
    const command = this.resolve(name);
    if (!command) throw new Error(`Unknown command: ${name}`);
    const format = options.format || "json";
    const input = options.input || {};
    validateInput(command, input, args);
    const result = await command.run({ args, input, format });
    return format === "text" && command.renderText ? command.renderText(result) : result;
  }

  private resolve(name: string): RuntimeCommand | null {
    return this.commands.get(name) || this.commands.get(this.aliases.get(name) || "") || null;
  }
}

export function createCommandRegistry(runtime: CommandRuntime): CommandRegistry {
  const registry = new CommandRegistry();
  registry.add({
    name: "doctor",
    aliases: ["healthcheck"],
    description: "Run aggregated runtime doctor checks.",
    permission: "read",
    inputSchema: {
      args: ["[--deep]", "[--repair]"],
      examples: ["doctor --deep", "doctor --repair"],
      properties: { deep: "boolean", repair: "boolean" },
    },
    run: ({ args, input }) => runtime.doctor({
      deep: input.deep === true || args.includes("--deep") || args.includes("deep"),
      repair: input.repair === true || args.includes("--repair") || args.includes("repair"),
    }),
    renderText: (result) => renderDoctor(result),
  });

  for (const command of queryCommands(runtime)) registry.add(command);
  for (const command of sessionCommands(runtime)) registry.add(command);
  for (const command of providerCommands(runtime)) registry.add(command);
  for (const command of roleCommands(runtime)) registry.add(command);
  for (const command of skillCandidateCommands(runtime)) registry.add(command);
  for (const command of runtimeControlCommands(runtime)) registry.add(command);
  return registry;
}

interface CommandRuntime {
  doctor: (options?: { deep?: boolean; repair?: boolean }) => Promise<unknown>;
  listTools: () => unknown[];
  listSkills: () => unknown[];
  listProviders: () => unknown[];
  listRoles: () => Promise<unknown[]>;
  resumeLatestSession: (options?: { includeHidden?: boolean }) => unknown;
  exportSession: (sessionId: string, options?: { format?: "json" | "markdown" }) => unknown;
  previewSessionCompaction: (sessionId: string, options?: { maxMessages?: number }) => unknown;
  sessionUsage: (sessionId: string) => unknown;
  createSession: (options?: { title?: string; source?: string; metadata?: Record<string, unknown> }) => unknown;
  clearSession: (sessionId: string, options?: { source?: string; reason?: string; nextTitle?: string }) => unknown;
  restoreSession: (sessionId: string) => unknown;
  trashSession: (sessionId: string, options?: { deleteAfterDays?: number; reason?: string }) => unknown;
  addProvider: (input: { id: string; type: "echo" | "openai" | "ollama"; enabled?: boolean; model?: string; config?: Record<string, unknown> }) => Promise<unknown>;
  enableProvider: (providerId: string) => Promise<unknown>;
  disableProvider: (providerId: string) => Promise<unknown>;
  removeProvider: (providerId: string) => Promise<unknown>;
  addRole: (input: {
    name: string;
    role: string;
    provider?: string;
    model?: string;
    temperature?: number;
    allowedTools?: string[];
    forbiddenTools?: string[];
    capabilities?: string[];
    skills?: string[];
    skillAllowlist?: string[];
    outputContract?: string;
    instructions: string;
  }) => Promise<unknown>;
  updateRoleProvider: (name: string, input: { provider?: string; model?: string; temperature?: number }) => Promise<unknown>;
  initializeDefaultRoles: (options?: { overwrite?: boolean }) => Promise<unknown[]>;
  buildSkillCandidates: (options?: Record<string, unknown>) => unknown;
  approveSkillCandidate: (candidateId: string, options?: { reason?: string }) => Promise<unknown>;
  rejectSkillCandidate: (candidateId: string, reason?: string) => unknown;
  diagnostics: (options?: { repair?: boolean }) => unknown;
  maintenance: (options?: Record<string, unknown>) => Promise<unknown>;
  cancelTask: (taskId: string, reason?: string) => Promise<unknown>;
  cancelRun: (runId: string, reason?: string) => Promise<unknown>;
  executeTool: (input: {
    tool: string;
    args?: Record<string, unknown>;
    approval?: { approved?: boolean; reason?: string; approvedBy?: string };
    role?: string;
    permissionMode?: unknown;
    taskId?: string;
    runId?: string;
    sessionId?: string;
  }) => Promise<unknown>;
}

function queryCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "tools",
      aliases: ["tool.list"],
      description: "List registered tools.",
      permission: "read",
      inputSchema: { args: [], examples: ["tools"] },
      run: () => runtime.listTools(),
    },
    {
      name: "skills",
      aliases: ["skill.list"],
      description: "List registered skills.",
      permission: "read",
      inputSchema: { args: [], examples: ["skills"] },
      run: () => runtime.listSkills(),
    },
    {
      name: "providers",
      aliases: ["provider.list"],
      description: "List model providers.",
      permission: "read",
      inputSchema: { args: [], examples: ["providers"] },
      run: () => runtime.listProviders(),
    },
    {
      name: "roles",
      aliases: ["role.list"],
      description: "List agent roles.",
      permission: "read",
      inputSchema: { args: [], examples: ["roles"] },
      run: () => runtime.listRoles(),
    },
  ];
}

function sessionCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "session.resume_latest",
      aliases: ["resume"],
      description: "Return the latest resumable session.",
      permission: "read",
      inputSchema: {
        args: ["[--hidden]"],
        examples: ["session.resume_latest", "resume --hidden"],
        properties: { includeHidden: "boolean" },
      },
      run: ({ args, input }) => runtime.resumeLatestSession({ includeHidden: input.includeHidden === true || args.includes("--hidden") || args.includes("hidden") }),
    },
    {
      name: "session.export",
      aliases: ["export-session"],
      description: "Export a session as JSON or Markdown.",
      permission: "read",
      inputSchema: {
        args: ["<sessionId>", "[--markdown]"],
        examples: ["session.export sess_123", "export-session sess_123 --markdown"],
        required: ["sessionId"],
        properties: { sessionId: "string", format: "string" },
      },
      run: ({ args, input }) => runtime.exportSession(stringInput(input.sessionId, args[0], "sessionId"), {
        format: input.format === "markdown" || args.includes("--markdown") || args.includes("markdown") ? "markdown" : "json",
      }),
      renderText: (result) => typeof result === "string" ? result : JSON.stringify(result, null, 2),
    },
    {
      name: "session.compact_preview",
      aliases: ["compact-preview"],
      description: "Preview session compaction without mutating state.",
      permission: "read",
      inputSchema: {
        args: ["<sessionId>", "[maxMessages]"],
        examples: ["session.compact_preview sess_123 20"],
        required: ["sessionId"],
        properties: { sessionId: "string", maxMessages: "number" },
      },
      run: ({ args, input }) => runtime.previewSessionCompaction(stringInput(input.sessionId, args[0], "sessionId"), {
        maxMessages: numberInput(input.maxMessages, args[1], 20),
      }),
    },
    {
      name: "session.usage",
      aliases: ["session-usage"],
      description: "Summarize provider usage for a session.",
      permission: "read",
      inputSchema: {
        args: ["<sessionId>"],
        examples: ["session.usage sess_123"],
        required: ["sessionId"],
        properties: { sessionId: "string" },
      },
      run: ({ args, input }) => runtime.sessionUsage(stringInput(input.sessionId, args[0], "sessionId")),
    },
    {
      name: "session.create",
      aliases: ["new-session"],
      description: "Create a new session.",
      permission: "write",
      inputSchema: {
        args: ["[title]"],
        examples: ["session.create", "new-session Research"],
        properties: { title: "string", source: "string", metadata: "object" },
      },
      run: ({ args, input }) => runtime.createSession({
        title: stringOptional(input.title) || args.join(" ") || "New session",
        source: stringOptional(input.source) || "command",
        metadata: {
          createdBy: "command",
          ...objectInput(input.metadata),
        },
      }),
    },
    {
      name: "session.clear",
      aliases: ["clear-session"],
      description: "Hide a session and create a new active session.",
      permission: "write",
      inputSchema: {
        args: ["<sessionId>"],
        examples: ["session.clear sess_123"],
        required: ["sessionId"],
        properties: { sessionId: "string", source: "string", reason: "string", nextTitle: "string" },
      },
      run: ({ args, input }) => runtime.clearSession(stringInput(input.sessionId, args[0], "sessionId"), {
        source: stringOptional(input.source) || "command",
        reason: stringOptional(input.reason) || "cleared from command registry",
        nextTitle: stringOptional(input.nextTitle) || "New session",
      }),
    },
    {
      name: "session.restore",
      aliases: ["restore-session"],
      description: "Restore a hidden or trashed session.",
      permission: "write",
      inputSchema: {
        args: ["<sessionId>"],
        examples: ["session.restore sess_123"],
        required: ["sessionId"],
        properties: { sessionId: "string" },
      },
      run: ({ args, input }) => runtime.restoreSession(stringInput(input.sessionId, args[0], "sessionId")),
    },
    {
      name: "session.trash",
      aliases: ["trash-session"],
      description: "Move a session to trash.",
      permission: "write",
      inputSchema: {
        args: ["<sessionId>"],
        examples: ["session.trash sess_123"],
        required: ["sessionId"],
        properties: { sessionId: "string", deleteAfterDays: "number", reason: "string" },
      },
      run: ({ args, input }) => runtime.trashSession(stringInput(input.sessionId, args[0], "sessionId"), {
        deleteAfterDays: numberInput(input.deleteAfterDays, undefined, 30),
        reason: stringOptional(input.reason) || "trashed from command registry",
      }),
    },
  ];
}

function providerCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "provider.add",
      aliases: ["add-provider"],
      description: "Add a provider config.",
      permission: "write",
      inputSchema: {
        args: [],
        examples: ['provider.add {"id":"qa","type":"echo"}'],
        required: ["id", "type"],
        properties: { id: "string", type: "string", enabled: "boolean", model: "string", config: "object" },
      },
      run: ({ input }) => runtime.addProvider({
        id: requiredString(input.id, "id"),
        type: parseProviderType(input.type),
        enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
        model: stringOptional(input.model),
        config: objectInput(input.config),
      }),
    },
    simpleProviderCommand(runtime, "provider.enable", ["enable-provider"], "Enable a provider.", (target, providerId) => target.enableProvider(providerId)),
    simpleProviderCommand(runtime, "provider.disable", ["disable-provider"], "Disable a provider.", (target, providerId) => target.disableProvider(providerId)),
    simpleProviderCommand(runtime, "provider.remove", ["remove-provider"], "Remove a provider.", (target, providerId) => target.removeProvider(providerId)),
  ];
}

function roleCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "role.add",
      aliases: ["add-role"],
      description: "Create or overwrite a role definition.",
      permission: "write",
      inputSchema: {
        args: [],
        examples: ['role.add {"name":"qa","role":"Quality","instructions":"Review."}'],
        required: ["name", "role", "instructions"],
        properties: {
          name: "string",
          role: "string",
          provider: "string",
          model: "string",
          temperature: "number",
          allowedTools: "array",
          forbiddenTools: "array",
          capabilities: "array",
          skills: "array",
          skillAllowlist: "array",
          outputContract: "string",
          instructions: "string",
        },
      },
      run: ({ input }) => runtime.addRole({
        name: requiredString(input.name, "name"),
        role: requiredString(input.role, "role"),
        provider: stringOptional(input.provider),
        model: stringOptional(input.model),
        temperature: typeof input.temperature === "number" ? input.temperature : undefined,
        allowedTools: stringArray(input.allowedTools),
        forbiddenTools: stringArray(input.forbiddenTools),
        capabilities: stringArray(input.capabilities),
        skills: stringArray(input.skills),
        skillAllowlist: stringArray(input.skillAllowlist),
        outputContract: stringOptional(input.outputContract),
        instructions: requiredString(input.instructions, "instructions"),
      }),
    },
    {
      name: "role.update_provider",
      aliases: ["role-provider"],
      description: "Update a role provider/model binding.",
      permission: "write",
      inputSchema: {
        args: ["<name>"],
        examples: ["role.update_provider qa"],
        required: ["name"],
        properties: { name: "string", provider: "string", model: "string", temperature: "number" },
      },
      run: ({ args, input }) => runtime.updateRoleProvider(stringInput(input.name, args[0], "name"), {
        provider: stringOptional(input.provider),
        model: stringOptional(input.model),
        temperature: typeof input.temperature === "number" ? input.temperature : undefined,
      }),
    },
    {
      name: "role.initialize_defaults",
      aliases: ["roles.defaults"],
      description: "Create default role definitions.",
      permission: "write",
      inputSchema: {
        args: ["[--overwrite]"],
        examples: ["role.initialize_defaults --overwrite"],
        properties: { overwrite: "boolean" },
      },
      run: ({ args, input }) => runtime.initializeDefaultRoles({ overwrite: input.overwrite === true || args.includes("--overwrite") }),
    },
  ];
}

function skillCandidateCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "skills.candidates.build",
      aliases: ["build-skills"],
      description: "Build proposed skill candidates from recent task history.",
      permission: "write",
      inputSchema: {
        args: [],
        examples: ["skills.candidates.build"],
        properties: { day: "string", lookbackDays: "number", minOccurrences: "number", minScore: "number", dailyLimit: "number" },
      },
      run: ({ input }) => runtime.buildSkillCandidates(normalizeDatedOptions(input)),
    },
    {
      name: "skills.candidates.approve",
      aliases: ["approve-skill"],
      description: "Approve a proposed skill candidate.",
      permission: "write",
      inputSchema: {
        args: ["<candidateId>"],
        examples: ["skills.candidates.approve cand_123"],
        required: ["candidateId"],
        properties: { candidateId: "string", reason: "string" },
      },
      run: ({ args, input }) => runtime.approveSkillCandidate(stringInput(input.candidateId, args[0], "candidateId"), {
        reason: stringOptional(input.reason),
      }),
    },
    {
      name: "skills.candidates.reject",
      aliases: ["reject-skill"],
      description: "Reject a proposed skill candidate.",
      permission: "write",
      inputSchema: {
        args: ["<candidateId>"],
        examples: ["skills.candidates.reject cand_123"],
        required: ["candidateId"],
        properties: { candidateId: "string", reason: "string" },
      },
      run: ({ args, input }) => runtime.rejectSkillCandidate(stringInput(input.candidateId, args[0], "candidateId"), stringOptional(input.reason) || "rejected from command registry"),
    },
  ];
}

function runtimeControlCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "diagnostics.repair",
      aliases: ["repair-diagnostics"],
      description: "Run diagnostics in repair mode.",
      permission: "write",
      inputSchema: { args: [], examples: ["diagnostics.repair"] },
      run: () => runtime.diagnostics({ repair: true }),
    },
    {
      name: "maintenance.run",
      aliases: ["maintenance"],
      description: "Run runtime maintenance.",
      permission: "write",
      inputSchema: {
        args: [],
        examples: ["maintenance.run"],
        properties: {
          day: "string",
          staleRunMs: "number",
          maxEvents: "number",
          pruneMemoryCandidateDays: "number",
          maxFileMemoryRecords: "number",
          maxVectorMemoryRecords: "number",
          pruneArchivedExperienceVectorDays: "number",
          sessionTrashDays: "number",
          skillLookbackDays: "number",
          skillMinOccurrences: "number",
          skillMinScore: "number",
          skillDailyLimit: "number",
        },
      },
      run: ({ input }) => runtime.maintenance(normalizeDatedOptions(input)),
    },
    {
      name: "task.cancel",
      aliases: ["cancel-task"],
      description: "Cancel a task.",
      permission: "write",
      inputSchema: {
        args: ["<taskId>"],
        examples: ["task.cancel task_123"],
        required: ["taskId"],
        properties: { taskId: "string", reason: "string" },
      },
      run: ({ args, input }) => runtime.cancelTask(stringInput(input.taskId, args[0], "taskId"), stringOptional(input.reason) || "cancelled from command registry"),
    },
    {
      name: "run.cancel",
      aliases: ["cancel-run"],
      description: "Cancel a run.",
      permission: "write",
      inputSchema: {
        args: ["<runId>"],
        examples: ["run.cancel run_123"],
        required: ["runId"],
        properties: { runId: "string", reason: "string" },
      },
      run: ({ args, input }) => runtime.cancelRun(stringInput(input.runId, args[0], "runId"), stringOptional(input.reason) || "cancelled from command registry"),
    },
    {
      name: "tool.execute",
      aliases: ["execute-tool"],
      description: "Execute a real tool through ToolGateway permissions and audit events.",
      permission: "write",
      inputSchema: {
        args: ["<tool>"],
        examples: ['tool.execute read_file {"path":"README.md"}'],
        required: ["tool"],
        properties: { tool: "string", args: "object", approval: "object", role: "string", permissionMode: "string", taskId: "string", runId: "string", sessionId: "string" },
      },
      run: ({ args, input }) => runtime.executeTool({
        tool: stringInput(input.tool, args[0], "tool"),
        args: objectInput(input.args),
        approval: objectInput(input.approval) as { approved?: boolean; reason?: string; approvedBy?: string },
        role: stringOptional(input.role),
        permissionMode: input.permissionMode,
        taskId: stringOptional(input.taskId),
        runId: stringOptional(input.runId),
        sessionId: stringOptional(input.sessionId),
      }),
    },
  ];
}

function simpleProviderCommand(
  runtime: CommandRuntime,
  name: string,
  aliases: string[],
  description: string,
  handler: (runtime: CommandRuntime, providerId: string) => Promise<unknown>,
): RuntimeCommand {
  return {
    name,
    aliases,
    description,
    permission: "write",
    inputSchema: {
      args: ["<providerId>"],
      examples: [`${name} provider_1`],
      required: ["providerId"],
      properties: { providerId: "string" },
    },
    run: ({ args, input }) => handler(runtime, stringInput(input.providerId, args[0], "providerId")),
  };
}

function validateInput(command: RuntimeCommand, input: Record<string, unknown>, args: string[]): void {
  for (const key of command.inputSchema.required || []) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      if (args.length) continue;
      throw new Error(`Command ${command.name} requires input.${key}`);
    }
  }
  for (const [key, expected] of Object.entries(command.inputSchema.properties || {})) {
    if (input[key] === undefined) continue;
    if (expected === "array") {
      if (!Array.isArray(input[key])) throw new Error(`Command ${command.name} input.${key} must be array`);
      continue;
    }
    if (expected === "object") {
      if (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key])) throw new Error(`Command ${command.name} input.${key} must be object`);
      continue;
    }
    if (typeof input[key] !== expected) throw new Error(`Command ${command.name} input.${key} must be ${expected}`);
  }
}

function renderDoctor(result: unknown): string {
  if (!result || typeof result !== "object") return String(result);
  const report = result as {
    status?: string;
    generatedAt?: string;
    diagnostics?: unknown[];
    providerHealth?: unknown[];
    security?: { summary?: { findings?: number; critical?: number; warnings?: number } };
    memoryCandidates?: { pending?: number };
    vectorMemory?: { kind?: string; ok?: boolean };
    skillCandidates?: { proposed?: number };
  };
  return [
    `Doctor: ${report.status || "unknown"}`,
    `Generated: ${report.generatedAt || ""}`,
    `Diagnostics: ${report.diagnostics?.length || 0}`,
    `Providers: ${report.providerHealth?.length || 0}`,
    `Security findings: ${report.security?.summary?.findings || 0} (critical=${report.security?.summary?.critical || 0}, warnings=${report.security?.summary?.warnings || 0})`,
    `Memory candidates pending: ${report.memoryCandidates?.pending || 0}`,
    `Vector memory: ${report.vectorMemory?.kind || "unknown"} ok=${report.vectorMemory?.ok !== false}`,
    `Skill candidates proposed: ${report.skillCandidates?.proposed || 0}`,
  ].join("\n");
}

function stringInput(input: unknown, arg: string | undefined, label: string): string {
  return requiredString(input ?? arg, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function stringOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberInput(input: unknown, arg: string | undefined, fallback: number): number {
  const parsed = Number(input ?? arg);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeDatedOptions(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    ...(typeof input.day === "string" && input.day.trim() ? { day: new Date(input.day) } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function parseProviderType(value: unknown): "echo" | "openai" | "ollama" {
  if (value === "echo" || value === "openai" || value === "ollama") return value;
  throw new Error("provider type must be echo, openai, or ollama");
}
