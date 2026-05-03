import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { dispatchGatewayRequest, type GatewayMethod } from "../../src/gateway/GatewayProtocol.ts";
import { createRuntime } from "../../src/runtime/createRuntime.ts";
import type { TaskEvent } from "../../src/types.ts";

export async function createMockParityHarness(label = "mock-parity") {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `emily-agent-${label}-`));
  const runtime = await createRuntime({
    dataDir,
    providers: [{
      id: "main-echo",
      type: "echo",
      model: `${label}-model`,
    }],
    defaultProviderId: "main-echo",
    mainProviderId: "main-echo",
  });

  return {
    dataDir,
    runtime,
    async chat(message: string, sessionId = label) {
      const response = await runtime.handleUserMessage(message, {
        sessionId,
        source: "mock-parity",
      });
      const runId = typeof response.runId === "string" ? response.runId : "";
      return {
        response,
        run: runId ? runtime.taskStore.getRun(runId) : null,
        timeline: runId ? runtime.getTimeline({ runId }) : null,
      };
    },
    gateway(method: GatewayMethod, params: Record<string, unknown> = {}) {
      return dispatchGatewayRequest(runtime, {
        type: "request",
        id: `${label}-${method}`,
        method,
        params,
      });
    },
    async runWorkerCrashRecovery() {
      const task = runtime.taskStore.createTask({
        role: "developer",
        title: "mock crash recovery",
        input: "Crash intentionally for mock parity.",
        metadata: {
          sessionId: label,
          forceCrash: true,
        },
      });
      return runtime.roleAgentManager.runTask(task, { timeoutMs: 10000 });
    },
    async cancelDelayedWorker() {
      const task = runtime.taskStore.createTask({
        role: "developer",
        title: "mock cancellable task",
        input: "Delay long enough for cancellation.",
        metadata: {
          sessionId: label,
          forceDelayMs: 500,
        },
      });
      const running = runtime.roleAgentManager.runTask(task, { timeoutMs: 5000 }).catch(() => runtime.taskStore.getTaskOrThrow(task.id));
      await sleep(50);
      await runtime.cancelTask(task.id, "mock parity cancel");
      return running;
    },
    createMemoryCandidate(content = "Use agent memory candidate approval to keep durable experience useful, auditable, and scoped to repeated workflows.") {
      return runtime.taskStore.createMemoryCandidate({
        runId: null,
        taskId: null,
        scope: label,
        kind: "note",
        content,
        createdBy: "mock-parity",
      });
    },
    async writeWorkspaceFile(relativePath: string, content: string) {
      const target = path.join(process.cwd(), relativePath);
      await writeFile(target, content, "utf8");
      return target;
    },
    async close() {
      await runtime.shutdown();
    },
  };
}

export function assertEventSequence(events: TaskEvent[], expected: string[]): void {
  let cursor = 0;
  for (const event of events) {
    if (event.type === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return;
  }
  assert.fail(`Expected event sequence ${expected.join(" -> ")} in ${events.map((event) => event.type).join(" -> ")}`);
}

export function assertHasEvent(events: TaskEvent[], type: string, predicate: (event: TaskEvent) => boolean = () => true): void {
  assert.ok(events.some((event) => event.type === type && predicate(event)), `Expected event ${type}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
