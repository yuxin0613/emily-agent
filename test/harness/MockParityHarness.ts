import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
