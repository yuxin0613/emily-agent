import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nextCronRun } from "../src/cron/CronScheduler.ts";
import { dispatchGatewayRequest } from "../src/gateway/GatewayProtocol.ts";
import { startWebServer } from "../src/adapters/web.ts";
import { createRuntime } from "../src/runtime/createRuntime.ts";

const next = nextCronRun("*/15 * * * *", new Date("2026-05-04T00:07:00Z"));
assert.equal(next.getUTCMinutes(), 15);

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-cron-"));
const runtime = await createRuntime({ dataDir, enableCron: false });

try {
  const chatJob = await runtime.runCommand("cron.create", {
    input: {
      name: "cron chat",
      schedule: "* * * * *",
      message: "帮我做一次 cron smoke check",
      sessionId: "cron-test",
      status: "paused",
    },
  }) as { id: string; status: string; nextRunAt: string | null };
  assert.equal(chatJob.status, "paused");
  assert.equal(chatJob.nextRunAt, null);

  const resumed = await runtime.runCommand("cron.resume", {
    input: { id: chatJob.id },
  }) as { status: string; nextRunAt: string | null };
  assert.equal(resumed.status, "active");
  assert.ok(resumed.nextRunAt);

  const run = await runtime.runCommand("cron.run", {
    input: { id: chatJob.id },
  }) as { ok: boolean; job: { runCount: number } };
  assert.equal(run.ok, true);
  assert.equal(run.job.runCount, 1);
  assert.ok(runtime.taskStore.listSessionMessages({ sessionId: "cron-test", limit: 10 }).some((message) => message.role === "user"));

  const gatewayCreate = await dispatchGatewayRequest(runtime, {
    type: "request",
    id: "cron-create",
    method: "cron.create",
    params: {
      name: "cron health",
      schedule: "@hourly",
      command: "health",
    },
  });
  assert.equal(gatewayCreate.ok, true);
  const commandJob = gatewayCreate.result as { id: string; action: { type: string; command: string; maxPermission: string } };
  assert.equal(commandJob.action.type, "command");
  assert.equal(commandJob.action.command, "health");
  assert.equal(commandJob.action.maxPermission, "write");

  const gatewayRun = await dispatchGatewayRequest(runtime, {
    type: "request",
    id: "cron-run",
    method: "cron.run",
    params: { id: commandJob.id },
  });
  assert.equal(gatewayRun.ok, true);
  assert.equal((gatewayRun.result as { ok?: boolean }).ok, true);

  const server = await startWebServer({
    runtime,
    port: 0,
    authToken: "cron-token",
  });
  try {
    const created = await fetch(`${server.url}/cron`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-emily-token": "cron-token",
        origin: server.url,
      },
      body: JSON.stringify({
        name: "web cron",
        schedule: "@daily",
        command: "health",
      }),
    });
    assert.equal(created.status, 200);
    const webJob = await created.json() as { id: string };
    assert.ok(webJob.id);

    const listed = await fetch(`${server.url}/cron`, {
      headers: { "x-emily-token": "cron-token" },
    });
    assert.equal(listed.status, 200);
    const jobs = await listed.json() as Array<{ id: string }>;
    assert.ok(jobs.some((job) => job.id === webJob.id));
  } finally {
    await server.close();
  }

  const paused = await runtime.runCommand("cron.pause", {
    input: { id: chatJob.id },
  }) as { status: string };
  assert.equal(paused.status, "paused");

  const deleted = await runtime.runCommand("cron.delete", {
    input: { id: chatJob.id },
  }) as { id: string };
  assert.equal(deleted.id, chatJob.id);
} finally {
  await runtime.shutdown();
}

console.log("cron test passed");
