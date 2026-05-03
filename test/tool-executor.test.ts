import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolExecutor } from "../src/tools/ToolExecutor.ts";
import { createDefaultToolRegistry } from "../src/tools/ToolRegistry.ts";
import { TaskStore } from "../src/tasks/TaskStore.ts";
import type { RoleDefinition } from "../src/types.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-tool-executor-"));
const taskStore = await TaskStore.create({ dataDir });
const executor = new ToolExecutor({
  workspaceDir: process.cwd(),
  taskStore,
  registry: createDefaultToolRegistry(),
});

const role: RoleDefinition = {
  name: "network-researcher",
  role: "Use approved external tools.",
  singleton: true,
  allowedTools: ["read_file", "http_fetch", "browser", "github", "delete_file"],
  forbiddenTools: ["delete_file"],
  maxConcurrentTasks: 1,
  capabilities: ["research"],
  skills: [],
  instructions: "Use approved tools only.",
};

const read = await executor.execute({
  tool: "read_file",
  args: { path: "README.md", maxBytes: 120 },
  roleDefinition: role,
  permissionMode: "read_only",
  sessionId: "tool-executor",
});
assert.equal(read.ok, true);
assert.match(String((read.output as { content?: string }).content || ""), /emily-agent/);

const deniedByMode = await executor.execute({
  tool: "http_fetch",
  args: { url: "https://example.com" },
  roleDefinition: role,
  permissionMode: "workspace_write",
  sessionId: "tool-executor",
});
assert.equal(deniedByMode.ok, false);
assert.match(String(deniedByMode.error || ""), /not allowed/);

const approvalRequired = await executor.execute({
  tool: "http_fetch",
  args: { url: "https://example.com" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  sessionId: "tool-executor",
});
assert.equal(approvalRequired.ok, false);
assert.match(String(approvalRequired.error || ""), /requires explicit approval/);

const forbidden = await executor.execute({
  tool: "delete_file",
  args: { path: "README.md" },
  roleDefinition: role,
  permissionMode: "danger_full_access",
  approval: { approved: true, reason: "test should still honor forbidden tools" },
  sessionId: "tool-executor",
});
assert.equal(forbidden.ok, false);
assert.match(String(forbidden.error || ""), /not allowed/);

const events = taskStore.getLatestEvents({ limit: 50 });
assert.ok(events.some((event) => event.type === "tool.execution.completed"));
assert.ok(events.some((event) => event.type === "tool.execution.approval_required"));

taskStore.close();
console.log("tool executor test passed");
