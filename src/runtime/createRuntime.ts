import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MainAgent } from "../agents/MainAgent.ts";
import { ExperienceBuilder } from "../experience/ExperienceBuilder.ts";
import { ExperienceStore } from "../experience/ExperienceStore.ts";
import type { ModelProvider, ProviderConfig, ProviderFallbackMode } from "../llm/ModelProvider.ts";
import { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import { ProviderUsageStore } from "../llm/ProviderUsageStore.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import { RoleManager } from "../roles/RoleManager.ts";
import { SkillBuilder } from "../skills/SkillBuilder.ts";
import { SkillCandidateStore } from "../skills/SkillCandidateStore.ts";
import { SkillRegistry } from "../skills/SkillRegistry.ts";
import { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { createDefaultToolRegistry } from "../tools/ToolRegistry.ts";
import { renderTimeline } from "../timeline/renderTimeline.ts";

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
} = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), ".emily");
  const roleDir = options.roleDir || process.env.EMILY_ROLE_DIR || path.join(process.cwd(), "agents");
  const skillDir = options.skillDir || process.env.EMILY_SKILL_DIR || path.join(process.cwd(), "skills");
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
  const memory = await MemorySystem.create({ dataDir });
  const taskStore = await TaskStore.create({ dataDir });
  const experienceStore = ExperienceStore.create({ dataDir });
  const toolRegistry = createDefaultToolRegistry();
  const skillRegistry = await SkillRegistry.create({ skillDir });
  const skillCandidateStore = SkillCandidateStore.create({ dataDir, skillDir });
  const roleManager = new RoleManager({ roleDir, providerRegistry });
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
  });
  await roleAgentManager.start();

  const mainAgent = new MainAgent({
    name: "emily",
    model,
    memory,
    taskStore,
    experienceStore,
    roleAgentManager,
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

  return {
    dataDir,
    memory,
    toolRegistry,
    skillRegistry,
    skillCandidateStore,
    providerRegistry,
    providerUsageStore,
    roleManager,
    experienceStore,
    experienceBuilder,
    skillBuilder,
    model,
    taskStore,
    roleAgentManager,
    mainAgent,
    listTools() {
      return toolRegistry.list();
    },
    listSkills() {
      return skillRegistry.list();
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
      const hidden = taskStore.getSession(sessionId)
        ? taskStore.hideSession(sessionId, options.reason || "cleared by user")
        : null;
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
    async handleUserMessage(input: string, context: { sessionId?: string; source?: string } = {}) {
      const sessionId = context.sessionId || "default";
      const source = context.source || "unknown";
      const normalizedInput = String(input || "").trim();
      if (normalizedInput) {
        taskStore.addSessionMessage({
          sessionId,
          role: "user",
          content: normalizedInput,
          metadata: { source },
        });
      }
      const result = await mainAgent.handleUserMessage(input, context);
      taskStore.addSessionMessage({
        sessionId,
        runId: typeof result.runId === "string" ? result.runId : null,
        role: result.content.startsWith("这次运行没有完成") ? "error" : "assistant",
        content: result.content,
        delegatedTo: Array.isArray(result.delegatedTo) ? result.delegatedTo : [],
        metadata: {
          source: "main-agent",
          needsUserInput: Boolean(result.needsUserInput),
        },
      });
      return result;
    },
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
    diagnostics(options: { repair?: boolean } = {}) {
      return taskStore.diagnostics(options);
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
    async maintenance(options: {
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
    },
    async shutdown() {
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
