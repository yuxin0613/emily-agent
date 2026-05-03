import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/tasks/TaskStore.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-session-"));
const taskStore = await TaskStore.create({ dataDir });

const session = taskStore.createSession({
  title: "Session management",
  source: "test",
});

assert.equal(session.status, "active");
assert.equal(taskStore.listSessions().length, 1);

taskStore.createRun({
  sessionId: session.id,
  source: "test",
  userInput: "帮我开发 session 管理",
});

const touched = taskStore.getSession(session.id);
assert.ok(touched);
assert.equal(touched.runCount, 1);
assert.equal(touched.title, "Session management");
assert.ok(touched.lastActiveAt);

taskStore.addSessionMessage({
  sessionId: session.id,
  role: "user",
  content: "第一条 session 内消息",
});
taskStore.addSessionMessage({
  sessionId: session.id,
  runId: "run-1",
  role: "assistant",
  content: "第一条回复",
  delegatedTo: ["planner"],
});

const messages = taskStore.listSessionMessages({ sessionId: session.id });
assert.equal(messages.length, 2);
assert.equal(messages[0].sessionId, session.id);
assert.equal(messages[0].content, "第一条 session 内消息");
assert.equal(messages[1].runId, "run-1");
assert.deepEqual(messages[1].delegatedTo, ["planner"]);

const other = taskStore.createSession({
  title: "Other",
  source: "test",
});
assert.equal(taskStore.listSessionMessages({ sessionId: other.id }).length, 0);

const hidden = taskStore.hideSession(session.id, "clear command");
assert.equal(hidden.status, "hidden");
assert.ok(hidden.archiveSummary?.includes("Runs: 1"));
assert.equal(taskStore.listSessions().some((item) => item.id === session.id), false);
assert.equal(taskStore.listSessions({ status: "hidden" })[0].id, session.id);
assert.throws(() => taskStore.createRun({
  sessionId: session.id,
  source: "stale-window",
  userInput: "旧窗口不应该复活 hidden session",
}), /restore it before touch/);
assert.throws(() => taskStore.addSessionMessage({
  sessionId: session.id,
  role: "user",
  content: "hidden session should reject new messages",
}), /restore it before add message/);

const restored = taskStore.restoreSession(session.id);
assert.equal(restored.status, "active");

const trashed = taskStore.trashSession(session.id, {
  deleteAfterDays: 30,
  reason: "archive complete",
});
assert.equal(trashed.status, "trashed");
assert.ok(trashed.deleteAfter);
assert.throws(() => taskStore.createRun({
  sessionId: session.id,
  source: "stale-window",
  userInput: "旧窗口不应该复活 trashed session",
}), /restore it before touch/);
assert.throws(() => taskStore.hideSession(session.id), /must be active before hide/);

taskStore.db
  .prepare("UPDATE sessions SET delete_after = ? WHERE id = ?")
  .run(new Date(Date.now() - 1000).toISOString(), session.id);

assert.equal(taskStore.pruneTrashedSessions(), 1);
assert.equal(taskStore.getSession(session.id)?.status, "deleted");
assert.throws(() => taskStore.restoreSession(session.id), /deleted/);

taskStore.close();

console.log("session test passed");
