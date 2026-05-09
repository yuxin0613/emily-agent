import assert from "node:assert/strict";
import { startWebServer } from "../src/adapters/web.ts";
import { CommandPermissionError } from "../src/commands/CommandRegistry.ts";

let latestEventsLimit = 0;
let diagnosticsRepair: boolean | null = null;
let genericCommandMaxPermission = "";
let settingsUpdateInput: Record<string, unknown> | undefined;

const runtime = {
  handleUserMessage: async () => ({ content: "ok", delegatedTo: [] }),
  taskStore: {
    getLatestEvents: ({ limit }: { limit: number }) => {
      latestEventsLimit = limit;
      return [];
    },
  },
  experienceStore: {
    listActive: () => [],
    recall: () => [],
    addFeedback: () => ({}),
  },
  getTimeline: () => ({}),
  getTaskTrace: () => ({}),
  diagnostics: ({ repair = false }: { repair?: boolean } = {}) => {
    diagnosticsRepair = repair;
    return { repair };
  },
  cancelTask: async () => ({}),
  cancelRun: async () => ({}),
  listProviders: () => [],
  checkProviders: async () => [],
  providerUsage: () => ({ totals: {}, providers: [], recent: [] }),
  addProvider: async () => ({}),
  enableProvider: async () => ({}),
  disableProvider: async () => ({}),
  removeProvider: async () => ({}),
  listTools: () => [],
  listSkills: () => [],
  listSkillCandidates: () => [],
  buildSkillCandidates: () => ({}),
  approveSkillCandidate: async () => ({}),
  rejectSkillCandidate: () => ({}),
  listRoles: async () => [],
  addRole: async () => ({}),
  updateRoleProvider: async () => ({}),
  initializeDefaultRoles: async () => [],
  listSessions: () => [],
  getSession: () => null,
  createSession: () => ({}),
  clearSession: () => ({}),
  restoreSession: () => ({}),
  trashSession: () => ({}),
  listSessionMessages: () => [],
  renderTimeline: () => "",
  buildDailyExperiences: () => ({}),
  health: () => ({ ok: true }),
  maintenance: async () => ({}),
  runCommand: async (name: string, options: { input?: Record<string, unknown>; maxPermission?: string } = {}) => {
    if (name === "health") {
      genericCommandMaxPermission = options.maxPermission || "";
      return { ok: true };
    }
    if (name === "diagnostics.repair" && options.maxPermission === "read") {
      throw new CommandPermissionError("Command diagnostics.repair requires write permission; caller is limited to read.");
    }
    if (name === "provider.health" && options.input?.deep === true && options.maxPermission === "read") {
      throw new CommandPermissionError("Command provider.health requires danger permission; caller is limited to read.");
    }
    if (name === "diagnostics.run") return runtime.diagnostics({ repair: false });
    if (name === "diagnostics.repair") return runtime.diagnostics({ repair: true });
    if (name === "maintenance.run") return runtime.maintenance(options.input);
    if (name === "settings.get") return { defaultProviderId: "echo", fallbackMode: "strict", providers: [] };
    if (name === "settings.update") {
      settingsUpdateInput = options.input;
      return { ok: true };
    }
    return {};
  },
  roleAgentManager: {
    on: () => undefined,
    off: () => undefined,
  },
};

const webLogLines: string[] = [];
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  webLogLines.push(args.map(String).join(" "));
  originalConsoleLog(...args);
};
let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
try {
  server = await startWebServer({
    runtime: runtime as never,
    port: 0,
    authToken: "test-token",
    readAuthToken: "read-token",
    writeAuthToken: "write-token",
  });
} finally {
  console.log = originalConsoleLog;
}
if (!server) throw new Error("web server failed to start");
assert.equal(webLogLines.some((line) => line.includes("Emily Agent web token: test-token")), false);
assert.equal(webLogLines.some((line) => line.includes("Emily Agent web token: test...oken (10 chars)")), true);

try {
  const app = await fetch(`${server.url}/`);
  assert.equal(app.status, 200);
  assert.equal((await app.text()).includes("test-token"), false);

  const dashboard = await fetch(`${server.url}/providers/dashboard?token=test-token`);
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.text()).includes("test-token"), false);

  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json() as Record<string, unknown>;
  assert.deepEqual(healthBody, { ok: true });
  assert.equal("runtime" in healthBody, false);
  assert.equal("gateway" in healthBody, false);

  const detailedHealthUnauthorized = await fetch(`${server.url}/health/detail`);
  assert.equal(detailedHealthUnauthorized.status, 401);

  const detailedHealth = await fetch(`${server.url}/health/detail`, {
    headers: { "x-emily-token": "test-token" },
  });
  assert.equal(detailedHealth.status, 200);
  const detailedHealthBody = await detailedHealth.json() as Record<string, unknown>;
  assert.equal(detailedHealthBody.ok, true);
  assert.equal(typeof detailedHealthBody.runtime, "object");
  assert.equal(typeof detailedHealthBody.gateway, "object");

  const readScopedProviders = await fetch(`${server.url}/providers`, {
    headers: { "x-emily-token": "read-token" },
  });
  assert.equal(readScopedProviders.status, 200);

  const readScopedSettings = await fetch(`${server.url}/settings`, {
    headers: { "x-emily-token": "read-token" },
  });
  assert.equal(readScopedSettings.status, 200);

  const readScopedSettingsWrite = await fetch(`${server.url}/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "read-token",
      origin: server.url,
    },
    body: JSON.stringify({ fallbackMode: "fallback" }),
  });
  assert.equal(readScopedSettingsWrite.status, 403);

  const writeScopedSettingsWrite = await fetch(`${server.url}/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "write-token",
      origin: server.url,
    },
    body: JSON.stringify({ fallbackMode: "fallback" }),
  });
  assert.equal(writeScopedSettingsWrite.status, 200);
  assert.deepEqual(settingsUpdateInput, { fallbackMode: "fallback" });

  const readScopedDeepProviderHealth = await fetch(`${server.url}/providers/health?deep=true`, {
    headers: { "x-emily-token": "read-token" },
  });
  assert.equal(readScopedDeepProviderHealth.status, 403);

  const readScopedWrite = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "read-token",
      origin: server.url,
    },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(readScopedWrite.status, 403);

  const writeScopedWrite = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "write-token",
      origin: server.url,
    },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(writeScopedWrite.status, 200);

  const unauthorized = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(unauthorized.status, 401);

  const forbiddenOrigin = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "test-token",
      origin: "http://example.com",
    },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(forbiddenOrigin.status, 403);

  const ok = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "test-token",
      origin: server.url,
    },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(ok.status, 200);

  const invalidJson = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "test-token",
      origin: server.url,
    },
    body: "{bad json",
  });
  assert.equal(invalidJson.status, 400);

  const tooLarge = await fetch(`${server.url}/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "test-token",
      origin: server.url,
    },
    body: JSON.stringify({ message: "x".repeat(1024 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);

  const events = await fetch(`${server.url}/events-snapshot?limit=999999`, {
    headers: { "x-emily-token": "test-token" },
  });
  assert.equal(events.status, 200);
  assert.equal(latestEventsLimit, 500);

  await fetch(`${server.url}/diagnostics?repair=true`, {
    headers: { "x-emily-token": "test-token" },
  });
  assert.equal(diagnosticsRepair, false);

  await fetch(`${server.url}/diagnostics/repair`, {
    method: "POST",
    headers: {
      "x-emily-token": "test-token",
      origin: server.url,
    },
  });
  assert.equal(diagnosticsRepair, true);

  const genericRead = await fetch(`${server.url}/commands/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "test-token",
      origin: server.url,
    },
    body: JSON.stringify({ name: "health" }),
  });
  assert.equal(genericRead.status, 200);
  assert.equal(genericCommandMaxPermission, "read");

  const genericWrite = await fetch(`${server.url}/commands/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-emily-token": "test-token",
      origin: server.url,
    },
    body: JSON.stringify({ name: "diagnostics.repair" }),
  });
  assert.equal(genericWrite.status, 403);

  const ws = await connectWebSocket(`${server.url.replace("http://", "ws://")}/gateway?token=test-token`);
  try {
    const ready = await ws.next();
    assert.equal(ready.type, "event");
    assert.equal(ready.event, "gateway.ready");
    let rateLimited = false;
    for (let index = 0; index < 61; index += 1) {
      const id = `rate-${index}`;
      ws.send({ type: "request", id, method: "tools.list", params: {} });
      const response = await ws.nextResponse(id);
      if (response.error?.code === "gateway_rate_limited") rateLimited = true;
    }
    assert.equal(rateLimited, true);
  } finally {
    ws.close();
  }
} finally {
  await server.close();
}

const publicServer = await startWebServer({
  runtime: runtime as never,
  port: 0,
  host: "0.0.0.0",
  authToken: "test-token",
});
try {
  const queryTokenApp = await fetch(`${publicServer.url}/?token=test-token`);
  assert.equal(queryTokenApp.status, 400);

  const queryTokenProviders = await fetch(`${publicServer.url}/providers?token=test-token`);
  assert.equal(queryTokenProviders.status, 401);

  const headerTokenProviders = await fetch(`${publicServer.url}/providers`, {
    headers: { "x-emily-token": "test-token" },
  });
  assert.equal(headerTokenProviders.status, 200);
} finally {
  await publicServer.close();
}

console.log("web hardening test passed");

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
