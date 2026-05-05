import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatchGatewayRequest } from "../src/gateway/GatewayProtocol.ts";
import { createFallbackPlanSpec } from "../src/planning/PlanSpec.ts";
import { createRuntime } from "../src/runtime/createRuntime.ts";
import { createTaskGraphFromPlan } from "../src/tasks/TaskGraph.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-task-mindmap-"));
const runtime = await createRuntime({ dataDir });

try {
  const run = runtime.taskStore.createRun({
    sessionId: "mindmap-test",
    source: "test",
    userInput: "开发一个应用，先达到 POC",
  });
  const plan = createFallbackPlanSpec("开发一个应用，先达到 POC", ["developer"]);
  createTaskGraphFromPlan({
    taskStore: runtime.taskStore,
    plan,
    baseMetadata: {
      runId: run.id,
      sessionId: "mindmap-test",
      source: "test",
      permissionMode: "workspace_write",
    },
  });

  const graphText = String(await runtime.runCommand("graph.view", {
    input: { runId: run.id },
    format: "text",
  }));
  assert.match(graphText, /Task Mind Map/);
  assert.match(graphText, /scope/);
  assert.match(graphText, /architecture/);
  assert.match(graphText, /未开始/);
  assert.match(graphText, /Execution dependencies/);

  const architecture = await runtime.runCommand("graph.node", {
    input: { runId: run.id, selector: "architecture" },
  }) as { key: string; parentKey: string; editable: boolean };
  assert.equal(architecture.key, "architecture");
  assert.equal(architecture.parentKey, "scope");
  assert.equal(architecture.editable, true);

  const updated = await runtime.runCommand("graph.update", {
    input: {
      runId: run.id,
      selector: "architecture",
      title: "architecture updated",
      input: "Expand the root into an editable module map.",
    },
  }) as { node: { title: string; input: string } };
  assert.equal(updated.node.title, "architecture updated");
  assert.equal(updated.node.input, "Expand the root into an editable module map.");

  const added = await runtime.runCommand("graph.add", {
    input: {
      runId: run.id,
      parent: "architecture",
      key: "api_slice",
      role: "developer",
      title: "API slice",
      input: "Implement the API leaf slice.",
      acceptanceCriteria: ["API slice is explicit."],
    },
  }) as { node: { key: string; parentKey: string; dependencies: Array<{ fromKey: string }> } };
  assert.equal(added.node.key, "api_slice");
  assert.equal(added.node.parentKey, "architecture");
  assert.equal(added.node.dependencies[0].fromKey, "architecture");

  const before = await runtime.runCommand("graph.add_before", {
    input: {
      runId: run.id,
      selector: "api_slice",
      key: "prep_slice",
      role: "developer",
      title: "Prep slice",
      input: "Prepare API inputs.",
    },
  }) as { node: { key: string; parentKey: string; dependencies: Array<{ fromKey: string }> } };
  assert.equal(before.node.key, "prep_slice");
  assert.equal(before.node.parentKey, "architecture");
  assert.equal(before.node.dependencies[0].fromKey, "architecture");
  const apiAfterBefore = await runtime.runCommand("graph.node", {
    input: { runId: run.id, selector: "api_slice" },
  }) as { dependencies: Array<{ fromKey: string }> };
  assert.equal(apiAfterBefore.dependencies[0].fromKey, "prep_slice");

  const after = await runtime.runCommand("graph.add_after", {
    input: {
      runId: run.id,
      selector: "api_slice",
      key: "polish_slice",
      role: "developer",
      title: "Polish slice",
      input: "Polish API output.",
    },
  }) as { node: { key: string; dependencies: Array<{ fromKey: string }> } };
  assert.equal(after.node.key, "polish_slice");
  assert.equal(after.node.dependencies[0].fromKey, "api_slice");

  const deleted = await runtime.runCommand("graph.delete", {
    input: {
      runId: run.id,
      selector: "polish_slice",
      reason: "test delete",
    },
  }) as { deleted: string[] };
  assert.deepEqual(deleted.deleted, ["polish_slice"]);

  const afterAddText = String(await runtime.runCommand("graph.view", {
    input: { runId: run.id },
    format: "text",
  }));
  assert.match(afterAddText, /api_slice/);
  assert.match(afterAddText, /prep_slice/);
  assert.doesNotMatch(afterAddText, /polish_slice/);

  const dagList = String(await runtime.runCommand("dag.list", { format: "text" }));
  assert.match(dagList, /DAG Roots/);
  assert.match(dagList, /未开始/);
  assert.match(dagList, new RegExp(run.id));

  const gatewayRead = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "graph-read",
    method: "graph.view",
    params: { runId: run.id, format: "text" },
  }, { maxPermission: "read" });
  assert.equal(gatewayRead.ok, true);
  assert.match(String(gatewayRead.result || ""), /Task Mind Map/);

  const gatewayDagRead = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "dag-list-read",
    method: "dag.list",
    params: { format: "text" },
  }, { maxPermission: "read" });
  assert.equal(gatewayDagRead.ok, true);
  assert.match(String(gatewayDagRead.result || ""), /DAG Roots/);

  const gatewayWriteDenied = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "graph-write-denied",
    method: "graph.add",
    params: {
      runId: run.id,
      parent: "architecture",
      key: "denied",
      role: "developer",
      title: "Denied",
      input: "Should not be added with a read token.",
    },
  }, { maxPermission: "read" });
  assert.equal(gatewayWriteDenied.ok, false);
  assert.match(String(gatewayWriteDenied.error?.message || ""), /requires write permission/);
} finally {
  await runtime.shutdown();
}

console.log("task mindmap test passed");
