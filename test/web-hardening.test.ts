import assert from "node:assert/strict";
import { startWebServer } from "../src/adapters/web.ts";

let latestEventsLimit = 0;
let diagnosticsRepair: boolean | null = null;

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
  runCommand: async (name: string, options: { input?: Record<string, unknown> } = {}) => {
    if (name === "diagnostics.run") return runtime.diagnostics({ repair: false });
    if (name === "diagnostics.repair") return runtime.diagnostics({ repair: true });
    if (name === "maintenance.run") return runtime.maintenance(options.input);
    return {};
  },
  roleAgentManager: {
    on: () => undefined,
    off: () => undefined,
  },
};

const server = await startWebServer({
  runtime: runtime as never,
  port: 0,
  authToken: "test-token",
});

try {
  const app = await fetch(`${server.url}/`);
  assert.equal(app.status, 200);
  assert.equal((await app.text()).includes("test-token"), false);

  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200);

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
} finally {
  await server.close();
}

console.log("web hardening test passed");
