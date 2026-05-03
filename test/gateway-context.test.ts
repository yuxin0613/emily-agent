import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startWebServer } from "../src/adapters/web.ts";
import { createRuntime } from "../src/runtime/createRuntime.ts";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "emily-agent-gateway-"));
const runtime = await createRuntime({
  dataDir,
  providers: [{
    id: "main-echo",
    type: "echo",
    model: "gateway-context-model",
  }],
  defaultProviderId: "main-echo",
  mainProviderId: "main-echo",
});

let beforeRun = 0;
let afterRun = 0;
let afterContext = 0;
runtime.addLifecycleHook("beforeRun", () => {
  beforeRun += 1;
});
runtime.addLifecycleHook("afterRun", () => {
  afterRun += 1;
});
runtime.addLifecycleHook("afterContextBuild", () => {
  afterContext += 1;
});

await runtime.memory.remember({
  scope: "ctx",
  kind: "note",
  content: "WebSocket gateway applications should use typed methods and runtime events.",
  metadata: { importance: 0.8, confidence: 0.9 },
});
runtime.createSession({ id: "ctx", title: "Context test", source: "test" });
runtime.taskStore.addSessionMessage({
  sessionId: "ctx",
  role: "user",
  content: "历史消息：typed websocket gateway protocol",
  metadata: { source: "test" },
});

const activeContext = await runtime.buildContext({
  query: "typed websocket gateway",
  sessionId: "ctx",
  mode: "active",
});
assert.equal(activeContext.memory.files.length, 0);
assert.ok(activeContext.memory.shortTerm.length >= 1);
assert.equal(activeContext.metadata.longMemoryOnDemand, false);

const deepContext = await runtime.buildContext({
  query: "typed websocket gateway",
  sessionId: "ctx",
  mode: "deep",
});
assert.ok(deepContext.memory.files.length >= 1);
assert.ok(deepContext.sessionMessages.length >= 1);
assert.equal(deepContext.metadata.longMemoryOnDemand, true);
assert.ok(afterContext >= 2);

const route = runtime.routeMessage("POC 实现一个 websocket agent 应用");
assert.ok(route.selectedRoles.includes("planner"));
assert.ok(route.selectedRoles.includes("developer"));

const response = await runtime.handleUserMessage("POC 实现一个 websocket agent 应用", {
  sessionId: "ctx",
  source: "test",
});
assert.equal(response.agent, "emily");
assert.ok(beforeRun >= 1);
assert.ok(afterRun >= 1);

const audit = await runtime.securityAudit();
assert.ok(["pass", "warn", "fail"].includes(audit.status));
assert.ok(audit.summary.providers >= 1);

const server = await startWebServer({
  runtime,
  port: 0,
  authToken: "gateway-token",
});

try {
  const ws = await connectWebSocket(`${server.url.replace("http://", "ws://")}/gateway?token=gateway-token`);
  const ready = await ws.next();
  assert.equal(ready.type, "event");
  assert.equal(ready.event, "gateway.ready");

  ws.send({
    type: "request",
    id: "tools-1",
    method: "tools.list",
    params: {},
  });
  const tools = await ws.nextResponse("tools-1");
  assert.equal(tools.ok, true);
  assert.ok(Array.isArray(tools.result));

  ws.send({
    type: "request",
    id: "sessions-1",
    method: "sessions.list",
    params: { includeHidden: true },
  });
  const sessions = await ws.nextResponse("sessions-1");
  assert.equal(sessions.ok, true);
  assert.ok(Array.isArray(sessions.result));

  ws.send({
    type: "request",
    id: "providers-health-1",
    method: "providers.health",
    params: {},
  });
  const providersHealth = await ws.nextResponse("providers-health-1");
  assert.equal(providersHealth.ok, true);
  assert.ok(Array.isArray(providersHealth.result));

  ws.send({
    type: "request",
    id: "route-1",
    method: "router.route",
    params: { input: "开发一个 API" },
  });
  const routed = await ws.nextResponse("route-1");
  assert.equal(routed.ok, true);
  assert.ok(routed.result.selectedRoles.includes("developer"));
  ws.close();
} finally {
  await server.close();
  await runtime.shutdown();
}

console.log("gateway context test passed");

function connectWebSocket(target: string): Promise<{
  send: (payload: unknown) => void;
  next: () => Promise<any>;
  nextResponse: (id: string) => Promise<any>;
  close: () => void;
}> {
  const socket = new WebSocket(target);
  const messages: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  socket.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else messages.push(parsed);
  });

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });

  return withTimeout(ready, 3000, "websocket open").then(() => ({
    send(payload: unknown) {
      socket.send(JSON.stringify(payload));
    },
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      return withTimeout(new Promise((resolve) => waiters.push(resolve)), 3000, "websocket message");
    },
    async nextResponse(id: string) {
      for (;;) {
        const message = await this.next();
        if (message.type === "response" && message.id === id) return message;
      }
    },
    close() {
      socket.close();
    },
  }));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
