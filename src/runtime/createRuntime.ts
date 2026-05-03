import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MainAgent } from "../agents/MainAgent.ts";
import { ExperienceBuilder } from "../experience/ExperienceBuilder.ts";
import { ExperienceStore } from "../experience/ExperienceStore.ts";
import type { ModelProvider, ProviderConfig, ProviderFallbackMode } from "../llm/ModelProvider.ts";
import { ProviderRegistry } from "../llm/ProviderRegistry.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import { RoleManager } from "../roles/RoleManager.ts";
import { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { renderTimeline } from "../timeline/renderTimeline.ts";

export async function createRuntime(options: {
  dataDir?: string;
  roleDir?: string;
  model?: ModelProvider;
  providers?: ProviderConfig[];
  defaultProviderId?: string;
  providerFallbackMode?: ProviderFallbackMode;
  mainProviderId?: string;
} = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), ".emily");
  const roleDir = options.roleDir || process.env.EMILY_ROLE_DIR || path.join(process.cwd(), "agents");
  await mkdir(dataDir, { recursive: true });

  const requestedMainProviderId = options.mainProviderId || options.defaultProviderId;
  if (options.model && !requestedMainProviderId) {
    throw new Error("Injected main model requires mainProviderId/defaultProviderId so subagent fallback is explicit.");
  }
  const providerRegistry = await ProviderRegistry.create({
    dataDir,
    providers: options.providers,
    defaultProviderId: requestedMainProviderId || "echo",
    fallbackMode: options.providerFallbackMode || "strict",
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
  const roleManager = new RoleManager({ roleDir, providerRegistry });
  const experienceBuilder = new ExperienceBuilder({
    taskStore,
    experienceStore,
  });
  const roleAgentManager = new RoleAgentManager({
    dataDir,
    taskStore,
    workerPath: path.join(process.cwd(), "src", "workers", "subagentWorker.ts"),
    roleDir,
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
    };
  }

  return {
    dataDir,
    memory,
    providerRegistry,
    roleManager,
    experienceStore,
    experienceBuilder,
    model,
    taskStore,
    roleAgentManager,
    mainAgent,
    listProviders() {
      return providerRegistry.list();
    },
    checkProviders(options: { deep?: boolean } = {}) {
      return providerRegistry.health(options);
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
    async handleUserMessage(input: string, context = {}) {
      return mainAgent.handleUserMessage(input, context);
    },
    buildDailyExperiences(options = {}) {
      return experienceBuilder.buildDailyExperiences(options);
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
    async maintenance(options: { day?: Date; staleRunMs?: number; maxEvents?: number; pruneMemoryCandidateDays?: number } = {}) {
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
      const database = taskStore.maintenance({
        maxEvents: options.maxEvents,
        pruneDecidedMemoryCandidatesOlderThanDays: options.pruneMemoryCandidateDays,
      });
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
        database,
        health: health(),
      };
    },
    async shutdown() {
      await roleAgentManager.shutdown();
      experienceStore.close();
      taskStore.close();
    },
  };

  async function roleReferences(providerId: string): Promise<string[]> {
    const roles = await roleManager.listRoles();
    return roles.filter((role) => role.provider === providerId).map((role) => role.name);
  }
}
