import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GraphPatchSpec, PlanSpec, PlanTaskSpec } from "../src/planning/PlanSpec.ts";
import { createTaskGraphFromPlan } from "../src/tasks/TaskGraph.ts";
import { TaskGraphExecutor } from "../src/tasks/TaskGraphExecutor.ts";
import { createTaskResult, serializeTaskResult } from "../src/tasks/TaskResult.ts";
import { TaskStore } from "../src/tasks/TaskStore.ts";
import type { RoleAgentManager } from "../src/tasks/RoleAgentManager.ts";
import type { Task } from "../src/types.ts";

async function runForwardReferenceDependencyTest(): Promise<void> {
  const { store, plan, tasksByKey } = await createDynamicFixture("dynamic-forward");
  const manager = new FakeRoleAgentManager(store, "forward_reference");
  const executor = new TaskGraphExecutor({
    taskStore: store,
    roleAgentManager: manager as unknown as RoleAgentManager,
    plan,
  });

  const result = await executor.execute(tasksByKey);
  const graphId = result.graphId!;
  const graphTasks = store.getTasksForGraph(graphId);
  const implementation = findGraphTask(graphTasks, "implement_slice");
  const verification = findGraphTask(graphTasks, "verify_slice");
  const dependencies = store.getDependencies(verification.id);

  assert.equal(result.pause, null);
  assert.equal(result.expanded.length, 2);
  assert.equal(implementation.status, "done");
  assert.equal(verification.status, "done");
  assert.ok(dependencies.some((dependency) => dependency.dependsOnTaskId === implementation.id));
  assert.equal(store.getTaskGraph(graphId)?.status, "done");
  assert.ok(!store.getTimeline({ runId: "dynamic-forward" }).events.some((event) => event.payload.code === "dynamic_dependency_missing"));

  store.close();
}

async function runFallbackClosureTest(): Promise<void> {
  const { store, plan, tasksByKey } = await createDynamicFixture("dynamic-fallback");
  const manager = new FakeRoleAgentManager(store, "planner_failure");
  const executor = new TaskGraphExecutor({
    taskStore: store,
    roleAgentManager: manager as unknown as RoleAgentManager,
    plan,
  });

  const result = await executor.execute(tasksByKey);
  const graphId = result.graphId!;
  const timeline = store.getTimeline({ runId: "dynamic-fallback" });
  const expanded = timeline.events.find((event) => event.type === "task_graph.expanded");
  const internalPlanner = result.internal.find((task) => task.metadata.planPhase === "graph_expansion");

  assert.equal(result.pause, null);
  assert.equal(expanded?.payload.source, "fallback");
  assert.ok(result.expanded.length >= 1);
  assert.ok(internalPlanner);
  assert.equal(internalPlanner.status, "failed");
  assert.notEqual(internalPlanner.metadata.graphId, graphId);
  assert.equal(internalPlanner.metadata.parentGraphId, graphId);
  assert.equal(store.getTaskGraph(graphId)?.status, "done");

  store.close();
}

async function runUserInputPauseTest(): Promise<void> {
  const { store, plan, tasksByKey } = await createDynamicFixture("dynamic-pause");
  const manager = new FakeRoleAgentManager(store, "needs_user_input");
  const executor = new TaskGraphExecutor({
    taskStore: store,
    roleAgentManager: manager as unknown as RoleAgentManager,
    plan,
  });

  const result = await executor.execute(tasksByKey);
  const graphId = result.graphId!;
  const timeline = store.getTimeline({ runId: "dynamic-pause" });

  assert.ok(result.pause);
  assert.equal(result.pause.source, "planner");
  assert.deepEqual(result.pause.questions, ["Need target module boundaries before expanding."]);
  assert.equal(result.expanded.length, 0);
  assert.ok(timeline.events.some((event) => event.type === "task_graph.waiting_user"
    && event.payload.graphId === graphId
    && event.payload.source === "planner"));
  assert.equal(store.getTaskGraph(graphId)?.status, "done");

  store.close();
}

async function createDynamicFixture(runId: string): Promise<{
  store: TaskStore;
  plan: PlanSpec;
  tasksByKey: Record<string, Task>;
}> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `${runId}-`));
  const store = await TaskStore.create({ dataDir });
  const plan = createRollingPlan(runId);
  const tasksByKey = createTaskGraphFromPlan({
    taskStore: store,
    plan,
    baseMetadata: {
      runId,
      sessionId: runId,
      source: "test",
      createdBy: "dynamic-task-test",
    },
  });
  return { store, plan, tasksByKey };
}

function createRollingPlan(runId: string): PlanSpec {
  return {
    goal: `Validate dynamic task expansion for ${runId}.`,
    deliveryLevel: "poc",
    exitCriteria: ["Dynamic graph reaches a terminal state."],
    planningMode: "rolling",
    maxWaves: 4,
    failureStrategy: "block_dependents",
    tasks: [
      planTask({
        key: "architecture",
        role: "planner",
        title: "architecture",
        input: "Create the first executable architecture slice.",
        acceptanceCriteria: ["Architecture is specific enough to expand."],
        wave: 1,
        expandable: true,
        expansionGoal: "Expand architecture into implementation and verification slices.",
        maxExpansionDepth: 2,
      }),
    ],
    review: {
      required: false,
      criteria: [],
    },
    clarificationRequired: false,
    clarificationQuestions: [],
  };
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
    maxRetries: 1,
    maxResultChars: 12000,
    maxMemoryCandidates: 0,
    wave: 1,
    expandable: false,
    expansionGoal: "",
    maxExpansionDepth: 0,
    ...input,
  };
}

function findGraphTask(tasks: Task[], graphKey: string): Task {
  const task = tasks.find((item) => item.metadata.graphKey === graphKey);
  assert.ok(task, `Expected graph task ${graphKey}`);
  return task;
}

class FakeRoleAgentManager {
  private readonly store: TaskStore;
  private readonly mode: "forward_reference" | "planner_failure" | "needs_user_input";

  constructor(store: TaskStore, mode: "forward_reference" | "planner_failure" | "needs_user_input") {
    this.store = store;
    this.mode = mode;
  }

  async runTask(task: Task): Promise<Task> {
    const agentId = `fake-${task.role}`;
    this.store.enqueueTask(task.id);
    this.store.claimTask(task.id, agentId, { leaseMs: 30000 });
    const claimed = this.store.getTaskOrThrow(task.id);

    if (task.metadata.planPhase === "graph_expansion" && this.mode === "planner_failure") {
      this.store.failTask(task.id, {
        error: "planner failed while creating graph patch",
        result: taskResult("planner failed while creating graph patch"),
        agentId,
        leaseToken: claimed.leaseToken,
      });
      return this.store.getTaskOrThrow(task.id);
    }

    this.store.finishTask(task.id, {
      result: taskResult(this.summaryFor(task)),
      agentId,
      leaseToken: claimed.leaseToken,
    });
    return this.store.getTaskOrThrow(task.id);
  }

  private summaryFor(task: Task): string {
    if (task.metadata.planPhase !== "graph_expansion") {
      return `${task.metadata.graphKey || task.title} completed`;
    }
    if (this.mode === "needs_user_input") {
      return JSON.stringify({
        reason: "Need user input before continuing graph expansion.",
        parentKey: task.metadata.parentKey,
        stop: false,
        needsUserInput: true,
        questions: ["Need target module boundaries before expanding."],
        tasks: [],
      } satisfies GraphPatchSpec);
    }
    return JSON.stringify({
      reason: "Create verification before implementation in the patch to prove two-pass dependency linking.",
      parentKey: task.metadata.parentKey,
      stop: false,
      needsUserInput: false,
      questions: [],
      tasks: [
        planTask({
          key: "verify_slice",
          role: "reviewer",
          title: "verify dynamic slice",
          input: "Verify the implemented dynamic slice.",
          parentKey: String(task.metadata.parentKey || ""),
          dependsOn: ["implement_slice"],
          acceptanceCriteria: ["Verification runs after implementation."],
          wave: 3,
        }),
        planTask({
          key: "implement_slice",
          role: "developer",
          title: "implement dynamic slice",
          input: "Implement the first dynamic slice.",
          parentKey: String(task.metadata.parentKey || ""),
          dependsOn: [String(task.metadata.parentKey || "")],
          acceptanceCriteria: ["Implementation is complete."],
          wave: 2,
        }),
      ],
    } satisfies GraphPatchSpec);
  }
}

function taskResult(summary: string): string {
  return serializeTaskResult(createTaskResult({ summary }));
}

await runForwardReferenceDependencyTest();
await runFallbackClosureTest();
await runUserInputPauseTest();

console.log("dynamic task test passed");
