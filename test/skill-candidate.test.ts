import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { createTaskResult, serializeTaskResult } from "../src/tasks/TaskResult.ts";
import type { TaskStore } from "../src/tasks/TaskStore.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-skill-candidates-"));
const roleDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-skill-candidate-roles-"));
const skillDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-skill-candidate-skills-"));
const runtime = await createRuntime({
  dataDir,
  roleDir,
  skillDir,
  providers: [{
    id: "main-echo",
    type: "echo",
    model: "skill-candidate-model",
  }],
  defaultProviderId: "main-echo",
  mainProviderId: "main-echo",
});

for (let index = 0; index < 3; index += 1) {
  createDoneWorkflowTask(runtime.taskStore, index);
}

const built = runtime.buildSkillCandidates({
  minOccurrences: 3,
  minScore: 0.3,
});
assert.equal(built.candidates.length, 1);
assert.equal(built.candidates[0].status, "proposed");
assert.equal(built.candidates[0].proposalType, "create");
assert.equal(built.candidates[0].name, "provider-debugging");
assert.equal(built.candidates[0].frequency, 3);
assert.equal(built.candidates[0].successRate, 1);
assert.ok(built.candidates[0].score > 0.6);
assert.deepEqual(runtime.listSkillCandidates({ status: "proposed" }).map((candidate) => candidate.id), [built.candidates[0].id]);
assert.equal(runtime.health().proposedSkillCandidates, 1);

const approved = await runtime.approveSkillCandidate(built.candidates[0].id, {
  reason: "repeatable provider debugging workflow",
});
assert.equal(approved.status, "approved");
assert.equal(runtime.listSkillCandidates({ status: "approved" }).length, 1);
assert.ok(runtime.listSkills().some((skill) => skill.name === "provider-debugging"));
const approvedSkill = await readFile(path.join(skillDir, "provider-debugging", "skill.md"), "utf8");
assert.match(approvedSkill, /Provider Debugging/);
assert.match(approvedSkill, /Workflow/);

for (let index = 3; index < 5; index += 1) {
  createDoneWorkflowTask(runtime.taskStore, index);
}

const updateBuilt = runtime.buildSkillCandidates({
  minOccurrences: 2,
  minScore: 0.3,
});
assert.equal(updateBuilt.candidates.length, 1);
assert.equal(updateBuilt.candidates[0].proposalType, "update");
assert.equal(updateBuilt.candidates[0].targetSkillName, "provider-debugging");

const merged = await runtime.approveSkillCandidate(updateBuilt.candidates[0].id, {
  reason: "merge newer provider debugging evidence",
});
assert.equal(merged.status, "merged");

createDoneWorkflowTask(runtime.taskStore, 5, {
  skillCandidateKey: "migration-review",
  skillCandidateName: "migration-review",
  skillCandidateTitle: "Migration Review",
});
createDoneWorkflowTask(runtime.taskStore, 6, {
  skillCandidateKey: "migration-review",
  skillCandidateName: "migration-review",
  skillCandidateTitle: "Migration Review",
});
const rejectedBuilt = runtime.buildSkillCandidates({
  minOccurrences: 2,
  minScore: 0.3,
});
const rejectedCandidate = rejectedBuilt.candidates.find((candidate) => candidate.name === "migration-review");
assert.ok(rejectedCandidate);
const rejected = runtime.rejectSkillCandidate(rejectedCandidate.id, "too project-specific for now");
assert.equal(rejected.status, "rejected");
assert.equal(rejected.decisionReason, "too project-specific for now");

await runtime.shutdown();

console.log("skill candidate test passed");

function createDoneWorkflowTask(taskStore: TaskStore, index: number, overrides: Record<string, string> = {}) {
  const task = taskStore.createTask({
    role: "developer",
    title: `provider fallback debugging ${index}`,
    input: [
      "Debug provider fallback issue.",
      "Check provider config, role provider binding, fallback mode, provider usage quota, and JSON output handling.",
      "Run provider related tests and report verification notes.",
    ].join(" "),
    maxRetries: 1,
    metadata: {
      sessionId: "skill-candidate",
      skillCandidateKey: "provider-debugging",
      skillCandidateName: "provider-debugging",
      skillCandidateTitle: "Provider Debugging",
      skillHints: ["coding", "review"],
      toolHints: ["read_file", "run_tests"],
      ...overrides,
    },
  });
  taskStore.enqueueTask(task.id);
  taskStore.claimTask(task.id, "developer-test", { leaseMs: 1000 });
  const claimed = taskStore.getTaskOrThrow(task.id);
  taskStore.finishTask(task.id, {
    agentId: "developer-test",
    leaseToken: claimed.leaseToken,
    result: serializeTaskResult(createTaskResult({
      summary: [
        "Checked provider config, role binding, fallback mode, provider usage quota, and JSON output handling.",
        "Ran node test/provider.test.ts and provider verification passed.",
      ].join(" "),
      nextActions: ["Use the same provider debugging workflow next time."],
    })),
  });
  return taskStore.getTaskOrThrow(task.id);
}
