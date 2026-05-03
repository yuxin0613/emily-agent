import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MainAgent } from "../agents/MainAgent.ts";
import { ExperienceBuilder } from "../experience/ExperienceBuilder.ts";
import { ExperienceStore } from "../experience/ExperienceStore.ts";
import { EchoModelProvider } from "../llm/EchoModelProvider.ts";
import { MemorySystem } from "../memory/MemorySystem.ts";
import { RoleAgentManager } from "../tasks/RoleAgentManager.ts";
import { TaskStore } from "../tasks/TaskStore.ts";

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
    async shutdown() {
      await roleAgentManager.shutdown();
      experienceStore.close();
      taskStore.close();
    },
  };
}
