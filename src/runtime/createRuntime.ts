import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MainAgent } from "../agents/MainAgent.ts";
import { ExperienceBuilder } from "../experience/ExperienceBuilder.ts";
import { ExperienceStore } from "../experience/ExperienceStore.ts";
import { EchoModelProvider } from "../llm/EchoModelProvider.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import { TaskStore } from "../tasks/TaskStore.ts";
import { renderTimeline } from "../timeline/renderTimeline.ts";

export async function createRuntime(options: { dataDir?: string; model?: EchoModelProvider } = {}) {
  const dataDir = options.dataDir || path.join(process.cwd(), ".emily");
  await mkdir(dataDir, { recursive: true });

  const model = options.model || new EchoModelProvider();
  const memory = await MemorySystem.create({ dataDir });
  const taskStore = await TaskStore.create({ dataDir });
  const experienceStore = ExperienceStore.create({ dataDir });
  const experienceBuilder = new ExperienceBuilder({
    taskStore,
    experienceStore,
  });
  const roleAgentManager = new RoleAgentManager({
    dataDir,
    taskStore,
    workerPath: path.join(process.cwd(), "src", "workers", "subagentWorker.ts"),
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
    experienceStore,
    experienceBuilder,
    model,
    taskStore,
    roleAgentManager,
    mainAgent,
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
    renderTimeline(runId: string) {
      return renderTimeline(taskStore.getTimeline({ runId }));
    },
    health,
    async maintenance(options: { day?: Date; staleRunMs?: number } = {}) {
      const reconcile = await roleAgentManager.reconcile();
      const taskGraphs = taskStore.refreshTaskGraphStatuses();
      const staleRuns = taskStore.recoverStaleRuns({
        olderThanMs: options.staleRunMs ?? 5 * 60 * 1000,
      });
      const memoryCandidates = await approvePendingMemoryCandidates();
      const experiences = experienceBuilder.buildDailyExperiences({
        day: options.day || new Date(),
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
        memoryCandidates,
        experiences,
        health: health(),
      };
    },
    async shutdown() {
      await roleAgentManager.shutdown();
      experienceStore.close();
      taskStore.close();
    },
  };
}
