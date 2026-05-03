import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { calibratedReplanBudget, classifyFailure } from "../src/tasks/TaskGraphExecutor.ts";
import type { Task, TaskStatus } from "../src/types.ts";

const fixturePath = path.join(process.cwd(), "test", "fixtures", "planner", "long-task-samples.json");
const samples = JSON.parse(await readFile(fixturePath, "utf8")) as Array<{
  name: string;
  status: TaskStatus;
  error: string;
  deliveryLevel: string;
  expectedCluster: string;
  expectedBudgetMin: number;
  expectedBudgetMax: number;
}>;

for (const sample of samples) {
  const task = makeTask(sample);
  const cluster = classifyFailure(task);
  assert.equal(cluster, sample.expectedCluster, sample.name);
  const budget = calibratedReplanBudget({
    availableSlots: 40,
    failureCluster: cluster,
    attempt: 1,
    deliveryLevel: sample.deliveryLevel,
  });
  assert.ok(
    budget >= sample.expectedBudgetMin && budget <= sample.expectedBudgetMax,
    `${sample.name} budget ${budget} should be ${sample.expectedBudgetMin}-${sample.expectedBudgetMax}`,
  );
}

assert.equal(calibratedReplanBudget({
  availableSlots: 40,
  failureCluster: "verification",
  attempt: 5,
  deliveryLevel: "production",
}), 2);

console.log("planner calibration test passed");

function makeTask(sample: { name: string; status: TaskStatus; error: string; deliveryLevel: string }): Task {
  const now = new Date().toISOString();
  return {
    id: `task_${sample.name}`,
    role: "developer",
    status: sample.status,
    title: sample.name,
    input: "Build and verify a realistic long-running AgentOS feature branch.",
    result: null,
    error: sample.error,
    assignedAgentId: null,
    parentTaskId: null,
    metadata: {
      graphKey: sample.name,
      deliveryLevel: sample.deliveryLevel,
      acceptanceCriteria: ["Recovery should move the graph toward closure."],
    },
    retryCount: 0,
    maxRetries: 1,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    mainAckAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
