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

const hidden = taskStore.hideSession(session.id, "clear command");
assert.equal(hidden.status, "hidden");
assert.ok(hidden.archiveSummary?.includes("Runs: 1"));
assert.equal(taskStore.listSessions().some((item) => item.id === session.id), false);
assert.equal(taskStore.listSessions({ status: "hidden" })[0].id, session.id);

const restored = taskStore.restoreSession(session.id);
assert.equal(restored.status, "active");

const trashed = taskStore.trashSession(session.id, {
  deleteAfterDays: 30,
  reason: "archive complete",
});
assert.equal(trashed.status, "trashed");
assert.ok(trashed.deleteAfter);

taskStore.db
  .prepare("UPDATE sessions SET delete_after = ? WHERE id = ?")
  .run(new Date(Date.now() - 1000).toISOString(), session.id);

assert.equal(taskStore.pruneTrashedSessions(), 1);
assert.equal(taskStore.getSession(session.id)?.status, "deleted");
assert.throws(() => taskStore.restoreSession(session.id), /deleted/);

taskStore.close();

console.log("session test passed");
