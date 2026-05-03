import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatchGatewayRequest, type GatewayMethod } from "../../src/gateway/GatewayProtocol.ts";
import { createRuntime } from "../../src/runtime/createRuntime.ts";
import type { Task, TaskEvent } from "../../src/types.ts";
import type { GraphPatchSpec, PlanSpec, PlanTaskSpec } from "../../src/planning/PlanSpec.ts";
import { createTaskGraphFromPlan } from "../../src/tasks/TaskGraph.ts";
import { TaskGraphExecutor } from "../../src/tasks/TaskGraphExecutor.ts";
import { createTaskResult, serializeTaskResult } from "../../src/tasks/TaskResult.ts";
import type { RoleAgentManager } from "../../src/tasks/RoleAgentManager.ts";

export async function createMockParityHarness(label = "mock-parity") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `emily-agent-${label}-`));
  const runtime = await createRuntime({
    dataDir,
    providers: [{
      id: "main-echo",
      type: "echo",
      model: `${label}-model`,
    }],
    defaultProviderId: "main-echo",
    mainProviderId: "main-echo",
  });

  return {
    dataDir,
    runtime,
    async chat(message: string, sessionId = label) {
      const response = await runtime.handleUserMessage(message, {
        sessionId,
        source: "mock-parity",
      });
      const runId = typeof response.runId === "string" ? response.runId : "";
      return {
        response,
        run: runId ? runtime.taskStore.getRun(runId) : null,
        timeline: runId ? runtime.getTimeline({ runId }) : null,
      };
    },
    gateway(method: GatewayMethod, params: Record<string, unknown> = {}) {
      return dispatchGatewayRequest(runtime, {
        type: "request",
        id: `${label}-${method}`,
        method,
        params,
      });
    },
    async runWorkerCrashRecovery() {
      const task = runtime.taskStore.createTask({
        role: "developer",
        title: "mock crash recovery",
        input: "Crash intentionally for mock parity.",
        metadata: {
          sessionId: label,
          forceCrash: true,
        },
      });
      return runtime.roleAgentManager.runTask(task, { timeoutMs: 10000 });
    },
    async cancelDelayedWorker() {
      const task = runtime.taskStore.createTask({
        role: "developer",
        title: "mock cancellable task",
        input: "Delay long enough for cancellation.",
        metadata: {
          sessionId: label,
          forceDelayMs: 500,
        },
      });
      const running = runtime.roleAgentManager.runTask(task, { timeoutMs: 5000 }).catch(() => runtime.taskStore.getTaskOrThrow(task.id));
      await sleep(50);
      await runtime.cancelTask(task.id, "mock parity cancel");
      return running;
    },
    createMemoryCandidate(content = "Use agent memory candidate approval to keep durable experience useful, auditable, and scoped to repeated workflows.") {
      return runtime.taskStore.createMemoryCandidate({
        runId: null,
        taskId: null,
        scope: label,
        kind: "note",
        content,
        createdBy: "mock-parity",
      });
    },
    async runMultiRoundReplanBenchmark() {
      const plan = createReplanPlan(label);
      const tasksByKey = createTaskGraphFromPlan({
        taskStore: runtime.taskStore,
        plan,
        baseMetadata: {
          runId: `${label}-replan`,
          sessionId: label,
          source: "mock-parity",
          createdBy: "mock-parity",
        },
      });
      const executor = new TaskGraphExecutor({
        taskStore: runtime.taskStore,
        roleAgentManager: new ReplanBenchmarkRoleAgentManager(runtime.taskStore) as unknown as RoleAgentManager,
        plan,
        maxParallelTasks: 3,
        maxReplanAttempts: 2,
      });
      const result = await executor.execute(tasksByKey);
      return {
        result,
        timeline: runtime.taskStore.getTimeline({ runId: `${label}-replan` }),
      };
    },
    async writeWorkspaceFile(relativePath: string, content: string) {
      const target = path.join(process.cwd(), relativePath);
      await writeFile(target, content, "utf8");
      return target;
    },
    async close() {
      await runtime.shutdown();
    },
  };
}

export function assertEventSequence(events: TaskEvent[], expected: string[]): void {
  let cursor = 0;
  for (const event of events) {
    if (event.type === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return;
  }
  assert.fail(`Expected event sequence ${expected.join(" -> ")} in ${events.map((event) => event.type).join(" -> ")}`);
}

export function assertHasEvent(events: TaskEvent[], type: string, predicate: (event: TaskEvent) => boolean = () => true): void {
  assert.ok(events.some((event) => event.type === type && predicate(event)), `Expected event ${type}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createReplanPlan(label: string): PlanSpec {
  return {
    goal: `Mock parity multi-round replan benchmark for ${label}.`,
    deliveryLevel: "poc",
    exitCriteria: ["A recovery task eventually succeeds after clustered failures."],
    planningMode: "rolling",
    maxWaves: 6,
    failureStrategy: "replan",
    tasks: [{
      key: "unstable",
      role: "developer",
      title: "unstable benchmark task",
      input: "Fail once so the executor must replan.",
      parentKey: "",
      dependsOn: [],
      dependencyType: "success",
      acceptanceCriteria: ["Failure is recovered through replanning."],
      toolHints: [],
      skillHints: [],
      timeoutMs: 30000,
      maxRetries: 0,
      maxResultChars: 12000,
      maxMemoryCandidates: 0,
      wave: 1,
      expandable: false,
      expansionGoal: "",
      maxExpansionDepth: 0,
      permissionMode: "workspace_write",
    }],
    review: { required: false, criteria: [] },
    clarificationRequired: false,
    clarificationQuestions: [],
  };
}

class ReplanBenchmarkRoleAgentManager {
  private readonly store: Awaited<ReturnType<typeof createRuntime>>["taskStore"];

  constructor(store: Awaited<ReturnType<typeof createRuntime>>["taskStore"]) {
    this.store = store;
  }

  async runTask(task: Task): Promise<Task> {
    const agentId = `replan-${task.role}`;
    this.store.enqueueTask(task.id);
    this.store.claimTask(task.id, agentId, { leaseMs: 30000 });
    const claimed = this.store.getTaskOrThrow(task.id);

    if (task.metadata.planPhase === "graph_replan") {
      this.store.finishTask(task.id, {
        result: taskResult(this.patchFor(task)),
        agentId,
        leaseToken: claimed.leaseToken,
      });
      return this.store.getTaskOrThrow(task.id);
    }

    const graphKey = String(task.metadata.graphKey || "");
    if (graphKey === "unstable") {
      this.store.failTask(task.id, {
        error: "Task timed out while waiting for implementation fixture.",
        result: taskResult("timeout failure"),
        agentId,
        leaseToken: claimed.leaseToken,
      });
      return this.store.getTaskOrThrow(task.id);
    }
    if (graphKey === "recover_unstable_1") {
      this.store.failTask(task.id, {
        error: "Provider returned malformed JSON during first recovery.",
        result: taskResult("provider failure"),
        agentId,
        leaseToken: claimed.leaseToken,
      });
      return this.store.getTaskOrThrow(task.id);
    }

    this.store.finishTask(task.id, {
      result: taskResult(`${graphKey} recovered successfully`),
      agentId,
      leaseToken: claimed.leaseToken,
    });
    return this.store.getTaskOrThrow(task.id);
  }

  private patchFor(task: Task): GraphPatchSpec {
    const parentKey = String(task.metadata.parentKey || "");
    const attempt = Number(task.metadata.replanAttempt || 1);
    const recoveryKey = parentKey === "recover_unstable_1" ? "recover_unstable_2" : "recover_unstable_1";
    return {
      reason: `Mock parity recovery attempt ${attempt}.`,
      parentKey,
      stop: false,
      needsUserInput: false,
      questions: [],
      tasks: [planTask({
        key: recoveryKey,
        role: "developer",
        title: `recovery ${attempt}`,
        input: attempt === 1 ? "Narrow recovery but fail once for benchmark." : "Final narrowed recovery succeeds.",
        parentKey,
        dependsOn: [parentKey],
        dependencyType: "finished",
        acceptanceCriteria: ["Recovery result is usable."],
        wave: attempt + 1,
      })],
    };
  }
}

function planTask(input: Partial<PlanTaskSpec> & Pick<PlanTaskSpec, "key" | "role" | "title" | "input">): PlanTaskSpec {
  return {
    parentKey: "",
    dependsOn: [],
    dependencyType: "success",
    acceptanceCriteria: [],
    toolHints: [],
    skillHints: [],
    timeoutMs: 30000,
    maxRetries: 0,
    maxResultChars: 12000,
    maxMemoryCandidates: 0,
    wave: 1,
    expandable: false,
    expansionGoal: "",
    maxExpansionDepth: 0,
    permissionMode: "workspace_write",
    ...input,
  };
}

function taskResult(summary: string | GraphPatchSpec): string {
  return serializeTaskResult(createTaskResult({
    summary: typeof summary === "string" ? summary : JSON.stringify(summary),
  }));
}
