import type { CronJobInput } from "../cron/CronScheduler.ts";
import type { ToolApproval } from "../tools/ToolExecutor.ts";
import type { Metadata, ToolPermission } from "../types.ts";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.ts";
import {
  renderTaskMindMap,
  renderTaskMindMapNode,
  renderTaskMindMapRootList,
  type TaskGraphNodeAddInput,
  type TaskGraphNodeDeleteInput,
  type TaskGraphNodeMutationInput,
  type TaskGraphNodeSiblingInput,
} from "../tasks/TaskMindMap.ts";

export type CommandPermission = "read" | "write" | "danger";

const COMMAND_TOOL_REGISTRY = createDefaultToolRegistry();

export class CommandPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandPermissionError";
  }
}

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
  permissionForInput?: (input: { args: string[]; input: Record<string, unknown>; format: "json" | "text" }) => CommandPermission;
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

  list(): Array<Omit<RuntimeCommand, "run" | "renderText" | "permissionForInput">> {
    return [...this.commands.values()]
      .map(({ run: _run, renderText: _renderText, permissionForInput: _permissionForInput, ...command }) => command)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async run(
    name: string,
    args: string[] = [],
    options: { format?: "json" | "text"; input?: Record<string, unknown>; maxPermission?: CommandPermission } = {},
  ): Promise<unknown> {
    const command = this.resolve(name);
    if (!command) throw new Error(`Unknown command: ${name}`);
    const format = options.format || "json";
    const input = options.input || {};
    const invocation = { args, input, format };
    assertCommandPermission(command, options.maxPermission || "danger", invocation);
    validateInput(command, input, args);
    const result = await command.run(invocation);
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
    permissionForInput: ({ args, input }) => {
      if (wantsRepair(input, args)) return "write";
      return wantsDeepProviderCheck(input, args) ? "danger" : "read";
    },
    run: ({ args, input }) => runtime.doctor({
      deep: input.deep === true || args.includes("--deep") || args.includes("deep"),
      repair: wantsRepair(input, args),
    }),
    renderText: (result) => renderDoctor(result),
  });

  for (const command of queryCommands(runtime)) registry.add(command);
  for (const command of sessionCommands(runtime)) registry.add(command);
  for (const command of providerCommands(runtime)) registry.add(command);
  for (const command of roleCommands(runtime)) registry.add(command);
  for (const command of graphCommands(runtime)) registry.add(command);
  for (const command of skillCandidateCommands(runtime)) registry.add(command);
  for (const command of cronCommands(runtime)) registry.add(command);
  for (const command of runtimeControlCommands(runtime)) registry.add(command);
  return registry;
}

interface CommandRuntime {
  health: () => unknown;
  doctor: (options?: { deep?: boolean; repair?: boolean }) => Promise<unknown>;
  listTools: () => unknown[];
  listSkills: () => unknown[];
  listSkillCandidates: (options?: { status?: "proposed" | "approved" | "merged" | "rejected"; limit?: number }) => unknown[];
  listProviders: () => unknown[];
  checkProviders: (options?: { deep?: boolean }) => Promise<unknown[]>;
  providerUsage: (options?: { since?: Date; until?: Date; providerId?: string; limit?: number }) => unknown;
  getSettings: () => unknown;
  updateSettings: (input?: Record<string, unknown>) => Promise<unknown>;
  listRoles: () => Promise<unknown[]>;
  listSessions: (options?: { status?: "active" | "hidden" | "trashed" | "deleted"; includeHidden?: boolean; includeTrashed?: boolean; includeDeleted?: boolean; limit?: number }) => unknown[];
  listSessionMessages: (options: { sessionId: string; limit?: number }) => unknown[];
  resumeLatestSession: (options?: { includeHidden?: boolean }) => unknown;
  exportSession: (sessionId: string, options?: { format?: "json" | "markdown" }) => unknown;
  previewSessionCompaction: (sessionId: string, options?: { maxMessages?: number }) => unknown;
  sessionUsage: (sessionId: string) => unknown;
  recallExperiences: (query?: string, options?: { limit?: number }) => unknown[];
  addExperienceFeedback: (input: { experienceId: string; rating: "useful" | "wrong" | "outdated" | "duplicate"; comment?: string }) => unknown;
  buildDailyExperiences: (options?: { day?: Date }) => unknown;
  getTimeline: (options: { runId: string }) => unknown;
  renderTimeline: (runId: string) => string;
  getTaskTrace: (taskId: string) => unknown;
  listSubagents: (options?: { includeIdle?: boolean }) => unknown;
  getTaskMindMap: (runId: string) => unknown;
  listTaskMindMapRoots: (options?: { activeOnly?: boolean; limit?: number }) => unknown;
  getTaskMindMapNode: (runId: string, selector: string) => unknown;
  addTaskMindMapNode: (input: TaskGraphNodeAddInput) => unknown;
  addTaskMindMapNodeBefore: (input: TaskGraphNodeSiblingInput) => unknown;
  addTaskMindMapNodeAfter: (input: TaskGraphNodeSiblingInput) => unknown;
  updateTaskMindMapNode: (input: TaskGraphNodeMutationInput) => unknown;
  deleteTaskMindMapNode: (input: TaskGraphNodeDeleteInput) => unknown;
  securityAudit: () => Promise<unknown>;
  buildContext: (options: { query: string; sessionId?: string; runId?: string | null; role?: string; mode?: "active" | "deep" }) => Promise<unknown>;
  routeMessage: (input: string) => unknown;
  createSession: (options?: { title?: string; source?: string; metadata?: Metadata }) => unknown;
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
    allowedTools?: ToolPermission[];
    forbiddenTools?: ToolPermission[];
    capabilities?: string[];
    skills?: string[];
    skillAllowlist?: string[];
    outputContract?: string;
    instructions: string;
  }) => Promise<unknown>;
  updateRoleProvider: (name: string, input: { provider?: string | null; model?: string | null; temperature?: number | null }) => Promise<unknown>;
  initializeDefaultRoles: (options?: { overwrite?: boolean }) => Promise<unknown[]>;
  buildSkillCandidates: (options?: Record<string, unknown>) => unknown;
  approveSkillCandidate: (candidateId: string, options?: { reason?: string }) => Promise<unknown>;
  rejectSkillCandidate: (candidateId: string, reason?: string) => unknown;
  diagnostics: (options?: { repair?: boolean }) => unknown;
  maintenance: (options?: Record<string, unknown>) => Promise<unknown>;
  cancelTask: (taskId: string, reason?: string) => Promise<unknown>;
  cancelRun: (runId: string, reason?: string) => Promise<unknown>;
  listCronJobs: (options?: { includePaused?: boolean }) => unknown[];
  createCronJob: (input: CronJobInput) => Promise<unknown>;
  updateCronJob: (id: string, input: Partial<CronJobInput>) => Promise<unknown>;
  pauseCronJob: (id: string) => Promise<unknown>;
  resumeCronJob: (id: string) => Promise<unknown>;
  deleteCronJob: (id: string) => Promise<unknown>;
  runCronJob: (id: string) => Promise<unknown>;
  executeTool: (input: {
    tool: string;
    args?: Record<string, unknown>;
    approval?: ToolApproval;
    role?: string;
    permissionMode?: unknown;
    taskId?: string;
    runId?: string;
    sessionId?: string;
  }) => Promise<unknown>;
}

function cronCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "cron.list",
      aliases: ["cron", "crons"],
      description: "List cron jobs.",
      permission: "read",
      inputSchema: {
        args: ["[all|active]"],
        examples: ["cron.list", "cron.list active"],
        properties: { includePaused: "boolean" },
      },
      run: ({ args, input }) => runtime.listCronJobs({
        includePaused: input.includePaused === true || args[0] !== "active",
      }),
      renderText: (result) => renderCronJobs(result),
    },
    {
      name: "cron.create",
      aliases: ["cron-add", "cron.create_chat"],
      description: "Create a cron job for a chat message or command.",
      permission: "write",
      inputSchema: {
        args: ["<name>", "<schedule>", "[message]"],
        examples: ['cron.create "daily build" "0 9 * * *" "整理昨天的工作"', 'cron.create -- command maintenance.run @daily'],
        required: ["name", "schedule"],
        properties: {
          name: "string",
          schedule: "string",
          message: "string",
          command: "string",
          args: "array",
          input: "object",
          format: "string",
          sessionId: "string",
          source: "string",
          permissionMode: "string",
          status: "string",
        },
      },
      run: ({ args, input }) => runtime.createCronJob({
        name: stringInput(input.name, args[0], "name"),
        schedule: stringInput(input.schedule, args[1], "schedule"),
        message: stringOptional(input.message) || args.slice(2).join(" ").trim() || undefined,
        command: stringOptional(input.command),
        args: Array.isArray(input.args) ? input.args.map(String) : [],
        input: objectInput(input.input),
        format: input.format === "text" ? "text" : "json",
        sessionId: stringOptional(input.sessionId),
        source: stringOptional(input.source) || "cron",
        permissionMode: input.permissionMode,
        status: input.status === "paused" ? "paused" : "active",
      }),
      renderText: (result) => renderCronJobs([result]),
    },
    {
      name: "cron.update",
      aliases: ["cron-edit"],
      description: "Update cron job name, schedule, action, or status.",
      permission: "write",
      inputSchema: {
        args: ["<id>"],
        examples: ['cron.update job_123 -- input.schedule="*/10 * * * *"'],
        required: ["id"],
        properties: {
          id: "string",
          name: "string",
          schedule: "string",
          message: "string",
          command: "string",
          args: "array",
          input: "object",
          format: "string",
          sessionId: "string",
          source: "string",
          permissionMode: "string",
          status: "string",
        },
      },
      run: ({ args, input }) => runtime.updateCronJob(stringInput(input.id, args[0], "id"), {
        name: stringOptional(input.name),
        schedule: stringOptional(input.schedule),
        message: stringOptional(input.message),
        command: stringOptional(input.command),
        args: Array.isArray(input.args) ? input.args.map(String) : undefined,
        input: input.input && typeof input.input === "object" && !Array.isArray(input.input) ? input.input as Record<string, unknown> : undefined,
        format: input.format === "text" ? "text" : input.format === "json" ? "json" : undefined,
        sessionId: stringOptional(input.sessionId),
        source: stringOptional(input.source),
        permissionMode: input.permissionMode,
        status: input.status === "paused" ? "paused" : input.status === "active" ? "active" : undefined,
      }),
      renderText: (result) => renderCronJobs([result]),
    },
    simpleCronCommand(runtime, "cron.pause", ["cron-pause"], "Pause a cron job.", (runtime, id) => runtime.pauseCronJob(id)),
    simpleCronCommand(runtime, "cron.resume", ["cron-resume"], "Resume a cron job.", (runtime, id) => runtime.resumeCronJob(id)),
    simpleCronCommand(runtime, "cron.delete", ["cron-delete", "cron.remove"], "Delete a cron job.", (runtime, id) => runtime.deleteCronJob(id)),
    simpleCronCommand(runtime, "cron.run", ["cron-run"], "Run a cron job now.", (runtime, id) => runtime.runCronJob(id), renderCronRun),
  ];
}

function queryCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "health",
      aliases: ["runtime.health"],
      description: "Return runtime health summary.",
      permission: "read",
      inputSchema: { args: [], examples: ["health"] },
      run: () => runtime.health(),
      renderText: (result) => renderKeyValues("Runtime Health", result),
    },
    {
      name: "tools",
      aliases: ["tool.list"],
      description: "List registered tools.",
      permission: "read",
      inputSchema: { args: [], examples: ["tools"] },
      run: () => runtime.listTools(),
      renderText: (result) => renderTable("Tools", result, [
        ["Name", "name"],
        ["Category", "category"],
        ["Side Effects", "sideEffects"],
        ["Approval", (item) => item.requiresApproval ? "yes" : "no"],
        ["Description", "description"],
      ]),
    },
    {
      name: "skills",
      aliases: ["skill.list"],
      description: "List registered skills.",
      permission: "read",
      inputSchema: { args: [], examples: ["skills"] },
      run: () => runtime.listSkills(),
      renderText: (result) => renderTable("Skills", result, [
        ["Name", "name"],
        ["Source", "source"],
        ["Tools", (item) => Array.isArray(item.toolHints) ? item.toolHints.join(",") : ""],
        ["Description", "description"],
      ]),
    },
    {
      name: "skills.candidates.list",
      aliases: ["candidate.list", "skill-candidates"],
      description: "List skill candidates.",
      permission: "read",
      inputSchema: {
        args: ["[status]", "[limit]"],
        examples: ["skills.candidates.list proposed 50"],
        properties: { status: "string", limit: "number" },
      },
      run: ({ args, input }) => runtime.listSkillCandidates({
        status: parseSkillCandidateStatus(input.status ?? args[0]),
        limit: numberInput(input.limit, args[1], 50),
      }),
      renderText: (result) => renderTable("Skill Candidates", result, [
        ["ID", (item) => shortId(item.id)],
        ["Name", "name"],
        ["Status", "status"],
        ["Type", "proposalType"],
        ["Score", (item) => formatNumber(item.score, 3)],
        ["Freq", "frequency"],
      ]),
    },
    {
      name: "providers",
      aliases: ["provider.list"],
      description: "List model providers.",
      permission: "read",
      inputSchema: { args: [], examples: ["providers"] },
      run: () => runtime.listProviders(),
      renderText: (result) => renderTable("Providers", result, [
        ["ID", "id"],
        ["Type", "type"],
        ["Model", "model"],
        ["Enabled", (item) => item.enabled === false ? "false" : "true"],
      ]),
    },
    {
      name: "provider.health",
      aliases: ["providers.health"],
      description: "Check provider health.",
      permission: "read",
      inputSchema: {
        args: ["[--deep]"],
        examples: ["provider.health --deep"],
        properties: { deep: "boolean" },
      },
      permissionForInput: ({ args, input }) => wantsDeepProviderCheck(input, args) ? "danger" : "read",
      run: ({ args, input }) => runtime.checkProviders({ deep: input.deep === true || args.includes("--deep") || args.includes("deep") }),
      renderText: (result) => renderTable("Provider Health", result, [
        ["ID", "id"],
        ["Status", "status"],
        ["Latency", (item) => item.latencyMs === undefined ? "" : `${item.latencyMs}ms`],
        ["Error", "error"],
      ]),
    },
    {
      name: "provider.usage",
      aliases: ["providers.usage"],
      description: "Summarize provider usage.",
      permission: "read",
      inputSchema: {
        args: ["[providerId]"],
        examples: ["provider.usage main"],
        properties: { since: "string", until: "string", providerId: "string", limit: "number" },
      },
      run: ({ args, input }) => runtime.providerUsage({
        since: dateInput(input.since),
        until: dateInput(input.until),
        providerId: stringOptional(input.providerId) || args[0],
        limit: numberInput(input.limit, undefined, 20),
      }),
      renderText: (result) => renderProviderUsage(result),
    },
    {
      name: "settings.get",
      aliases: ["settings", "config.get"],
      description: "Return persisted runtime settings.",
      permission: "read",
      inputSchema: { args: [], examples: ["settings.get"] },
      run: () => runtime.getSettings(),
      renderText: (result) => renderJson(result),
    },
    {
      name: "roles",
      aliases: ["role.list"],
      description: "List agent roles.",
      permission: "read",
      inputSchema: { args: [], examples: ["roles"] },
      run: () => runtime.listRoles(),
      renderText: (result) => renderTable("Roles", result, [
        ["Name", "name"],
        ["Provider", "provider"],
        ["Model", "model"],
        ["Tools", (item) => Array.isArray(item.allowedTools) ? item.allowedTools.join(",") : ""],
        ["Skills", (item) => Array.isArray(item.skills) ? item.skills.join(",") : ""],
      ]),
    },
    {
      name: "experiences.recall",
      aliases: ["experience.list", "experience.recall"],
      description: "List or search active experiences.",
      permission: "read",
      inputSchema: {
        args: ["[query]"],
        examples: ["experiences.recall planner timeout"],
        properties: { q: "string", query: "string", limit: "number" },
      },
      run: ({ args, input }) => runtime.recallExperiences(stringOptional(input.q) || stringOptional(input.query) || args.join(" "), {
        limit: numberInput(input.limit, undefined, 8),
      }),
      renderText: (result) => renderTable("Experiences", result, [
        ["Topic", (item) => item.topicKey || item.id],
        ["Type", "type"],
        ["Score", (item) => item.score === undefined ? "" : formatNumber(item.score, 3)],
        ["Summary", (item) => item.summary || item.problemPattern || ""],
      ]),
    },
    {
      name: "timeline.get",
      aliases: ["timeline"],
      description: "Return or render a run timeline.",
      permission: "read",
      inputSchema: {
        args: ["<runId>"],
        examples: ["timeline.get run_123"],
        required: ["runId"],
        properties: { runId: "string" },
      },
      run: ({ args, input, format }) => {
        const runId = stringInput(input.runId, args[0], "runId");
        return format === "text" ? runtime.renderTimeline(runId) : runtime.getTimeline({ runId });
      },
      renderText: (result) => typeof result === "string" ? result : JSON.stringify(result, null, 2),
    },
    {
      name: "subagents.list",
      aliases: ["sub", "subagents", "agents.active"],
      description: "List subagents and their currently running tasks.",
      permission: "read",
      inputSchema: {
        args: ["[all]"],
        examples: ["subagents.list", "subagents.list all"],
        properties: { includeIdle: "boolean" },
      },
      run: ({ args, input }) => runtime.listSubagents({
        includeIdle: input.includeIdle === true || args[0] === "all",
      }),
      renderText: renderSubagents,
    },
    {
      name: "task.trace",
      aliases: ["trace", "task-trace"],
      description: "Return a task trace.",
      permission: "read",
      inputSchema: {
        args: ["<taskId>"],
        examples: ["task.trace task_123"],
        required: ["taskId"],
        properties: { taskId: "string" },
      },
      run: ({ args, input }) => runtime.getTaskTrace(stringInput(input.taskId, args[0], "taskId")),
      renderText: (result) => renderJson(result),
    },
    {
      name: "diagnostics.run",
      aliases: ["diagnostics"],
      description: "Run diagnostics without repairs.",
      permission: "read",
      inputSchema: { args: [], examples: ["diagnostics.run"] },
      run: () => runtime.diagnostics({ repair: false }),
      renderText: (result) => renderDiagnostics(result),
    },
    {
      name: "security.audit",
      aliases: ["audit"],
      description: "Run security audit.",
      permission: "read",
      inputSchema: { args: [], examples: ["security.audit"] },
      run: () => runtime.securityAudit(),
      renderText: (result) => renderSecurityAudit(result),
    },
    {
      name: "context.build",
      aliases: ["context"],
      description: "Build context for a query.",
      permission: "read",
      inputSchema: {
        args: ["<query>"],
        examples: ["context.build planner"],
        properties: { query: "string", sessionId: "string", runId: "string", role: "string", mode: "string" },
      },
      run: ({ args, input }) => runtime.buildContext({
        query: stringOptional(input.query) || args.join(" "),
        sessionId: stringOptional(input.sessionId),
        runId: typeof input.runId === "string" ? input.runId : null,
        role: stringOptional(input.role),
        mode: input.mode === "deep" ? "deep" : "active",
      }),
      renderText: (result) => renderContext(result),
    },
    {
      name: "router.route",
      aliases: ["route"],
      description: "Route an input to likely agent capabilities.",
      permission: "read",
      inputSchema: {
        args: ["<input>"],
        examples: ["router.route fix test"],
        properties: { input: "string", message: "string" },
      },
      run: ({ args, input }) => runtime.routeMessage(stringOptional(input.input) || stringOptional(input.message) || args.join(" ")),
      renderText: (result) => renderRoute(result),
    },
  ];
}

function graphCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "dag.list",
      aliases: ["dag.roots", "graph.roots"],
      description: "List recent DAG roots, including queued/running roots.",
      permission: "read",
      inputSchema: {
        args: ["[active|all]", "[limit]"],
        examples: ["dag.list", "dag.list active", "dag.list all 20"],
      },
      run: ({ args, input }) => {
        const mode = stringOptional(input.mode) || args[0] || "";
        const activeOnly = input.activeOnly === true || mode === "active" || mode === "running";
        const limitArg = mode === "active" || mode === "all" || mode === "recent" || mode === "running" ? args[1] : args[0];
        return runtime.listTaskMindMapRoots({
          activeOnly,
          limit: numberInput(input.limit, limitArg, 20),
        });
      },
      renderText: (result) => renderTaskMindMapRootList(result as Parameters<typeof renderTaskMindMapRootList>[0]),
    },
    {
      name: "graph.view",
      aliases: ["graph", "mindmap", "task-graph", "dag.view"],
      description: "Render the task DAG as a mind-map tree.",
      permission: "read",
      inputSchema: {
        args: ["<runId>"],
        examples: ["graph.view run_123", "mindmap run_123"],
        required: ["runId"],
        properties: { runId: "string" },
      },
      run: ({ args, input }) => runtime.getTaskMindMap(stringInput(input.runId, args[0], "runId")),
      renderText: (result) => renderTaskMindMap(result as Parameters<typeof renderTaskMindMap>[0]),
    },
    {
      name: "graph.node",
      aliases: ["node", "task-node"],
      description: "Inspect one task graph node by graph key or task id.",
      permission: "read",
      inputSchema: {
        args: ["<runId>", "<selector>"],
        examples: ["graph.node run_123 implementation", "node run_123 7a1b2c"],
        required: ["runId", "selector"],
        properties: { runId: "string", selector: "string" },
      },
      run: ({ args, input }) => runtime.getTaskMindMapNode(
        stringInput(input.runId, args[0], "runId"),
        stringInput(input.selector, args[1], "selector"),
      ),
      renderText: (result) => renderTaskMindMapNode(result as Parameters<typeof renderTaskMindMapNode>[0]),
    },
    {
      name: "graph.add",
      aliases: ["graph-add", "node-add"],
      description: "Add a child node under an unexecuted task graph branch.",
      permission: "write",
      inputSchema: {
        args: ["<runId>", "<parent>", "<key>", "<role>", "<title>"],
        examples: ["graph.add run_123 architecture api_slice developer 'API slice'"],
        required: ["runId", "parent", "role", "title"],
        properties: {
          runId: "string",
          parent: "string",
          key: "string",
          role: "string",
          title: "string",
          input: "string",
          dependsOn: "array",
          dependencyType: "string",
          acceptanceCriteria: "array",
          toolHints: "array",
          skillHints: "array",
          timeoutMs: "number",
          maxRetries: "number",
          metadata: "object",
        },
      },
      run: ({ args, input }) => runtime.addTaskMindMapNode({
        runId: stringInput(input.runId, args[0], "runId"),
        parent: stringInput(input.parent, args[1], "parent"),
        key: stringOptional(input.key) || args[2],
        role: stringInput(input.role, args[3], "role"),
        title: stringInput(input.title, args.slice(4).join(" "), "title"),
        input: stringOptional(input.input) || stringInput(input.title, args.slice(4).join(" "), "title"),
        dependsOn: stringArrayInput(input.dependsOn),
        dependencyType: input.dependencyType === "finished" ? "finished" : "success",
        acceptanceCriteria: stringArrayInput(input.acceptanceCriteria),
        toolHints: stringArrayInput(input.toolHints),
        skillHints: stringArrayInput(input.skillHints),
        timeoutMs: numberOptional(input.timeoutMs),
        maxRetries: numberOptional(input.maxRetries),
        maxResultChars: numberOptional(input.maxResultChars),
        maxMemoryCandidates: numberOptional(input.maxMemoryCandidates),
        expandable: booleanOptional(input.expandable),
        expansionGoal: stringOptional(input.expansionGoal),
        maxExpansionDepth: numberOptional(input.maxExpansionDepth),
        permissionMode: stringOptional(input.permissionMode),
        metadata: objectInput(input.metadata) as Metadata,
      }),
      renderText: (result) => renderTaskMindMapNode((result as { node: Parameters<typeof renderTaskMindMapNode>[0] }).node),
    },
    {
      name: "graph.add_before",
      aliases: ["graph-add-before", "node-add-before"],
      description: "Insert a node before an unexecuted task graph node.",
      permission: "write",
      inputSchema: {
        args: ["<runId>", "<selector>", "<key>", "<role>", "<title>"],
        examples: ["graph.add_before run_123 implementation prep_slice developer 'Prepare inputs'"],
        required: ["runId", "selector", "role", "title"],
        properties: {
          runId: "string",
          selector: "string",
          key: "string",
          role: "string",
          title: "string",
          input: "string",
          acceptanceCriteria: "array",
          toolHints: "array",
          skillHints: "array",
          metadata: "object",
        },
      },
      run: ({ args, input }) => runtime.addTaskMindMapNodeBefore(siblingInput(input, args)),
      renderText: (result) => renderTaskMindMapNode((result as { node: Parameters<typeof renderTaskMindMapNode>[0] }).node),
    },
    {
      name: "graph.add_after",
      aliases: ["graph-add-after", "node-add-after"],
      description: "Insert a node after an unexecuted task graph node.",
      permission: "write",
      inputSchema: {
        args: ["<runId>", "<selector>", "<key>", "<role>", "<title>"],
        examples: ["graph.add_after run_123 implementation polish_slice developer 'Polish result'"],
        required: ["runId", "selector", "role", "title"],
        properties: {
          runId: "string",
          selector: "string",
          key: "string",
          role: "string",
          title: "string",
          input: "string",
          acceptanceCriteria: "array",
          toolHints: "array",
          skillHints: "array",
          metadata: "object",
        },
      },
      run: ({ args, input }) => runtime.addTaskMindMapNodeAfter(siblingInput(input, args)),
      renderText: (result) => renderTaskMindMapNode((result as { node: Parameters<typeof renderTaskMindMapNode>[0] }).node),
    },
    {
      name: "graph.update",
      aliases: ["graph-update", "node-update"],
      description: "Update an unexecuted task graph node.",
      permission: "write",
      inputSchema: {
        args: ["<runId>", "<selector>"],
        examples: ["graph.update run_123 implementation -- input='Narrow this slice'"],
        required: ["runId", "selector"],
        properties: {
          runId: "string",
          selector: "string",
          role: "string",
          title: "string",
          input: "string",
          dependsOn: "array",
          dependencyType: "string",
          acceptanceCriteria: "array",
          toolHints: "array",
          skillHints: "array",
          timeoutMs: "number",
          maxRetries: "number",
          reopenBlocked: "boolean",
          metadata: "object",
        },
      },
      run: ({ args, input }) => runtime.updateTaskMindMapNode({
        runId: stringInput(input.runId, args[0], "runId"),
        selector: stringInput(input.selector, args[1], "selector"),
        role: stringOptional(input.role),
        title: stringOptional(input.title),
        input: stringOptional(input.input),
        dependsOn: stringArrayInput(input.dependsOn),
        dependencyType: input.dependencyType === "finished" ? "finished" : "success",
        acceptanceCriteria: stringArrayInput(input.acceptanceCriteria),
        toolHints: stringArrayInput(input.toolHints),
        skillHints: stringArrayInput(input.skillHints),
        timeoutMs: numberOptional(input.timeoutMs),
        maxRetries: numberOptional(input.maxRetries),
        maxResultChars: numberOptional(input.maxResultChars),
        maxMemoryCandidates: numberOptional(input.maxMemoryCandidates),
        expandable: booleanOptional(input.expandable),
        expansionGoal: stringOptional(input.expansionGoal),
        maxExpansionDepth: numberOptional(input.maxExpansionDepth),
        reopenBlocked: booleanOptional(input.reopenBlocked),
        metadata: objectInput(input.metadata) as Metadata,
      }),
      renderText: (result) => renderTaskMindMapNode((result as { node: Parameters<typeof renderTaskMindMapNode>[0] }).node),
    },
    {
      name: "graph.delete",
      aliases: ["graph-del", "node-delete", "node-del"],
      description: "Delete an unexecuted task graph node and its unexecuted children.",
      permission: "write",
      inputSchema: {
        args: ["<runId>", "<selector>"],
        examples: ["graph.delete run_123 implementation"],
        required: ["runId", "selector"],
        properties: { runId: "string", selector: "string", reason: "string" },
      },
      run: ({ args, input }) => runtime.deleteTaskMindMapNode({
        runId: stringInput(input.runId, args[0], "runId"),
        selector: stringInput(input.selector, args[1], "selector"),
        reason: stringOptional(input.reason),
      }),
      renderText: (result) => `Deleted: ${((result as { deleted?: string[] }).deleted || []).join(", ") || "(none)"}`,
    },
  ];
}

function sessionCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "session.list",
      aliases: ["sessions.list"],
      description: "List sessions.",
      permission: "read",
      inputSchema: {
        args: ["[status]"],
        examples: ["session.list active", "sessions.list hidden"],
        properties: { status: "string", includeHidden: "boolean", includeTrashed: "boolean", includeDeleted: "boolean", limit: "number" },
      },
      run: ({ args, input }) => runtime.listSessions({
        status: parseSessionStatus(input.status ?? args[0]),
        includeHidden: input.includeHidden === true,
        includeTrashed: input.includeTrashed === true,
        includeDeleted: input.includeDeleted === true,
        limit: numberInput(input.limit, undefined, 50),
      }),
      renderText: (result) => renderTable("Sessions", result, [
        ["ID", (item) => shortId(item.id, 12)],
        ["Title", "title"],
        ["Status", "status"],
        ["Runs", "runCount"],
        ["Last Active", (item) => item.lastActiveAt || item.updatedAt || ""],
        ["Delete After", "deleteAfter"],
      ]),
    },
    {
      name: "session.messages",
      aliases: ["messages"],
      description: "List session messages.",
      permission: "read",
      inputSchema: {
        args: ["<sessionId>", "[limit]"],
        examples: ["session.messages sess_123 40"],
        required: ["sessionId"],
        properties: { sessionId: "string", limit: "number" },
      },
      run: ({ args, input }) => runtime.listSessionMessages({
        sessionId: stringInput(input.sessionId, args[0], "sessionId"),
        limit: numberInput(input.limit, args[1], 100),
      }),
      renderText: (result) => renderSessionMessages(result),
    },
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
      renderText: (result) => result ? renderKeyValues("Latest Session", result) : "No resumable session.",
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
      renderText: (result) => renderKeyValues("Session Compaction Preview", result),
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
      renderText: (result) => renderSessionUsage(result),
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
      renderText: (result) => renderKeyValues("Created Session", result),
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
      renderText: (result) => renderClearSession(result),
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
      renderText: (result) => renderKeyValues("Restored Session", result),
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
      renderText: (result) => renderKeyValues("Trashed Session", result),
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
      renderText: (result) => renderKeyValues("Provider Added", result),
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
      permissionForInput: ({ input }) => roleDefinitionPermission(input),
      run: ({ input }) => runtime.addRole({
        name: requiredString(input.name, "name"),
        role: requiredString(input.role, "role"),
        provider: stringOptional(input.provider),
        model: stringOptional(input.model),
        temperature: typeof input.temperature === "number" ? input.temperature : undefined,
        allowedTools: toolPermissionArray(input.allowedTools),
        forbiddenTools: toolPermissionArray(input.forbiddenTools),
        capabilities: stringArray(input.capabilities),
        skills: stringArray(input.skills),
        skillAllowlist: stringArray(input.skillAllowlist),
        outputContract: stringOptional(input.outputContract),
        instructions: requiredString(input.instructions, "instructions"),
      }),
      renderText: (result) => renderKeyValues("Role Saved", result),
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
      renderText: (result) => renderKeyValues("Role Provider Updated", result),
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
      renderText: (result) => renderTable("Default Roles", result, [
        ["Name", "name"],
        ["Provider", "provider"],
        ["Model", "model"],
      ]),
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
      renderText: (result) => renderSkillCandidateBuild(result),
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
      renderText: (result) => renderKeyValues("Skill Candidate Approved", result),
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
      renderText: (result) => renderKeyValues("Skill Candidate Rejected", result),
    },
  ];
}

function runtimeControlCommands(runtime: CommandRuntime): RuntimeCommand[] {
  return [
    {
      name: "settings.update",
      aliases: ["config.update"],
      description: "Update persisted runtime settings.",
      permission: "write",
      inputSchema: {
        args: [],
        examples: ['settings.update {"fallbackMode":"fallback"}'],
        properties: {
          defaultProviderId: "string",
          fallbackMode: "string",
          toolCallTimeoutSeconds: "number",
          agents: "object",
          providers: "array",
        },
      },
      run: ({ input }) => runtime.updateSettings(input),
      renderText: (result) => renderJson(result),
    },
    {
      name: "diagnostics.repair",
      aliases: ["repair-diagnostics"],
      description: "Run diagnostics in repair mode.",
      permission: "write",
      inputSchema: { args: [], examples: ["diagnostics.repair"] },
      run: () => runtime.diagnostics({ repair: true }),
      renderText: (result) => renderDiagnostics(result),
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
      renderText: (result) => renderMaintenance(result),
    },
    {
      name: "experiences.build_daily",
      aliases: ["build-daily-experiences"],
      description: "Build daily experience records from task history.",
      permission: "write",
      inputSchema: {
        args: [],
        examples: ["experiences.build_daily"],
        properties: { day: "string" },
      },
      run: ({ input }) => runtime.buildDailyExperiences({
        day: dateInput(input.day) || new Date(),
      }),
      renderText: (result) => renderKeyValues("Daily Experiences", result),
    },
    {
      name: "experiences.feedback",
      aliases: ["experience-feedback"],
      description: "Add feedback to an experience.",
      permission: "write",
      inputSchema: {
        args: ["<experienceId>", "<rating>"],
        examples: ["experiences.feedback exp_123 useful"],
        required: ["experienceId", "rating"],
        properties: { experienceId: "string", rating: "string", comment: "string" },
      },
      run: ({ args, input }) => runtime.addExperienceFeedback({
        experienceId: stringInput(input.experienceId, args[0], "experienceId"),
        rating: parseFeedbackRating(input.rating ?? args[1]),
        comment: stringOptional(input.comment),
      }),
      renderText: (result) => renderKeyValues("Experience Feedback", result),
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
      renderText: (result) => renderKeyValues("Task Cancelled", result),
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
      renderText: (result) => renderKeyValues("Run Cancelled", result),
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
      permissionForInput: ({ args, input }) => toolExecutionPermission(input, args),
      run: ({ args, input }) => runtime.executeTool({
        tool: stringInput(input.tool, args[0], "tool"),
        args: objectInput(input.args),
        approval: objectInput(input.approval) as ToolApproval,
        role: stringOptional(input.role),
        permissionMode: input.permissionMode,
        taskId: stringOptional(input.taskId),
        runId: stringOptional(input.runId),
        sessionId: stringOptional(input.sessionId),
      }),
      renderText: (result) => renderToolExecution(result),
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
    renderText: (result) => renderKeyValues(description.replace(/\.$/, ""), result),
  };
}

function simpleCronCommand(
  runtime: CommandRuntime,
  name: string,
  aliases: string[],
  description: string,
  handler: (runtime: CommandRuntime, id: string) => Promise<unknown>,
  renderText: (result: unknown) => string = (result) => renderCronJobs([result]),
): RuntimeCommand {
  return {
    name,
    aliases,
    description,
    permission: "write",
    inputSchema: {
      args: ["<id>"],
      examples: [`${name} cron_123`],
      required: ["id"],
      properties: { id: "string" },
    },
    run: ({ args, input }) => handler(runtime, stringInput(input.id, args[0], "id")),
    renderText,
  };
}

function validateInput(command: RuntimeCommand, input: Record<string, unknown>, args: string[]): void {
  const positionalArgs = requiredPositionalArgs(command.inputSchema.args);
  for (const key of command.inputSchema.required || []) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      const position = positionalArgs.indexOf(key);
      if (position >= 0 && typeof args[position] === "string" && args[position].trim()) continue;
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

function assertCommandPermission(
  command: RuntimeCommand,
  maxPermission: CommandPermission,
  invocation: { args: string[]; input: Record<string, unknown>; format: "json" | "text" },
): void {
  const requiredPermission = command.permissionForInput?.(invocation) || command.permission;
  if (permissionRank(requiredPermission) <= permissionRank(maxPermission)) return;
  throw new CommandPermissionError(`Command ${command.name} requires ${requiredPermission} permission; caller is limited to ${maxPermission}.`);
}

function permissionRank(permission: CommandPermission): number {
  if (permission === "danger") return 2;
  if (permission === "write") return 1;
  return 0;
}

function wantsDeepProviderCheck(input: Record<string, unknown>, args: string[]): boolean {
  return input.deep === true || args.includes("--deep") || args.includes("deep");
}

function roleDefinitionPermission(input: Record<string, unknown>): CommandPermission {
  return toolsNeedDanger(stringArrayInput(input.allowedTools) || []) ? "danger" : "write";
}

function toolExecutionPermission(input: Record<string, unknown>, args: string[] = []): CommandPermission {
  const toolName = typeof input.tool === "string" ? input.tool : args[0] || "";
  const definition = toolName ? COMMAND_TOOL_REGISTRY.resolve(toolName) : null;
  if (input.permissionMode === "danger_full_access") return "danger";
  if (hasClientSuppliedApproval(input.approval)) return "danger";
  if (!definition) return "write";
  return toolNeedsDanger(definition.name) ? "danger" : "write";
}

function toolsNeedDanger(tools: string[]): boolean {
  return tools.some((tool) => {
    const definition = COMMAND_TOOL_REGISTRY.resolve(tool);
    return Boolean(definition && toolNeedsDanger(definition.name));
  });
}

function toolNeedsDanger(toolName: string): boolean {
  const definition = COMMAND_TOOL_REGISTRY.resolve(toolName);
  return Boolean(definition && (definition.requiresApproval || definition.sideEffects === "destructive"));
}

function hasClientSuppliedApproval(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}

function requiredPositionalArgs(args: string[]): string[] {
  return args
    .map((arg) => arg.match(/^<([^>]+)>$/)?.[1])
    .filter((arg): arg is string => Boolean(arg));
}

function wantsRepair(input: Record<string, unknown>, args: string[]): boolean {
  return input.repair === true || args.includes("--repair") || args.includes("repair");
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

type ColumnSpec = [string, string | ((item: Record<string, unknown>) => unknown)];

function renderJson(result: unknown): string {
  return JSON.stringify(result, null, 2);
}

function renderKeyValues(title: string, result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return `${title}\n${String(result ?? "")}`;
  const lines = [title];
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (value && typeof value === "object") continue;
    lines.push(`${key}: ${formatCell(value)}`);
  }
  return lines.join("\n");
}

function renderTable(title: string, result: unknown, columns: ColumnSpec[]): string {
  const rows = asRecordArray(result);
  if (!rows.length) return `${title}\n(no rows)`;
  const table = [
    columns.map(([label]) => label),
    ...rows.map((row) => columns.map(([, getter]) => formatCell(typeof getter === "function" ? getter(row) : row[getter]))),
  ];
  return `${title}\n${formatTable(table)}`;
}

function renderProviderUsage(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const usage = result as {
    totals?: { calls?: number; success?: number; totalTokens?: number; costUsd?: number };
    providers?: unknown[];
    recent?: unknown[];
  };
  return [
    "Provider Usage",
    `calls: ${usage.totals?.calls || 0}`,
    `success: ${usage.totals?.success || 0}`,
    `tokens: ${usage.totals?.totalTokens || 0}`,
    `costUsd: ${formatNumber(usage.totals?.costUsd, 6)}`,
    "",
    renderTable("By Provider", usage.providers || [], [
      ["Provider", "providerId"],
      ["Model", "model"],
      ["Calls", "calls"],
      ["Tokens", "totalTokens"],
      ["Cost", (item) => formatNumber(item.costUsd, 6)],
      ["Blocked", "blocked"],
    ]),
  ].join("\n");
}

function renderSubagents(result: unknown): string {
  return renderTable("Subagents", result, [
    ["Subagent", "agentId"],
    ["Role", "configuredRole"],
    ["Status", "status"],
    ["Task", (item) => shortId(item.taskId)],
    ["Task Role", "taskRole"],
    ["Title", (item) => truncate(String(item.taskTitle || ""), 48)],
    ["Run", (item) => shortId(item.runId)],
  ]);
}

function renderSessionMessages(result: unknown): string {
  const messages = asRecordArray(result);
  if (!messages.length) return "Messages\n(no messages)";
  return [
    "Messages",
    ...messages.map((message) => {
      const role = message.role === "user" ? "You" : String(message.role || "assistant");
      const run = typeof message.runId === "string" && message.runId ? ` ${shortId(message.runId, 8)}` : "";
      return `[${role}${run}] ${formatCell(message.content)}`;
    }),
  ].join("\n");
}

function renderSessionUsage(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const usage = result as { sessionId?: string; runIds?: unknown[]; providerUsage?: unknown };
  return [
    `Session Usage: ${usage.sessionId || ""}`,
    `runs: ${Array.isArray(usage.runIds) ? usage.runIds.length : 0}`,
    renderProviderUsage(usage.providerUsage || {}),
  ].join("\n");
}

function renderClearSession(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as { hidden?: { id?: string } | null; next?: { id?: string } | null };
  return [
    "Session Cleared",
    `hidden: ${value.hidden?.id || "(none)"}`,
    `next: ${value.next?.id || "(none)"}`,
  ].join("\n");
}

function renderDiagnostics(result: unknown): string {
  const items = asRecordArray(result);
  if (!items.length) return "Diagnostics\n(no anomalies)";
  return renderTable("Diagnostics", items, [
    ["Code", "code"],
    ["Severity", "severity"],
    ["Repaired", (item) => item.repaired === true ? "yes" : "no"],
    ["Message", "message"],
  ]);
}

function renderSecurityAudit(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const audit = result as { status?: string; summary?: Record<string, unknown>; findings?: unknown[] };
  return [
    `Security Audit: ${audit.status || "unknown"}`,
    renderKeyValues("Summary", audit.summary || {}),
    renderTable("Findings", audit.findings || [], [
      ["Severity", "severity"],
      ["Code", "code"],
      ["Message", "message"],
    ]),
  ].join("\n");
}

function renderContext(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const context = result as {
    metadata?: Record<string, unknown>;
    sessionMessages?: unknown[];
    memory?: { shortTerm?: unknown[]; files?: unknown[]; experiences?: unknown[] };
  };
  return [
    "Context",
    `mode: ${formatCell(context.metadata?.mode)}`,
    `sessionMessages: ${context.sessionMessages?.length || 0}`,
    `shortMemory: ${context.memory?.shortTerm?.length || 0}`,
    `fileMemory: ${context.memory?.files?.length || 0}`,
    `experiences: ${context.memory?.experiences?.length || 0}`,
  ].join("\n");
}

function renderRoute(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const route = result as { selectedRoles?: unknown[]; capabilities?: unknown[]; reason?: string };
  return [
    "Route",
    `roles: ${Array.isArray(route.selectedRoles) ? route.selectedRoles.join(", ") : ""}`,
    `capabilities: ${Array.isArray(route.capabilities) ? route.capabilities.join(", ") : ""}`,
    `reason: ${route.reason || ""}`,
  ].join("\n");
}

function renderSkillCandidateBuild(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as { created?: unknown[]; updated?: unknown[]; skipped?: unknown[] };
  return [
    "Skill Candidate Build",
    `created: ${Array.isArray(value.created) ? value.created.length : 0}`,
    `updated: ${Array.isArray(value.updated) ? value.updated.length : 0}`,
    `skipped: ${Array.isArray(value.skipped) ? value.skipped.length : 0}`,
  ].join("\n");
}

function renderMaintenance(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as Record<string, unknown>;
  return [
    "Maintenance",
    ...Object.entries(value).map(([key, item]) => `${key}: ${formatCell(item)}`),
  ].join("\n");
}

function renderToolExecution(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as { tool?: string; ok?: boolean; durationMs?: number; error?: string; output?: unknown };
  return [
    `Tool Execution: ${value.tool || ""}`,
    `ok: ${value.ok === true}`,
    `durationMs: ${value.durationMs ?? ""}`,
    value.error ? `error: ${value.error}` : "",
    value.output === undefined ? "" : `output: ${formatCell(value.output)}`,
  ].filter(Boolean).join("\n");
}

function renderCronJobs(result: unknown): string {
  return renderTable("Cron Jobs", Array.isArray(result) ? result : [result], [
    ["ID", (item) => shortId(item.id)],
    ["Name", "name"],
    ["Schedule", "schedule"],
    ["Status", "status"],
    ["Action", (item) => actionSummary(item.action)],
    ["Next", "nextRunAt"],
    ["Runs", "runCount"],
    ["Errors", "errorCount"],
  ]);
}

function renderCronRun(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as { ok?: boolean; manual?: boolean; error?: string; job?: Record<string, unknown> };
  return [
    `Cron Run: ${formatCell(value.job?.name || value.job?.id)}`,
    `ok: ${value.ok === true}`,
    `manual: ${value.manual === true}`,
    value.error ? `error: ${value.error}` : "",
    value.job ? renderCronJobs([value.job]) : "",
  ].filter(Boolean).join("\n");
}

function actionSummary(action: unknown): string {
  if (!action || typeof action !== "object" || Array.isArray(action)) return "";
  const value = action as Record<string, unknown>;
  if (value.type === "command") return `command:${formatCell(value.command)}`;
  if (value.type === "chat") return `chat:${formatCell(value.sessionId)}`;
  return formatCell(value.type);
}

function asRecordArray(result: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(result)) return [];
  return result.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function formatTable(rows: string[][]): string {
  const widths = rows[0].map((_, index) => Math.min(36, Math.max(...rows.map((row) => visibleLength(row[index] || "")))));
  return rows.map((row, rowIndex) => {
    const line = row.map((cell, index) => pad(truncate(String(cell || ""), widths[index]), widths[index])).join("  ");
    if (rowIndex === 0) return `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}`;
    return line;
  }).join("\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(formatCell).join(",");
  return JSON.stringify(value);
}

function formatNumber(value: unknown, digits: number): string {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(digits) : "";
}

function shortId(value: unknown, length = 8): string {
  return typeof value === "string" ? value.slice(0, length) : "";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function visibleLength(value: string): number {
  return value.length;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

function stringInput(input: unknown, arg: string | undefined, label: string): string {
  return requiredString(input ?? arg, label);
}

function siblingInput(input: Record<string, unknown>, args: string[]): TaskGraphNodeSiblingInput {
  const title = stringOptional(input.title) || args.slice(4).join(" ").trim();
  return {
    runId: stringInput(input.runId, args[0], "runId"),
    selector: stringInput(input.selector, args[1], "selector"),
    key: stringOptional(input.key) || args[2],
    role: stringOptional(input.role) || args[3],
    title: stringInput(title, undefined, "title"),
    input: stringOptional(input.input) || title,
    dependsOn: stringArrayInput(input.dependsOn),
    dependencyType: input.dependencyType === "finished" ? "finished" : "success",
    acceptanceCriteria: stringArrayInput(input.acceptanceCriteria),
    toolHints: stringArrayInput(input.toolHints),
    skillHints: stringArrayInput(input.skillHints),
    timeoutMs: numberOptional(input.timeoutMs),
    maxRetries: numberOptional(input.maxRetries),
    maxResultChars: numberOptional(input.maxResultChars),
    maxMemoryCandidates: numberOptional(input.maxMemoryCandidates),
    expandable: booleanOptional(input.expandable),
    expansionGoal: stringOptional(input.expansionGoal),
    maxExpansionDepth: numberOptional(input.maxExpansionDepth),
    permissionMode: stringOptional(input.permissionMode),
    metadata: objectInput(input.metadata) as Metadata,
  };
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

function numberOptional(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanOptional(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeDatedOptions(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...input,
    ...(typeof input.day === "string" && input.day.trim() ? { day: dateInput(input.day) } : {}),
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

function toolPermissionArray(value: unknown): ToolPermission[] | undefined {
  const tools = stringArray(value);
  if (!tools) return undefined;
  return tools.map((tool) => {
    const definition = COMMAND_TOOL_REGISTRY.resolve(tool);
    if (!definition) throw new Error(`Unknown tool: ${tool}`);
    return definition.name;
  });
}

function stringArrayInput(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
  return undefined;
}

function parseProviderType(value: unknown): "echo" | "openai" | "ollama" {
  if (value === "echo" || value === "openai" || value === "ollama") return value;
  throw new Error("provider type must be echo, openai, or ollama");
}

function parseSkillCandidateStatus(value: unknown): "proposed" | "approved" | "merged" | "rejected" | undefined {
  if (!value) return undefined;
  if (value === "proposed" || value === "approved" || value === "merged" || value === "rejected") return value;
  throw new Error("skill candidate status must be proposed, approved, merged, or rejected");
}

function parseSessionStatus(value: unknown): "active" | "hidden" | "trashed" | "deleted" | undefined {
  if (!value) return undefined;
  if (value === "active" || value === "hidden" || value === "trashed" || value === "deleted") return value;
  if (value === "trash") return "trashed";
  throw new Error("session status must be active, hidden, trashed, or deleted");
}

function parseFeedbackRating(value: unknown): "useful" | "wrong" | "outdated" | "duplicate" {
  if (value === "useful" || value === "wrong" || value === "outdated" || value === "duplicate") return value;
  throw new Error("experience feedback rating must be useful, wrong, outdated, or duplicate");
}

function dateInput(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}
