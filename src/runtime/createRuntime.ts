import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MainAgent } from "../agents/MainAgent.ts";
import { createCommandRegistry, type CommandPermission } from "../commands/CommandRegistry.ts";
import { ContextEngine } from "../context/ContextEngine.ts";
import { CronScheduler, type CronJobInput } from "../cron/CronScheduler.ts";
import { ExperienceBuilder } from "../experience/ExperienceBuilder.ts";
import { ExperienceStore } from "../experience/ExperienceStore.ts";
import { GATEWAY_METHODS } from "../gateway/GatewayProtocol.ts";
import type { ModelProvider, ProviderConfig, ProviderFallbackMode } from "../llm/ModelProvider.ts";
import { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import { ProviderUsageStore } from "../llm/ProviderUsageStore.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import type { VectorStoreConfig } from "../memory/VectorStoreAdapter.ts";
import { AgentRouter } from "../routing/AgentRouter.ts";
import { RoleManager } from "../roles/RoleManager.ts";
import { runSecurityAudit } from "../security/SecurityAudit.ts";
import { SkillBuilder } from "../skills/SkillBuilder.ts";
import { SkillCandidateStore } from "../skills/SkillCandidateStore.ts";
import { defaultSkillDirs, SkillRegistry } from "../skills/SkillRegistry.ts";
import { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.ts";
import { ToolExecutor, type ToolApproval } from "../tools/ToolExecutor.ts";
import { parsePermissionMode } from "../tools/PermissionMode.ts";
import { renderTimeline } from "../timeline/renderTimeline.ts";
import { buildDoctorReport } from "./Doctor.ts";
import { LifecycleHooks, type LifecycleHookHandler, type LifecycleHookName } from "./LifecycleHooks.ts";
import {
  exportSession as exportSessionData,
  previewSessionCompaction as previewSessionCompactionData,
  resumeLatestSession as resumeLatestSessionData,
  sessionUsage as sessionUsageData,
} from "./SessionOps.ts";

export async function createRuntime(options: {
  dataDir?: string;
  roleDir?: string;
  model?: ModelProvider;
  providers?: ProviderConfig[];
  defaultProviderId?: string;
  providerFallbackMode?: ProviderFallbackMode;
  mainProviderId?: string;
  workerPath?: string;
  skillDir?: string;
  skillDirs?: string[];
  vectorStore?: VectorStoreConfig;
  enableCron?: boolean;
} = {}) {
  const dataDir = options.dataDir || process.env.EMILY_DATA_DIR || path.join(process.cwd(), ".emily");
  const roleDir = options.roleDir || process.env.EMILY_ROLE_DIR || path.join(process.cwd(), "agents");
  const skillDir = options.skillDir || process.env.EMILY_SKILL_DIR || path.join(process.cwd(), "skills");
  const skillDirs = options.skillDirs || defaultSkillDirs(skillDir);
  await mkdir(dataDir, { recursive: true });

  const requestedMainProviderId = options.mainProviderId || options.defaultProviderId;
  if (options.model && !requestedMainProviderId) {
    throw new Error("Injected main model requires mainProviderId/defaultProviderId so subagent fallback is explicit.");
  }
  const providerUsageStore = await ProviderUsageStore.create({ dataDir });
  const providerRegistry = await ProviderRegistry.create({
    dataDir,
    providers: options.providers,
    defaultProviderId: requestedMainProviderId || "echo",
    fallbackMode: options.providerFallbackMode || "strict",
    usageStore: providerUsageStore,
  });
  const mainProviderId = requestedMainProviderId || providerRegistry.defaultProviderId;
  if (options.model && options.model.id !== mainProviderId) {
    throw new Error(`Injected main model id ${options.model.id} must match main provider ${mainProviderId}.`);
  }
  let shouldWriteProviderRegistry = false;
  if (providerRegistry.defaultProviderId !== mainProviderId) {
    providerRegistry.defaultProviderId = mainProviderId;
    providerRegistry.ensureDefault();
    shouldWriteProviderRegistry = true;
  }
  if (options.providerFallbackMode && providerRegistry.fallbackMode !== options.providerFallbackMode) {
    providerRegistry.fallbackMode = options.providerFallbackMode;
    shouldWriteProviderRegistry = true;
  }
  providerRegistry.getConfig(mainProviderId);
  if (shouldWriteProviderRegistry) await providerRegistry.write(dataDir);
  const model = options.model || providerRegistry.createProvider(mainProviderId);
  const memory = await MemorySystem.create({ dataDir, vectorStore: options.vectorStore });
  const taskStore = await TaskStore.create({ dataDir });
  const experienceStore = ExperienceStore.create({ dataDir });
  const toolRegistry = createDefaultToolRegistry();
  const toolExecutor = new ToolExecutor({
    workspaceDir: process.cwd(),
    taskStore,
    registry: toolRegistry,
  });
  const skillRegistry = await SkillRegistry.create({ skillDirs });
  const skillCandidateStore = SkillCandidateStore.create({ dataDir, skillDir });
  const roleManager = new RoleManager({ roleDir, providerRegistry });
  const hooks = new LifecycleHooks();
  const router = new AgentRouter();
  const contextEngine = new ContextEngine({
    memory,
    taskStore,
    experienceStore,
    hooks,
  });
  const experienceBuilder = new ExperienceBuilder({
    taskStore,
    experienceStore,
  });
  const skillBuilder = new SkillBuilder({
    taskStore,
    skillCandidateStore,
    skillRegistry,
  });
  const roleAgentManager = new RoleAgentManager({
    dataDir,
    taskStore,
    workerPath: options.workerPath || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workers", "subagentWorker.ts"),
    roleDir,
    skillDir,
    skillDirs,
    hooks,
  });
  await roleAgentManager.start();

  const mainAgent = new MainAgent({
    name: "emily",
    model,
    memory,
    taskStore,
    experienceStore,
    roleAgentManager,
    contextEngine,
    hooks,
    router,
  });

  async function approvePendingMemoryCandidates({ runId }: { runId?: string } = {}): Promise<{
    approved: number;
    rejected: number;
  }> {
    let approved = 0;
    let rejected = 0;
    for (const candidate of taskStore.getPendingMemoryCandidates({ runId, limit: 100 })) {
      const decision = mainAgent.memoryCandidatePolicy.decide(candidate);
      const decided = taskStore.decidePendingMemoryCandidate(candidate.id, decision);
      if (!decided.changed) continue;
      if (decision === "rejected") {
        rejected += 1;
        continue;
      }
      await memory.remember({
        scope: candidate.scope,
        kind: candidate.kind,
        content: candidate.content,
        metadata: {
          runId: candidate.runId || "",
          taskId: candidate.taskId || "",
          candidateId: candidate.id,
          committedBy: "runtime-maintenance",
        },
      });
      approved += 1;
    }
    return { approved, rejected };
  }

  function health() {
    return {
      ...taskStore.health(),
      activeExperiences: experienceStore.listActive().length,
      proposedSkillCandidates: skillCandidateStore.countByStatus("proposed"),
    };
  }

  function diagnostics(options: { repair?: boolean; emit?: boolean } = {}) {
    return taskStore.diagnostics(options);
  }

  function securityAudit(options: { emit?: boolean } = {}) {
    return runSecurityAudit({
      roleManager,
      providerRegistry,
      toolRegistry,
      skillRegistry,
      taskStore,
      emit: options.emit,
    });
  }

  async function doctor(options: { deep?: boolean; repair?: boolean } = {}) {
    return buildDoctorReport({
      deep: options.deep === true,
      repair: options.repair === true,
      health,
      diagnostics,
      checkProviders: (input) => providerRegistry.health(input),
      securityAudit,
      pendingMemoryCandidates: () => taskStore.getPendingMemoryCandidates({ limit: 1000 }).length,
      vectorMemory: () => memory.vectorHealth(),
      proposedSkillCandidates: () => skillCandidateStore.countByStatus("proposed"),
      sessions: sessionCounts,
      gateway: () => ({
        enabled: true,
        protocolVersion: 1,
        methods: GATEWAY_METHODS.length,
      }),
      maintenance: () => maintenance(),
    });
  }

  function sessionCounts() {
    return {
      active: taskStore.listSessions({ status: "active", limit: 10000 }).length,
      hidden: taskStore.listSessions({ status: "hidden", limit: 10000 }).length,
      trashed: taskStore.listSessions({ status: "trashed", limit: 10000 }).length,
    };
  }

  function resumeLatestSession(options: { includeHidden?: boolean } = {}) {
    return resumeLatestSessionData({
      taskStore,
      includeHidden: options.includeHidden === true,
    });
  }

  function exportSession(sessionId: string, options: { format?: "json" | "markdown" } = {}) {
    return exportSessionData({
      taskStore,
      sessionId,
      format: options.format === "markdown" ? "markdown" : "json",
    });
  }

  function previewSessionCompaction(sessionId: string, options: { maxMessages?: number } = {}) {
    return previewSessionCompactionData({
      taskStore,
      sessionId,
      maxMessages: options.maxMessages,
    });
  }

  function sessionUsage(sessionId: string) {
    return sessionUsageData({
      taskStore,
      sessionId,
      providerUsage: (runIds) => providerUsageStore.summaryForRuns(runIds),
    });
  }

  async function executeTool(input: {
    tool: string;
    args?: Record<string, unknown>;
    approval?: ToolApproval;
    role?: string;
    permissionMode?: unknown;
    taskId?: string;
    runId?: string;
    sessionId?: string;
  }) {
    const task = input.taskId ? taskStore.getTask(input.taskId) : null;
    const roleName = input.role || task?.role || "developer";
    const roleDefinition = await roleManager.getRole(roleName);
    return toolExecutor.execute({
      tool: input.tool,
      args: input.args || {},
      approval: input.approval,
      roleDefinition,
      permissionMode: parsePermissionMode(input.permissionMode ?? task?.metadata.permissionMode),
      task,
      runId: input.runId || (typeof task?.metadata.runId === "string" ? task.metadata.runId : null),
      sessionId: input.sessionId || (typeof task?.metadata.sessionId === "string" ? task.metadata.sessionId : null),
    });
  }

  async function maintenance(options: {
    day?: Date;
    staleRunMs?: number;
    maxEvents?: number;
    pruneMemoryCandidateDays?: number;
    maxFileMemoryRecords?: number;
    maxVectorMemoryRecords?: number;
    pruneArchivedExperienceVectorDays?: number;
    sessionTrashDays?: number;
    skillLookbackDays?: number;
    skillMinOccurrences?: number;
    skillMinScore?: number;
    skillDailyLimit?: number;
  } = {}) {
    const reconcile = await roleAgentManager.reconcile();
    const taskGraphs = taskStore.refreshTaskGraphStatuses();
    const staleRuns = taskStore.recoverStaleRuns({
      olderThanMs: options.staleRunMs ?? 5 * 60 * 1000,
    });
    const anomalies = taskStore.diagnostics({ repair: true });
    const memoryCandidates = await approvePendingMemoryCandidates();
    const experiences = experienceBuilder.buildDailyExperiences({
      day: options.day || new Date(),
    });
    const skillCandidates = skillBuilder.buildSkillCandidates({
      day: options.day || new Date(),
      lookbackDays: options.skillLookbackDays,
      minOccurrences: options.skillMinOccurrences,
      minScore: options.skillMinScore,
      dailyLimit: options.skillDailyLimit,
    });
    const memoryCompaction = await memory.compact({
      maxFileRecords: options.maxFileMemoryRecords,
      maxVectorRecords: options.maxVectorMemoryRecords,
    });
    const experienceIndex = experienceStore.maintenance({
      rebuildVectors: true,
      pruneArchivedVectorDays: options.pruneArchivedExperienceVectorDays,
    });
    const database = taskStore.maintenance({
      maxEvents: options.maxEvents,
      pruneDecidedMemoryCandidatesOlderThanDays: options.pruneMemoryCandidateDays,
    });
    const sessions = {
      archived: taskStore.archiveHiddenSessions({
        deleteAfterDays: options.sessionTrashDays ?? 30,
      }).length,
      pruned: taskStore.pruneTrashedSessions({
        olderThanDays: options.sessionTrashDays ?? 30,
      }),
    };
    return {
      reconcile: {
        expiredLeaseTasks: reconcile.expiredLeaseTasks.length,
        needsInspectionTasks: reconcile.needsInspectionTasks.length,
        unacknowledgedTerminalTasks: reconcile.unacknowledgedTerminalTasks.length,
      },
      taskGraphs: {
        updated: taskGraphs.length,
      },
      staleRuns: {
        recovered: staleRuns.length,
      },
      diagnostics: {
        anomalies: anomalies.length,
        repaired: anomalies.filter((anomaly) => anomaly.repaired).length,
      },
      memoryCandidates,
      experiences,
      skillCandidates,
      memoryCompaction,
      experienceIndex,
      database,
      sessions,
      health: health(),
    };
  }

  async function handleUserMessage(input: string, context: { sessionId?: string; source?: string; permissionMode?: unknown } = {}) {
    const sessionId = context.sessionId || "default";
    const source = context.source || "unknown";
    const permissionMode = parsePermissionMode(context.permissionMode);
    const normalizedInput = String(input || "").trim();
    if (normalizedInput) {
      taskStore.addSessionMessage({
        sessionId,
        role: "user",
        content: normalizedInput,
        metadata: { source, permissionMode },
      });
    }
    const result = await mainAgent.handleUserMessage(input, {
      ...context,
      permissionMode,
    });
    taskStore.addSessionMessage({
      sessionId,
      runId: typeof result.runId === "string" ? result.runId : null,
      role: result.content.startsWith("这次运行没有完成") ? "error" : "assistant",
      content: result.content,
      delegatedTo: Array.isArray(result.delegatedTo) ? result.delegatedTo : [],
      metadata: {
        source: "main-agent",
        needsUserInput: Boolean(result.needsUserInput),
        permissionMode,
      },
    });
    return result;
  }

  let commandRegistry: ReturnType<typeof createCommandRegistry>;
  const cronScheduler = await CronScheduler.create({
    dataDir,
    taskStore,
    execute: async (job) => {
      if (job.action.type === "chat") {
        return handleUserMessage(job.action.message, {
          sessionId: job.action.sessionId,
          source: job.action.source || "cron",
          permissionMode: job.action.permissionMode,
        });
      }
      return commandRegistry.run(job.action.command, job.action.args, {
        input: job.action.input,
        format: job.action.format,
        maxPermission: job.action.maxPermission,
      });
    },
  });

  commandRegistry = createCommandRegistry({
    health,
    doctor,
    listTools: () => toolRegistry.list(),
    listSkills: () => skillRegistry.list(),
    listSkillCandidates: (input = {}) => skillCandidateStore.listCandidates(input),
    listProviders: () => providerRegistry.list(),
    checkProviders: (input = {}) => providerRegistry.health(input),
    providerUsage: (input = {}) => providerUsageStore.summary(input),
    listRoles: () => roleManager.listRoles(),
    listSessions: (input = {}) => taskStore.listSessions(input),
    listSessionMessages: (input) => taskStore.listSessionMessages(input),
    resumeLatestSession,
    exportSession,
    previewSessionCompaction,
    sessionUsage,
    recallExperiences: (query = "", input = {}) => query.trim()
      ? experienceStore.recall(query, { scope: "project", limit: input.limit })
      : experienceStore.listActive(),
    addExperienceFeedback: (input) => experienceStore.addFeedback(input),
    buildDailyExperiences: (input = {}) => experienceBuilder.buildDailyExperiences(input),
    getTimeline: (input) => taskStore.getTimeline(input),
    renderTimeline: (runId) => renderTimeline(taskStore.getTimeline({ runId })),
    getTaskTrace: (taskId) => taskStore.getTaskTrace(taskId),
    securityAudit,
    buildContext: (input) => contextEngine.build(input),
    routeMessage: (input) => router.route(input),
    createSession: (input: Parameters<TaskStore["createSession"]>[0] = {}) => taskStore.createSession(input),
    clearSession: (sessionId, input = {}) => {
      const current = taskStore.getSession(sessionId);
      const hidden = current?.status === "active"
        ? taskStore.hideSession(sessionId, input.reason || "cleared by command")
        : current;
      const next = taskStore.createSession({
        title: input.nextTitle || "New session",
        source: input.source || "command",
        metadata: {
          createdBy: "clear",
          previousSessionId: sessionId,
        },
      });
      return { hidden, next };
    },
    restoreSession: (sessionId) => taskStore.restoreSession(sessionId),
    trashSession: (sessionId, input = {}) => taskStore.trashSession(sessionId, input),
    addProvider: async (input) => {
      providerRegistry.add(input);
      await providerRegistry.write(dataDir);
      return providerRegistry.getConfig(input.id);
    },
    enableProvider: async (providerId) => {
      const provider = providerRegistry.enable(providerId);
      await providerRegistry.write(dataDir);
      return provider;
    },
    disableProvider: async (providerId) => {
      const provider = providerRegistry.disable(providerId, {
        referencedBy: await roleReferences(providerId),
      });
      await providerRegistry.write(dataDir);
      return provider;
    },
    removeProvider: async (providerId) => {
      const provider = providerRegistry.remove(providerId, {
        referencedBy: await roleReferences(providerId),
      });
      await providerRegistry.write(dataDir);
      return provider;
    },
    addRole: (input: Parameters<RoleManager["addRole"]>[0]) => roleManager.addRole(input),
    updateRoleProvider: (name, input) => roleManager.updateRoleProvider(name, input),
    initializeDefaultRoles: (input) => roleManager.initializeDefaultRoles(input),
    buildSkillCandidates: (input = {}) => skillBuilder.buildSkillCandidates(input),
    approveSkillCandidate: (candidateId, input = {}) => skillCandidateStore.approveCandidate(candidateId, {
      reason: input.reason,
      registry: skillRegistry,
    }),
    rejectSkillCandidate: (candidateId, reason) => skillCandidateStore.rejectCandidate(candidateId, reason),
    diagnostics,
    maintenance,
    cancelTask: (taskId, reason) => roleAgentManager.cancelTask(taskId, reason),
    cancelRun: async (runId, reason) => {
      await roleAgentManager.cancelRun(runId, reason);
      return taskStore.getRun(runId);
    },
    executeTool,
    listCronJobs: (input = {}) => cronScheduler.list(input),
    createCronJob: (input: CronJobInput) => cronScheduler.createJob(input),
    updateCronJob: (id: string, input: Partial<CronJobInput>) => cronScheduler.updateJob(id, input),
    pauseCronJob: (id: string) => cronScheduler.pauseJob(id),
    resumeCronJob: (id: string) => cronScheduler.resumeJob(id),
    deleteCronJob: (id: string) => cronScheduler.deleteJob(id),
    runCronJob: (id: string) => cronScheduler.runJob(id),
  });
  if (options.enableCron !== false) cronScheduler.start();

  return {
    dataDir,
    memory,
    toolRegistry,
    skillRegistry,
    skillCandidateStore,
    providerRegistry,
    providerUsageStore,
    executeTool,
    roleManager,
    experienceStore,
    experienceBuilder,
    skillBuilder,
    cronScheduler,
    model,
    taskStore,
    roleAgentManager,
    mainAgent,
    hooks,
    contextEngine,
    router,
    addLifecycleHook(name: LifecycleHookName, handler: LifecycleHookHandler) {
      return hooks.on(name, handler);
    },
    listTools() {
      return toolRegistry.list();
    },
    listSkills() {
      return skillRegistry.list();
    },
    buildContext(options: Parameters<ContextEngine["build"]>[0]) {
      return contextEngine.build(options);
    },
    routeMessage(input: string) {
      return router.route(input);
    },
    listProviders() {
      return providerRegistry.list();
    },
    checkProviders(options: { deep?: boolean } = {}) {
      return providerRegistry.health(options);
    },
    providerUsage(options: { since?: Date; until?: Date; providerId?: string; limit?: number } = {}) {
      return providerUsageStore.summary(options);
    },
    async addProvider(config: ProviderConfig) {
      providerRegistry.add(config);
      await providerRegistry.write(dataDir);
      return providerRegistry.getConfig(config.id);
    },
    async enableProvider(providerId: string) {
      const provider = providerRegistry.enable(providerId);
      await providerRegistry.write(dataDir);
      return provider;
    },
    async disableProvider(providerId: string) {
      const provider = providerRegistry.disable(providerId, {
        referencedBy: await roleReferences(providerId),
      });
      await providerRegistry.write(dataDir);
      return provider;
    },
    async removeProvider(providerId: string) {
      const provider = providerRegistry.remove(providerId, {
        referencedBy: await roleReferences(providerId),
      });
      await providerRegistry.write(dataDir);
      return provider;
    },
    listRoles() {
      return roleManager.listRoles();
    },
    addRole(input: Parameters<RoleManager["addRole"]>[0]) {
      return roleManager.addRole(input);
    },
    updateRoleProvider(name: string, input: Parameters<RoleManager["updateRoleProvider"]>[1]) {
      return roleManager.updateRoleProvider(name, input);
    },
    initializeDefaultRoles(options: Parameters<RoleManager["initializeDefaultRoles"]>[0] = {}) {
      return roleManager.initializeDefaultRoles(options);
    },
    listSessions(options: Parameters<TaskStore["listSessions"]>[0] = {}) {
      return taskStore.listSessions(options);
    },
    getSession(sessionId: string) {
      return taskStore.getSession(sessionId);
    },
    createSession(options: Parameters<TaskStore["createSession"]>[0] = {}) {
      return taskStore.createSession(options);
    },
    clearSession(sessionId: string, options: { source?: string; reason?: string; nextTitle?: string } = {}) {
      const current = taskStore.getSession(sessionId);
      const hidden = current?.status === "active"
        ? taskStore.hideSession(sessionId, options.reason || "cleared by user")
        : current;
      const next = taskStore.createSession({
        title: options.nextTitle || "New session",
        source: options.source || "runtime",
        metadata: {
          createdBy: "clear",
          previousSessionId: sessionId,
        },
      });
      return { hidden, next };
    },
    restoreSession(sessionId: string) {
      return taskStore.restoreSession(sessionId);
    },
    trashSession(sessionId: string, options: Parameters<TaskStore["trashSession"]>[1] = {}) {
      return taskStore.trashSession(sessionId, options);
    },
    listSessionMessages(options: Parameters<TaskStore["listSessionMessages"]>[0]) {
      return taskStore.listSessionMessages(options);
    },
    handleUserMessage,
    buildDailyExperiences(options = {}) {
      return experienceBuilder.buildDailyExperiences(options);
    },
    buildSkillCandidates(options: Parameters<SkillBuilder["buildSkillCandidates"]>[0] = {}) {
      return skillBuilder.buildSkillCandidates(options);
    },
    listSkillCandidates(options: Parameters<SkillCandidateStore["listCandidates"]>[0] = {}) {
      return skillCandidateStore.listCandidates(options);
    },
    approveSkillCandidate(candidateId: string, options: { reason?: string } = {}) {
      return skillCandidateStore.approveCandidate(candidateId, {
        reason: options.reason,
        registry: skillRegistry,
      });
    },
    rejectSkillCandidate(candidateId: string, reason?: string) {
      return skillCandidateStore.rejectCandidate(candidateId, reason);
    },
    getTimeline(options: { runId: string }) {
      return taskStore.getTimeline(options);
    },
    getTaskTrace(taskId: string) {
      return taskStore.getTaskTrace(taskId);
    },
    diagnostics,
    securityAudit,
    doctor,
    resumeLatestSession,
    exportSession,
    previewSessionCompaction,
    sessionUsage,
    listCommands() {
      return commandRegistry.list();
    },
    runCommand(name: string, options: { args?: string[]; format?: "json" | "text"; input?: Record<string, unknown>; maxPermission?: CommandPermission } = {}) {
      return commandRegistry.run(name, options.args || [], {
        format: options.format || "json",
        input: options.input || {},
        maxPermission: options.maxPermission,
      });
    },
    listCronJobs(options: Parameters<CronScheduler["list"]>[0] = {}) {
      return cronScheduler.list(options);
    },
    createCronJob(input: CronJobInput) {
      return cronScheduler.createJob(input);
    },
    updateCronJob(id: string, input: Partial<CronJobInput>) {
      return cronScheduler.updateJob(id, input);
    },
    pauseCronJob(id: string) {
      return cronScheduler.pauseJob(id);
    },
    resumeCronJob(id: string) {
      return cronScheduler.resumeJob(id);
    },
    deleteCronJob(id: string) {
      return cronScheduler.deleteJob(id);
    },
    runCronJob(id: string) {
      return cronScheduler.runJob(id);
    },
    async cancelTask(taskId: string, reason?: string) {
      return roleAgentManager.cancelTask(taskId, reason);
    },
    async cancelRun(runId: string, reason?: string) {
      await roleAgentManager.cancelRun(runId, reason);
      return taskStore.getRun(runId);
    },
    renderTimeline(runId: string) {
      return renderTimeline(taskStore.getTimeline({ runId }));
    },
    health,
    maintenance,
    async shutdown() {
      cronScheduler.stop();
      await roleAgentManager.shutdown();
      providerUsageStore.close();
      experienceStore.close();
      skillCandidateStore.close();
      taskStore.close();
    },
  };

  async function roleReferences(providerId: string): Promise<string[]> {
    const roles = await roleManager.listRoles();
    return roles.filter((role) => role.provider === providerId).map((role) => role.name);
  }
}
