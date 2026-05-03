import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExperienceBuilder } from "../src/experience/ExperienceBuilder.ts";
import { ExperienceStore } from "../src/experience/ExperienceStore.ts";
import { TaskStore } from "../src/tasks/TaskStore.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-experience-"));
const taskStore = await TaskStore.create({ dataDir });
const experienceStore = ExperienceStore.create({ dataDir });
const builder = new ExperienceBuilder({
  taskStore,
  experienceStore,
  dailyLimit: 3,
});

const first = createDoneTask(
  "developer",
  "sqlite ipc recovery",
  "Design sqlite ipc recovery for agent runtime",
  "Use SQLite as fact source and IPC only as notification. If worker exits, inspect task state before retrying.",
);
const second = createDoneTask(
  "developer",
  "sqlite ipc recovery",
  "Design sqlite ipc recovery for agent runtime",
  "Use lease plus heartbeat in SQLite, keep IPC as notification only, and trigger inspector when lease expires or worker exits.",
);
createDoneTask(
  "planner",
  "minor daily note",
  "say hello",
  "ok",
);

const result = builder.buildDailyExperiences({
  day: new Date(),
});

assert.ok(result.candidates.length <= 3);
assert.equal(result.updates.length, 2);

const active = experienceStore.listActive();
assert.equal(active.length, 1);
assert.equal(active[0].revision, 2);
assert.ok(active[0].evidenceTaskIds.includes(first.id));
assert.ok(active[0].evidenceTaskIds.includes(second.id));

const revisions = experienceStore.getRevisions(active[0].id);
assert.equal(revisions.length, 1);
assert.equal(revisions[0].revision, 1);

const recalled = experienceStore.recall("worker exits and sqlite lease expires", {
  scope: "project",
  limit: 3,
});
assert.equal(recalled[0].id, active[0].id);
assert.equal(recalled[0].revision, 2);

const similar = experienceStore.upsertExperience({
  scope: "project",
  type: "solution",
  topicKey: "",
  title: "Best practice: recover worker crash with sqlite lease",
  summary: "Worker crash recovery should rely on SQLite leases, heartbeat renewal, and inspector fallback.",
  problemPattern: "Worker process exits before notifying the main agent",
  solutionPattern: "Use SQLite lease expiration and an inspector task to verify final state before retrying.",
  evidenceTaskIds: ["manual-evidence"],
  evidenceEventIds: [],
  confidence: 0.93,
  importance: 0.93,
  changeReason: "Manual refined best practice for the same recovery topic.",
});
assert.equal(similar.action, "replace");
assert.equal(similar.experience.id, active[0].id);
assert.equal(similar.experience.revision, 3);

const feedback = experienceStore.addFeedback({
  experienceId: similar.experience.id,
  rating: "useful",
  comment: "This is the right recovery pattern.",
});
assert.equal(feedback.rating, "useful");
assert.equal(experienceStore.getFeedback(similar.experience.id).length, 1);

experienceStore.close();
taskStore.close();

console.log("experience test passed");

function createDoneTask(role: string, title: string, input: string, result: string) {
  const task = taskStore.createTask({
    role,
    title,
    input,
    maxRetries: 1,
  });
  taskStore.enqueueTask(task.id);
  taskStore.claimTask(task.id, `${role}-test`, { leaseMs: 1000 });
  taskStore.finishTask(task.id, {
    result,
    agentId: `${role}-test`,
  });
  return taskStore.getTaskOrThrow(task.id);
}
