import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatchGatewayRequest } from "../src/gateway/GatewayProtocol.ts";
import { createRuntime } from "../src/runtime/createRuntime.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-command-renderer-"));
const runtime = await createRuntime({
  dataDir,
  providers: [{
    id: "main-echo",
    type: "echo",
    model: "command-renderer-model",
  }],
  defaultProviderId: "main-echo",
  mainProviderId: "main-echo",
});

try {
  const healthText = String(await runtime.runCommand("health", { format: "text" }));
  assert.match(healthText, /Runtime Health/);

  const toolsText = String(await runtime.runCommand("tools", { format: "text" }));
  assert.match(toolsText, /Tools/);
  assert.match(toolsText, /read_file/);

  const subagentsText = String(await runtime.runCommand("sub", { format: "text" }));
  assert.match(subagentsText, /Subagents/);

  const created = await runtime.runCommand("session.create", {
    input: { title: "Renderer test", source: "test" },
  }) as { id: string };
  const sessionsText = String(await runtime.runCommand("session.list", { format: "text" }));
  assert.match(sessionsText, /Sessions/);
  assert.match(sessionsText, /Renderer test/);

  const clearText = String(await runtime.runCommand("session.clear", {
    input: { sessionId: created.id, source: "test", reason: "renderer test" },
    format: "text",
  }));
  assert.match(clearText, /Session Cleared/);

  const gatewayTrashSession = await runtime.runCommand("session.create", {
    input: { title: "Gateway trash", source: "test" },
  }) as { id: string };
  const trash = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "trash-1",
    method: "sessions.trash",
    params: { sessionId: gatewayTrashSession.id, reason: "gateway renderer test" },
  });
  assert.equal(trash.ok, true);
  assert.equal((trash.result as { status?: string }).status, "trashed");

  const providerAdd = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "provider-add-1",
    method: "providers.add",
    params: { id: "gateway-extra", type: "echo", model: "gateway-extra-model" },
  });
  assert.equal(providerAdd.ok, true);

  const providerDisable = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "provider-disable-1",
    method: "providers.disable",
    params: { providerId: "gateway-extra" },
  });
  assert.equal(providerDisable.ok, true);

  const providerAddReadToken = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "provider-add-read-1",
    method: "providers.add",
    params: { id: "gateway-read-extra", type: "echo", model: "gateway-read-extra-model" },
  }, { maxPermission: "read" });
  assert.equal(providerAddReadToken.ok, false);
  assert.match(String(providerAddReadToken.error?.message || ""), /requires write permission/);

  const toolsListReadToken = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "tools-read-1",
    method: "tools.list",
    params: {},
  }, { maxPermission: "read" });
  assert.equal(toolsListReadToken.ok, true);

  const toolRun = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "tool-1",
    method: "tools.execute",
    params: {
      tool: "read_file",
      args: { path: "README.md", maxBytes: 32 },
      role: "developer",
      permissionMode: "read_only",
    },
  });
  assert.equal(toolRun.ok, true);
  assert.equal((toolRun.result as { ok?: boolean }).ok, true);

  const routeText = String(await runtime.runCommand("router.route", {
    input: { input: "实现测试并修复失败" },
    format: "text",
  }));
  assert.match(routeText, /Route/);

  await assert.rejects(
    runtime.runCommand("experiences.feedback", { args: ["exp_only"] }),
    /requires input\.rating/,
  );

  await assert.rejects(
    runtime.runCommand("session.create", {
      input: { title: "Should not be created", source: "test" },
      maxPermission: "read",
    }),
    /requires write permission/,
  );

  const commandRunRead = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "command-run-read-1",
    method: "commands.run",
    params: { name: "health" },
  });
  assert.equal(commandRunRead.ok, true);

  const commandRunDoctorRepair = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "command-run-doctor-repair-1",
    method: "commands.run",
    params: { name: "doctor", input: { repair: true } },
  });
  assert.equal(commandRunDoctorRepair.ok, false);
  assert.match(String(commandRunDoctorRepair.error?.message || ""), /requires write permission/);

  const commandRunWrite = await dispatchGatewayRequest(runtime as never, {
    type: "request",
    id: "command-run-write-1",
    method: "commands.run",
    params: {
      name: "session.create",
      input: { title: "Gateway command bypass", source: "test" },
    },
  });
  assert.equal(commandRunWrite.ok, false);
  assert.match(String(commandRunWrite.error?.message || ""), /requires write permission/);
} finally {
  await runtime.shutdown();
}

console.log("command registry renderer test passed");
