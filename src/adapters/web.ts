import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { dispatchGatewayRequest, gatewayEvent, gatewayProtocolSpec, parseGatewayRequest } from "../gateway/GatewayProtocol.ts";
import { webAppHtml } from "./webUi.ts";

export interface WebServerHandle {
  server: http.Server;
  authToken: string;
  url: string;
  close: () => Promise<void>;
}

export async function startWebServer({
  runtime,
  port,
  host = "127.0.0.1",
  authToken = process.env.EMILY_WEB_TOKEN || randomUUID(),
}: {
  runtime: {
    handleUserMessage: (message: string, context: { sessionId?: string; source?: string }) => Promise<unknown>;
    taskStore: { getLatestEvents: (options?: { afterId?: number; limit?: number }) => unknown[] };
    experienceStore: {
      listActive: () => unknown[];
      recall: (query: string, options?: { scope?: "project"; limit?: number }) => unknown[];
      addFeedback: (input: { experienceId: string; rating: "useful" | "wrong" | "outdated" | "duplicate"; comment?: string }) => unknown;
    };
    getTimeline: (options: { runId: string }) => unknown;
    getTaskTrace: (taskId: string) => unknown;
    diagnostics: (options?: { repair?: boolean }) => unknown;
    securityAudit: () => Promise<unknown>;
    buildContext: (options: { query: string; sessionId?: string; runId?: string | null; role?: string; mode?: "active" | "deep" }) => Promise<unknown>;
    routeMessage: (input: string) => unknown;
    cancelTask: (taskId: string, reason?: string) => Promise<unknown>;
    cancelRun: (runId: string, reason?: string) => Promise<unknown>;
    listProviders: () => unknown[];
    checkProviders: (options?: { deep?: boolean }) => Promise<unknown[]>;
    providerUsage: (options?: { since?: Date; until?: Date; providerId?: string; limit?: number }) => unknown;
    addProvider: (input: { id: string; type: "echo" | "openai" | "ollama"; enabled?: boolean; model?: string; config?: Record<string, unknown> }) => Promise<unknown>;
    enableProvider: (providerId: string) => Promise<unknown>;
    disableProvider: (providerId: string) => Promise<unknown>;
    removeProvider: (providerId: string) => Promise<unknown>;
    listTools: () => unknown[];
    listSkills: () => unknown[];
    listSkillCandidates: (options?: { status?: "proposed" | "approved" | "merged" | "rejected"; limit?: number }) => unknown[];
    buildSkillCandidates: (options?: { day?: Date; lookbackDays?: number; minOccurrences?: number; minScore?: number; dailyLimit?: number }) => unknown;
    approveSkillCandidate: (candidateId: string, options?: { reason?: string }) => Promise<unknown>;
    rejectSkillCandidate: (candidateId: string, reason?: string) => unknown;
    listRoles: () => Promise<unknown[]>;
    addRole: (input: {
      name: string;
      role: string;
      provider?: string;
      model?: string;
      temperature?: number;
      allowedTools?: string[];
      forbiddenTools?: string[];
      capabilities?: string[];
      skills?: string[];
      skillAllowlist?: string[];
      outputContract?: string;
      instructions: string;
    }) => Promise<unknown>;
    updateRoleProvider: (name: string, input: { provider?: string; model?: string; temperature?: number }) => Promise<unknown>;
    initializeDefaultRoles: (options?: { overwrite?: boolean }) => Promise<unknown[]>;
    listSessions: (options?: { status?: "active" | "hidden" | "trashed" | "deleted"; includeHidden?: boolean; includeTrashed?: boolean; includeDeleted?: boolean; limit?: number }) => unknown[];
    getSession: (sessionId: string) => unknown;
    createSession: (options?: { title?: string; source?: string; metadata?: Record<string, unknown> }) => unknown;
    clearSession: (sessionId: string, options?: { source?: string; reason?: string; nextTitle?: string }) => unknown;
    restoreSession: (sessionId: string) => unknown;
    trashSession: (sessionId: string, options?: { deleteAfterDays?: number; reason?: string }) => unknown;
    listSessionMessages: (options: { sessionId: string; limit?: number }) => unknown[];
    renderTimeline: (runId: string) => string;
    buildDailyExperiences: (options?: { day?: Date }) => unknown;
    health: () => unknown;
    maintenance: (options?: {
      day?: Date;
      staleRunMs?: number;
      maxEvents?: number;
      pruneMemoryCandidateDays?: number;
      maxFileMemoryRecords?: number;
      maxVectorMemoryRecords?: number;
      pruneArchivedExperienceVectorDays?: number;
      sessionTrashDays?: number;
      skillLookbackDays?: number;
      skillMinOccurrences?: number;
      skillMinScore?: number;
      skillDailyLimit?: number;
    }) => Promise<unknown>;
    roleAgentManager: NodeJS.EventEmitter;
  };
  port: number;
  host?: string;
  authToken?: string;
}): Promise<WebServerHandle> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
        return sendHtml(response, 200, webAppHtml({ authToken }));
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, runtime: runtime.health(), gateway: gatewayProtocolSpec() });
      }

      if (!isAuthorized(request, url, authToken)) {
        return sendJson(response, 401, { error: "Unauthorized" });
      }

      if (isUnsafeMethod(request.method) && !isAllowedOrigin(request, url)) {
        return sendJson(response, 403, { error: "Forbidden origin" });
      }

      if (request.method === "GET" && url.pathname === "/events-snapshot") {
        return sendJson(response, 200, runtime.taskStore.getLatestEvents({
          afterId: Number(url.searchParams.get("afterId") || 0),
          limit: parseLimit(url.searchParams.get("limit"), 50, 500),
        }));
      }

      if (request.method === "GET" && url.pathname === "/events") {
        return streamEvents({ runtime, request, response, afterId: Number(url.searchParams.get("afterId") || 0) });
      }

      if (request.method === "GET" && url.pathname === "/providers") {
        return sendJson(response, 200, runtime.listProviders());
      }

      if (request.method === "GET" && url.pathname === "/providers/health") {
        return sendJson(response, 200, await runtime.checkProviders({
          deep: url.searchParams.get("deep") === "true",
        }));
      }

      if (request.method === "GET" && url.pathname === "/providers/usage") {
        return sendJson(response, 200, runtime.providerUsage({
          since: parseDateParam(url.searchParams.get("since")),
          until: parseDateParam(url.searchParams.get("until")),
          providerId: url.searchParams.get("providerId") || undefined,
          limit: parseLimit(url.searchParams.get("limit"), 20, 500),
        }));
      }

      if (request.method === "GET" && url.pathname === "/providers/dashboard") {
        return sendHtml(response, 200, providerDashboardHtml(authToken));
      }

      if (request.method === "POST" && url.pathname === "/providers") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.addProvider({
          id: String(body.id || ""),
          type: parseProviderType(body.type),
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          config: typeof body.config === "object" && body.config ? body.config as Record<string, unknown> : undefined,
        }));
      }

      if (request.method === "POST" && url.pathname === "/providers/enable") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.enableProvider(String(body.id || body.providerId || "")));
      }

      if (request.method === "POST" && url.pathname === "/providers/disable") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.disableProvider(String(body.id || body.providerId || "")));
      }

      if (request.method === "DELETE" && url.pathname === "/providers") {
        return sendJson(response, 200, await runtime.removeProvider(String(url.searchParams.get("id") || url.searchParams.get("providerId") || "")));
      }

      if (request.method === "GET" && url.pathname === "/tools") {
        return sendJson(response, 200, runtime.listTools());
      }

      if (request.method === "GET" && url.pathname === "/skills") {
        return sendJson(response, 200, runtime.listSkills());
      }

      if (request.method === "GET" && url.pathname === "/skill-candidates") {
        return sendJson(response, 200, runtime.listSkillCandidates({
          status: parseSkillCandidateStatus(url.searchParams.get("status")),
          limit: parseLimit(url.searchParams.get("limit"), 50, 500),
        }));
      }

      if (request.method === "POST" && url.pathname === "/skill-candidates/build") {
        const body = await readJson(request);
        return sendJson(response, 200, runtime.buildSkillCandidates({
          day: typeof body.day === "string" ? new Date(body.day) : new Date(),
          lookbackDays: typeof body.lookbackDays === "number" ? body.lookbackDays : undefined,
          minOccurrences: typeof body.minOccurrences === "number" ? body.minOccurrences : undefined,
          minScore: typeof body.minScore === "number" ? body.minScore : undefined,
          dailyLimit: typeof body.dailyLimit === "number" ? body.dailyLimit : undefined,
        }));
      }

      if (request.method === "POST" && url.pathname === "/skill-candidates/approve") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.approveSkillCandidate(String(body.candidateId || body.id || ""), {
          reason: typeof body.reason === "string" ? body.reason : undefined,
        }));
      }

      if (request.method === "POST" && url.pathname === "/skill-candidates/reject") {
        const body = await readJson(request);
        return sendJson(response, 200, runtime.rejectSkillCandidate(String(body.candidateId || body.id || ""), String(body.reason || "rejected")));
      }

      if (request.method === "GET" && url.pathname === "/roles") {
        return sendJson(response, 200, await runtime.listRoles());
      }

      if (request.method === "POST" && url.pathname === "/roles") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.addRole({
          name: String(body.name || ""),
          role: String(body.role || body.name || ""),
          provider: typeof body.provider === "string" ? body.provider : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          temperature: typeof body.temperature === "number" ? body.temperature : undefined,
          allowedTools: Array.isArray(body.allowedTools) ? body.allowedTools.map(String) : undefined,
          forbiddenTools: Array.isArray(body.forbiddenTools) ? body.forbiddenTools.map(String) : undefined,
          capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : undefined,
          skills: Array.isArray(body.skills) ? body.skills.map(String) : undefined,
          skillAllowlist: Array.isArray(body.skillAllowlist) ? body.skillAllowlist.map(String) : undefined,
          outputContract: typeof body.outputContract === "string" ? body.outputContract : undefined,
          instructions: String(body.instructions || "Follow the task requirements and return a concise result."),
        }));
      }

      if (request.method === "POST" && url.pathname === "/roles/defaults") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.initializeDefaultRoles({
          overwrite: body.overwrite === true,
        }));
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        return sendJson(response, 200, runtime.listSessions({
          status: parseSessionStatus(url.searchParams.get("status")),
          includeHidden: url.searchParams.get("includeHidden") === "true",
          includeTrashed: url.searchParams.get("includeTrashed") === "true",
          includeDeleted: url.searchParams.get("includeDeleted") === "true",
          limit: parseLimit(url.searchParams.get("limit"), 50, 500),
        }));
      }

      if (request.method === "GET" && url.pathname === "/sessions/messages") {
        return sendJson(response, 200, runtime.listSessionMessages({
          sessionId: String(url.searchParams.get("sessionId") || ""),
          limit: parseLimit(url.searchParams.get("limit"), 100, 500),
        }));
      }

      if (request.method === "POST" && url.pathname === "/sessions/new") {
        const body = await readJson(request);
        return sendJson(response, 200, runtime.createSession({
          title: typeof body.title === "string" ? body.title : "New session",
          source: typeof body.source === "string" ? body.source : "web",
          metadata: { createdBy: "web" },
        }));
      }

      if (request.method === "POST" && url.pathname === "/sessions/clear") {
        const body = await readJson(request);
        return sendJson(response, 200, runtime.clearSession(String(body.sessionId || ""), {
          source: "web",
          reason: typeof body.reason === "string" ? body.reason : "cleared from web",
          nextTitle: typeof body.nextTitle === "string" ? body.nextTitle : "New session",
        }));
      }

      if (request.method === "POST" && url.pathname === "/sessions/restore") {
        const body = await readJson(request);
        return sendJson(response, 200, runtime.restoreSession(String(body.sessionId || body.id || "")));
      }

      if (request.method === "POST" && url.pathname === "/sessions/trash") {
        const body = await readJson(request);
        return sendJson(response, 200, runtime.trashSession(String(body.sessionId || body.id || ""), {
          deleteAfterDays: typeof body.deleteAfterDays === "number" ? body.deleteAfterDays : 30,
          reason: typeof body.reason === "string" ? body.reason : "trashed from web",
        }));
      }

      if (request.method === "POST" && url.pathname === "/roles/provider") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.updateRoleProvider(String(body.name || ""), {
          provider: typeof body.provider === "string" ? body.provider : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          temperature: typeof body.temperature === "number" ? body.temperature : undefined,
        }));
      }

      if (request.method === "GET" && url.pathname === "/experiences") {
        const query = url.searchParams.get("q");
        const result = query
          ? runtime.experienceStore.recall(query, { scope: "project", limit: parseLimit(url.searchParams.get("limit"), 5, 100) })
          : runtime.experienceStore.listActive();
        return sendJson(response, 200, result);
      }

      if (request.method === "GET" && url.pathname === "/timeline") {
        const runId = String(url.searchParams.get("runId") || "");
        if (url.searchParams.get("format") === "text") {
          response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          response.end(runtime.renderTimeline(runId));
          return;
        }
        return sendJson(response, 200, runtime.getTimeline({
          runId,
        }));
      }

      if (request.method === "GET" && url.pathname === "/task-trace") {
        return sendJson(response, 200, runtime.getTaskTrace(String(url.searchParams.get("taskId") || "")));
      }

      if (request.method === "GET" && url.pathname === "/diagnostics") {
        return sendJson(response, 200, runtime.diagnostics({
          repair: false,
        }));
      }

      if (request.method === "GET" && url.pathname === "/security/audit") {
        return sendJson(response, 200, await runtime.securityAudit());
      }

      if (request.method === "GET" && url.pathname === "/context") {
        return sendJson(response, 200, await runtime.buildContext({
          query: String(url.searchParams.get("q") || url.searchParams.get("query") || ""),
          sessionId: String(url.searchParams.get("sessionId") || "web"),
          runId: url.searchParams.get("runId"),
          role: String(url.searchParams.get("role") || "web"),
          mode: url.searchParams.get("mode") === "deep" ? "deep" : "active",
        }));
      }

      if (request.method === "GET" && url.pathname === "/route") {
        return sendJson(response, 200, runtime.routeMessage(String(url.searchParams.get("q") || url.searchParams.get("input") || "")));
      }

      if (request.method === "POST" && url.pathname === "/diagnostics/repair") {
        return sendJson(response, 200, runtime.diagnostics({ repair: true }));
      }

      if (request.method === "POST" && url.pathname === "/experiences/build-daily") {
        const body = await readJson(request);
        const result = runtime.buildDailyExperiences({
          day: typeof body.day === "string" ? new Date(body.day) : new Date(),
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/maintenance") {
        const body = await readJson(request);
        const result = await runtime.maintenance({
          day: typeof body.day === "string" ? new Date(body.day) : new Date(),
          staleRunMs: typeof body.staleRunMs === "number" ? body.staleRunMs : undefined,
          maxEvents: typeof body.maxEvents === "number" ? body.maxEvents : undefined,
          pruneMemoryCandidateDays: typeof body.pruneMemoryCandidateDays === "number" ? body.pruneMemoryCandidateDays : undefined,
          maxFileMemoryRecords: typeof body.maxFileMemoryRecords === "number" ? body.maxFileMemoryRecords : undefined,
          maxVectorMemoryRecords: typeof body.maxVectorMemoryRecords === "number" ? body.maxVectorMemoryRecords : undefined,
          pruneArchivedExperienceVectorDays: typeof body.pruneArchivedExperienceVectorDays === "number" ? body.pruneArchivedExperienceVectorDays : undefined,
          sessionTrashDays: typeof body.sessionTrashDays === "number" ? body.sessionTrashDays : undefined,
          skillLookbackDays: typeof body.skillLookbackDays === "number" ? body.skillLookbackDays : undefined,
          skillMinOccurrences: typeof body.skillMinOccurrences === "number" ? body.skillMinOccurrences : undefined,
          skillMinScore: typeof body.skillMinScore === "number" ? body.skillMinScore : undefined,
          skillDailyLimit: typeof body.skillDailyLimit === "number" ? body.skillDailyLimit : undefined,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/experiences/feedback") {
        const body = await readJson(request);
        const result = runtime.experienceStore.addFeedback({
          experienceId: String(body.experienceId || ""),
          rating: parseFeedbackRating(body.rating),
          comment: String(body.comment || ""),
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/cancel-task") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.cancelTask(String(body.taskId || ""), String(body.reason || "cancelled by user")));
      }

      if (request.method === "POST" && url.pathname === "/cancel-run") {
        const body = await readJson(request);
        return sendJson(response, 200, await runtime.cancelRun(String(body.runId || ""), String(body.reason || "cancelled by user")));
      }

      if (request.method === "POST" && url.pathname === "/chat") {
        const body = await readJson(request);
        const result = await runtime.handleUserMessage(String(body.message || ""), {
          sessionId: String(body.sessionId || "web"),
          source: "web",
        });
        return sendJson(response, 200, result);
      }

      sendJson(response, 404, {
        error: "Not found",
        routes: ["GET /", "GET /health", "GET /gateway (websocket upgrade)", "GET /events", "GET /events-snapshot", "GET /providers", "GET /providers/health", "GET /providers/usage", "GET /providers/dashboard", "POST /providers", "GET /tools", "GET /skills", "GET /skill-candidates", "POST /skill-candidates/build", "POST /skill-candidates/approve", "POST /skill-candidates/reject", "GET /roles", "POST /roles", "POST /roles/defaults", "GET /sessions", "GET /sessions/messages", "POST /sessions/new", "POST /sessions/clear", "POST /sessions/restore", "POST /sessions/trash", "POST /roles/provider", "GET /experiences", "GET /timeline", "GET /task-trace", "GET /diagnostics", "GET /security/audit", "GET /context", "GET /route", "POST /diagnostics/repair", "POST /maintenance", "POST /cancel-task", "POST /cancel-run", "POST /experiences/build-daily", "POST /experiences/feedback", "POST /chat"],
      });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname !== "/gateway" && url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!isAuthorized(request, url, authToken)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (!isAllowedOrigin(request, url)) {
      rejectUpgrade(socket, 403, "Forbidden origin");
      return;
    }
    acceptGatewaySocket({ runtime, request, socket, head });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${resolvedPort}`;
  console.log(`Emily Agent web adapter listening on ${url}`);
  console.log(`Emily Agent web token: ${authToken}`);
  return {
    server,
    authToken,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function parseFeedbackRating(value: unknown): "useful" | "wrong" | "outdated" | "duplicate" {
  if (value === "useful" || value === "wrong" || value === "outdated" || value === "duplicate") return value;
  throw new Error("Invalid feedback rating");
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, max);
}

function isUnsafeMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isAuthorized(request: IncomingMessage, url: URL, authToken: string): boolean {
  const presented = authTokenFromRequest(request, url);
  return Boolean(presented && safeTokenEquals(presented, authToken));
}

function authTokenFromRequest(request: IncomingMessage, url: URL): string {
  const headerToken = request.headers["x-emily-token"];
  if (typeof headerToken === "string") return headerToken;
  const authorization = request.headers.authorization || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return bearer[1];
  return url.searchParams.get("token") || "";
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAllowedOrigin(request: IncomingMessage, url: URL): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === url.origin;
}

function parseProviderType(value: unknown): "echo" | "openai" | "ollama" {
  if (value === "echo" || value === "openai" || value === "ollama") return value;
  throw new Error("Invalid provider type");
}

function parseSkillCandidateStatus(value: string | null): "proposed" | "approved" | "merged" | "rejected" | undefined {
  if (!value) return undefined;
  if (value === "proposed" || value === "approved" || value === "merged" || value === "rejected") return value;
  throw new Error("Invalid skill candidate status");
}

function parseSessionStatus(value: string | null): "active" | "hidden" | "trashed" | "deleted" | undefined {
  if (!value) return undefined;
  if (value === "active" || value === "hidden" || value === "trashed" || value === "deleted") return value;
  throw new Error("Invalid session status");
}

function parseDateParam(value: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function streamEvents({
  runtime,
  request,
  response,
  afterId,
}: {
  runtime: {
    taskStore: { getLatestEvents: (options?: { afterId?: number; limit?: number }) => unknown[] };
    roleAgentManager: NodeJS.EventEmitter;
  };
  request: IncomingMessage;
  response: ServerResponse;
  afterId: number;
}): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  for (const event of runtime.taskStore.getLatestEvents({ afterId, limit: 100 })) {
    writeSse(response, "stored-event", event);
  }

  const onEvent = (event: unknown) => {
    writeSse(response, "runtime-event", event);
  };

  const keepAlive = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, 15000);

  runtime.roleAgentManager.on("event", onEvent);
  request.on("close", () => {
    clearInterval(keepAlive);
    runtime.roleAgentManager.off("event", onEvent);
  });
}

function writeSse(response: ServerResponse, event: string, payload: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function acceptGatewaySocket({
  runtime,
  request,
  socket,
  head,
}: {
  runtime: {
    taskStore: { addEvent?: (input: { type: string; payload?: Record<string, unknown> }) => number };
    roleAgentManager: NodeJS.EventEmitter;
  } & Parameters<typeof dispatchGatewayRequest>[0];
  request: IncomingMessage;
  socket: Socket;
  head: Buffer;
}): void {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    rejectUpgrade(socket, 400, "Missing Sec-WebSocket-Key");
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  const connection = new WebSocketConnection(socket);
  runtime.taskStore.addEvent?.({
    type: "gateway.connected",
    payload: { remoteAddress: socket.remoteAddress || "" },
  });

  const onRuntimeEvent = (event: unknown) => {
    connection.send(gatewayEvent("runtime.event", event));
  };
  runtime.roleAgentManager.on("event", onRuntimeEvent);
  socket.on("close", () => {
    runtime.roleAgentManager.off("event", onRuntimeEvent);
  });
  connection.onMessage = async (message) => {
    let requestId = "";
    try {
      const parsed = parseGatewayRequest(JSON.parse(message));
      requestId = parsed.id;
      runtime.taskStore.addEvent?.({
        type: "gateway.request",
        payload: { id: parsed.id, method: parsed.method },
      });
      const response = await dispatchGatewayRequest(runtime, parsed);
      runtime.taskStore.addEvent?.({
        type: "gateway.response",
        payload: { id: response.id, ok: response.ok, method: parsed.method },
      });
      connection.send(response);
    } catch (error) {
      connection.send({
        type: "response",
        id: requestId || "unknown",
        ok: false,
        error: {
          code: "invalid_gateway_message",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
  if (head.length) connection.push(head);
  connection.send(gatewayEvent("gateway.ready", gatewayProtocolSpec()));
}

class WebSocketConnection {
  socket: Socket;
  buffer = Buffer.alloc(0);
  onMessage: (message: string) => void | Promise<void> = () => undefined;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.push(chunk));
  }

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      let frame: { opcode: number; payload: Buffer; bytes: number } | null;
      try {
        frame = readFrame(this.buffer);
      } catch (error) {
        this.send({
          type: "response",
          id: "unknown",
          ok: false,
          error: {
            code: "invalid_websocket_frame",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        this.socket.end();
        return;
      }
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytes);
      if (frame.opcode === 8) {
        this.socket.end();
        return;
      }
      if (frame.opcode === 9) {
        this.writeFrame(frame.payload, 10);
        continue;
      }
      if (frame.opcode !== 1) continue;
      Promise.resolve(this.onMessage(frame.payload.toString("utf8"))).catch((error) => {
        this.send({
          type: "response",
          id: "unknown",
          ok: false,
          error: {
            code: "gateway_handler_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
  }

  send(payload: unknown): void {
    this.writeFrame(Buffer.from(JSON.stringify(payload), "utf8"), 1);
  }

  private writeFrame(payload: Buffer, opcode: number): void {
    const header: number[] = [0x80 | opcode];
    if (payload.length < 126) {
      header.push(payload.length);
    } else if (payload.length <= 0xffff) {
      header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
    } else {
      header.push(127, 0, 0, 0, 0, (payload.length / 2 ** 24) & 0xff, (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff);
    }
    this.socket.write(Buffer.concat([Buffer.from(header), payload]));
  }
}

function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; bytes: number } | null {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) throw new Error("WebSocket frame is too large.");
    length = low;
    offset += 8;
  }
  if (length > 1024 * 1024) throw new Error("WebSocket frame exceeds 1048576 bytes.");
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, bytes: offset + length };
}

function rejectUpgrade(socket: Socket, statusCode: number, reason: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendHtml(response: ServerResponse, statusCode: number, payload: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(payload);
}

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function readJson(request: IncomingMessage, { maxBytes = 1024 * 1024 }: { maxBytes?: number } = {}): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maxBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "JSON body must be an object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function providerDashboardHtml(authToken: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Emily Provider Observability</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f5; color: #171717; }
    main { max-width: 1120px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin: 0 0 18px; }
    h2 { font-size: 16px; margin: 20px 0 10px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .metric, table { background: white; border: 1px solid #deded8; border-radius: 8px; }
    .metric { padding: 14px; }
    .label { color: #666; font-size: 12px; }
    .value { font-size: 22px; font-weight: 700; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; margin-bottom: 14px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #ecece8; font-size: 13px; white-space: nowrap; }
    th { background: #f0f0eb; color: #444; }
    @media (max-width: 760px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } main { padding: 16px; } table { display: block; overflow-x: auto; } }
  </style>
</head>
<body>
<main>
  <h1>Provider Observability</h1>
  <section class="grid" id="metrics"></section>
  <h2>Providers</h2>
  <table><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th><th>Avg Latency</th><th>Blocked</th></tr></thead><tbody id="providers"></tbody></table>
  <h2>Recent Calls</h2>
  <table><thead><tr><th>Time</th><th>Provider</th><th>Agent</th><th>Status</th><th>Error</th><th>Cost</th></tr></thead><tbody id="recent"></tbody></table>
</main>
<script>
async function load() {
  const data = await fetch('/providers/usage', { headers: { 'x-emily-token': ${JSON.stringify(authToken)} } }).then((res) => res.json());
  const metrics = [
    ['Calls', data.totals.calls],
    ['Success', data.totals.success],
    ['Tokens', data.totals.totalTokens],
    ['Cost USD', '$' + data.totals.costUsd.toFixed(6)]
  ];
  document.getElementById('metrics').innerHTML = metrics.map(([label, value]) => '<div class="metric"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value) + '</div></div>').join('');
  document.getElementById('providers').innerHTML = data.providers.map((item) => '<tr><td>' + escapeHtml(item.providerId) + '</td><td>' + escapeHtml(item.model) + '</td><td>' + escapeHtml(item.calls) + '</td><td>' + escapeHtml(item.totalTokens) + '</td><td>$' + escapeHtml(Number(item.costUsd || 0).toFixed(6)) + '</td><td>' + escapeHtml(item.avgLatencyMs) + 'ms</td><td>' + escapeHtml(item.blocked) + '</td></tr>').join('');
  document.getElementById('recent').innerHTML = data.recent.map((item) => '<tr><td>' + escapeHtml(item.createdAt) + '</td><td>' + escapeHtml(item.providerId) + '</td><td>' + escapeHtml(item.agent) + '</td><td>' + escapeHtml(item.status) + '</td><td>' + escapeHtml(item.errorCode || '') + '</td><td>$' + escapeHtml(Number(item.costUsd || 0).toFixed(6)) + '</td></tr>').join('');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}
