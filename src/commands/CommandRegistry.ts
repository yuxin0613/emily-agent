export interface RuntimeCommand {
  name: string;
  aliases: string[];
  description: string;
  permission: "read" | "write";
  inputSchema: {
    args: string[];
    examples: string[];
  };
  run: (args: string[], options: { format: "json" | "text" }) => Promise<unknown> | unknown;
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

  async run(name: string, args: string[] = [], options: { format?: "json" | "text" } = {}): Promise<unknown> {
    const command = this.resolve(name);
    if (!command) throw new Error(`Unknown command: ${name}`);
    const format = options.format || "json";
    const result = await command.run(args, { format });
    return format === "text" && command.renderText ? command.renderText(result) : result;
  }

  private resolve(name: string): RuntimeCommand | null {
    return this.commands.get(name) || this.commands.get(this.aliases.get(name) || "") || null;
  }
}

export function createCommandRegistry(runtime: {
  doctor: (options?: { deep?: boolean; repair?: boolean }) => Promise<unknown>;
  listTools: () => unknown[];
  listSkills: () => unknown[];
  listProviders: () => unknown[];
  listRoles: () => Promise<unknown[]>;
  resumeLatestSession: (options?: { includeHidden?: boolean }) => unknown;
  exportSession: (sessionId: string, options?: { format?: "json" | "markdown" }) => unknown;
  previewSessionCompaction: (sessionId: string, options?: { maxMessages?: number }) => unknown;
  sessionUsage: (sessionId: string) => unknown;
}): CommandRegistry {
  const registry = new CommandRegistry();
  registry.add({
    name: "doctor",
    aliases: ["healthcheck"],
    description: "Run aggregated runtime doctor checks.",
    permission: "read",
    inputSchema: {
      args: ["[--deep]", "[--repair]"],
      examples: ["doctor --deep", "doctor --repair"],
    },
    run: (args) => runtime.doctor({
      deep: args.includes("--deep") || args.includes("deep"),
      repair: args.includes("--repair") || args.includes("repair"),
    }),
    renderText: (result) => renderDoctor(result),
  });
  registry.add({
    name: "tools",
    aliases: ["tool.list"],
    description: "List registered tools.",
    permission: "read",
    inputSchema: { args: [], examples: ["tools"] },
    run: () => runtime.listTools(),
  });
  registry.add({
    name: "skills",
    aliases: ["skill.list"],
    description: "List registered skills.",
    permission: "read",
    inputSchema: { args: [], examples: ["skills"] },
    run: () => runtime.listSkills(),
  });
  registry.add({
    name: "providers",
    aliases: ["provider.list"],
    description: "List model providers.",
    permission: "read",
    inputSchema: { args: [], examples: ["providers"] },
    run: () => runtime.listProviders(),
  });
  registry.add({
    name: "roles",
    aliases: ["role.list"],
    description: "List agent roles.",
    permission: "read",
    inputSchema: { args: [], examples: ["roles"] },
    run: () => runtime.listRoles(),
  });
  registry.add({
    name: "session.resume_latest",
    aliases: ["resume"],
    description: "Return the latest resumable session.",
    permission: "read",
    inputSchema: {
      args: ["[--hidden]"],
      examples: ["session.resume_latest", "resume --hidden"],
    },
    run: (args) => runtime.resumeLatestSession({ includeHidden: args.includes("--hidden") || args.includes("hidden") }),
  });
  registry.add({
    name: "session.export",
    aliases: ["export-session"],
    description: "Export a session as JSON or Markdown.",
    permission: "read",
    inputSchema: {
      args: ["<sessionId>", "[--markdown]"],
      examples: ["session.export sess_123", "export-session sess_123 --markdown"],
    },
    run: (args) => runtime.exportSession(requiredArg(args, 0, "session id"), {
      format: args.includes("--markdown") || args.includes("markdown") ? "markdown" : "json",
    }),
    renderText: (result) => typeof result === "string" ? result : JSON.stringify(result, null, 2),
  });
  registry.add({
    name: "session.compact_preview",
    aliases: ["compact-preview"],
    description: "Preview session compaction without mutating state.",
    permission: "read",
    inputSchema: {
      args: ["<sessionId>", "[maxMessages]"],
      examples: ["session.compact_preview sess_123 20"],
    },
    run: (args) => runtime.previewSessionCompaction(requiredArg(args, 0, "session id"), {
      maxMessages: numberArg(args[1], 20),
    }),
  });
  registry.add({
    name: "session.usage",
    aliases: ["session-usage"],
    description: "Summarize provider usage for a session.",
    permission: "read",
    inputSchema: {
      args: ["<sessionId>"],
      examples: ["session.usage sess_123"],
    },
    run: (args) => runtime.sessionUsage(requiredArg(args, 0, "session id")),
  });
  return registry;
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
    skillCandidates?: { proposed?: number };
  };
  return [
    `Doctor: ${report.status || "unknown"}`,
    `Generated: ${report.generatedAt || ""}`,
    `Diagnostics: ${report.diagnostics?.length || 0}`,
    `Providers: ${report.providerHealth?.length || 0}`,
    `Security findings: ${report.security?.summary?.findings || 0} (critical=${report.security?.summary?.critical || 0}, warnings=${report.security?.summary?.warnings || 0})`,
    `Memory candidates pending: ${report.memoryCandidates?.pending || 0}`,
    `Skill candidates proposed: ${report.skillCandidates?.proposed || 0}`,
  ].join("\n");
}

function requiredArg(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function numberArg(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
