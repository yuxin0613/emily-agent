import http, { type IncomingMessage, type ServerResponse } from "node:http";

export async function startWebServer({
  runtime,
  port,
  host = "127.0.0.1",
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
    cancelTask: (taskId: string, reason?: string) => Promise<unknown>;
    cancelRun: (runId: string, reason?: string) => Promise<unknown>;
    listProviders: () => unknown[];
    checkProviders: (options?: { deep?: boolean }) => Promise<unknown[]>;
    addProvider: (input: { id: string; type: "echo" | "openai" | "ollama"; enabled?: boolean; model?: string; config?: Record<string, unknown> }) => Promise<unknown>;
    enableProvider: (providerId: string) => Promise<unknown>;
    disableProvider: (providerId: string) => Promise<unknown>;
    removeProvider: (providerId: string) => Promise<unknown>;
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
      outputContract?: string;
      instructions: string;
    }) => Promise<unknown>;
    updateRoleProvider: (name: string, input: { provider?: string; model?: string; temperature?: number }) => Promise<unknown>;
    initializeDefaultRoles: (options?: { overwrite?: boolean }) => Promise<unknown[]>;
    renderTimeline: (runId: string) => string;
    buildDailyExperiences: (options?: { day?: Date }) => unknown;
    health: () => unknown;
    maintenance: (options?: { day?: Date; staleRunMs?: number; maxEvents?: number; pruneMemoryCandidateDays?: number }) => Promise<unknown>;
    roleAgentManager: NodeJS.EventEmitter;
  };
  port: number;
  host?: string;
}): Promise<void> {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, runtime: runtime.health() });
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
          ? runtime.experienceStore.recall(query, { scope: "project", limit: Number(url.searchParams.get("limit") || 5) })
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
          repair: url.searchParams.get("repair") === "true",
        }));
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
        routes: ["GET /health", "GET /events", "GET /providers", "GET /providers/health", "POST /providers", "GET /roles", "POST /roles", "POST /roles/defaults", "POST /roles/provider", "GET /experiences", "GET /timeline", "GET /task-trace", "GET /diagnostics", "POST /maintenance", "POST /cancel-task", "POST /cancel-run", "POST /experiences/build-daily", "POST /experiences/feedback", "POST /chat"],
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`Emily Agent web adapter listening on http://${host}:${port}`);
}

function parseFeedbackRating(value: unknown): "useful" | "wrong" | "outdated" | "duplicate" {
  if (value === "useful" || value === "wrong" || value === "outdated" || value === "duplicate") return value;
  throw new Error("Invalid feedback rating");
}

function parseProviderType(value: unknown): "echo" | "openai" | "ollama" {
  if (value === "echo" || value === "openai" || value === "ollama") return value;
  throw new Error("Invalid provider type");
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

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}
