import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryCandidatePolicy } from "../src/memory/MemoryCandidatePolicy.ts";
import { parseReviewerVerdict } from "../src/review/ReviewerVerdict.ts";
import { TaskStore } from "../src/tasks/TaskStore.ts";
import type { MemoryCandidate } from "../src/types.ts";

const verdict = parseReviewerVerdict(`
{
  "verdict": "fail",
  "reasons": ["Missing final verification"],
  "retrySuggested": true,
  "confidence": 0.82
}
`);

assert.equal(verdict.verdict, "fail");
assert.equal(verdict.retrySuggested, true);
assert.equal(verdict.confidence, 0.82);
assert.deepEqual(verdict.reasons, ["Missing final verification"]);

const fallback = parseReviewerVerdict("需要用户补充目标环境。");
assert.equal(fallback.verdict, "needs_user_input");

const policy = new MemoryCandidatePolicy();
assert.equal(policy.decide(candidate("EchoModelProvider 当前运行的是本地模板，下一步可以接入真实模型。".repeat(2))), "rejected");
assert.equal(policy.decide(candidate("SQLite IPC agent memory 经验：主 agent 收到 IPC 后仍应查询 SQLite 作为事实源，并把 task markdown 作为人工可读恢复材料。")), "approved");

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-policy-"));
const taskStore = await TaskStore.create({ dataDir });
const memoryCandidate = taskStore.createMemoryCandidate({
  runId: "run-policy",
  taskId: null,
  scope: "project",
  kind: "subagent:result",
  content: "SQLite IPC agent memory 经验：主 agent 收到 IPC 后仍应查询 SQLite 作为事实源。",
  createdBy: "test",
});
const firstDecision = taskStore.decidePendingMemoryCandidate(memoryCandidate.id, "approved");
const secondDecision = taskStore.decidePendingMemoryCandidate(memoryCandidate.id, "approved");
assert.equal(firstDecision.changed, true);
assert.equal(secondDecision.changed, false);
assert.equal(taskStore.getLatestEvents({ limit: 20 }).filter((event) => event.type === "memory.candidate.approved").length, 1);
taskStore.close();

console.log("policy test passed");

function candidate(content: string): MemoryCandidate {
  return {
    id: "candidate-test",
    runId: "run-test",
    taskId: "task-test",
    scope: "project",
    kind: "subagent:result",
    content,
    status: "pending",
    createdBy: "test",
    createdAt: new Date().toISOString(),
    decidedAt: null,
  };
}
