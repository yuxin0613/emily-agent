import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP, type Socket } from "node:net";
import { CommandPermissionError, assertPermissionModeWithinCommandPermission, type CommandPermission } from "../commands/CommandRegistry.ts";
import { dispatchGatewayRequest, gatewayEvent, gatewayProtocolSpec, parseGatewayRequest } from "../gateway/GatewayProtocol.ts";
import { webAppHtml } from "./webUi.ts";
import type { Metadata, ToolPermission } from "../types.ts";

const GATEWAY_MAX_IN_FLIGHT = 4;
const GATEWAY_RATE_WINDOW_MS = 10_000;
const GATEWAY_MAX_MESSAGES_PER_WINDOW = 60;
const GATEWAY_IDLE_TIMEOUT_MS = 120_000;

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
  authToken,
  readAuthToken = process.env.EMILY_WEB_READ_TOKEN || "",
  writeAuthToken = process.env.EMILY_WEB_WRITE_TOKEN || "",
}: {
  runtime: {
    handleUserMessage: (message: string, context: { sessionId?: string; source?: string; permissionMode?: unknown }) => Promise<unknown>;
    taskStore: {
      getLatestEvents: (options?: { afterId?: number; limit?: number }) => unknown[];
      addEvent?: (input: { type: string; payload?: Metadata }) => number;
    };
    experienceStore: {
      listActive: () => unknown[];
      recall: (query: string, options?: { scope?: "project"; limit?: number }) => unknown[];
      addFeedback: (input: { experienceId: string; rating: "useful" | "wrong" | "outdated" | "duplicate"; comment?: string }) => unknown;
    };
    getTimeline: (options: { runId: string }) => unknown;
    getTaskTrace: (taskId: string) => unknown;
    diagnostics: (options?: { repair?: boolean }) => unknown;
    securityAudit: (options?: { emit?: boolean }) => Promise<unknown>;
    doctor: (options?: { deep?: boolean; repair?: boolean }) => Promise<unknown>;
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
      allowedTools?: ToolPermission[];
      forbiddenTools?: ToolPermission[];
      capabilities?: string[];
      skills?: string[];
      skillAllowlist?: string[];
      outputContract?: string;
      instructions: string;
    }) => Promise<unknown>;
    updateRoleProvider: (name: string, input: { provider?: string | null; model?: string | null; temperature?: number | null }) => Promise<unknown>;
    initializeDefaultRoles: (options?: { overwrite?: boolean }) => Promise<unknown[]>;
    listSessions: (options?: { status?: "active" | "hidden" | "trashed" | "deleted"; includeHidden?: boolean; includeTrashed?: boolean; includeDeleted?: boolean; limit?: number }) => unknown[];
    getSession: (sessionId: string) => unknown;
    createSession: (options?: { title?: string; source?: string; metadata?: Metadata }) => unknown;
    clearSession: (sessionId: string, options?: { source?: string; reason?: string; nextTitle?: string }) => unknown;
    restoreSession: (sessionId: string) => unknown;
    trashSession: (sessionId: string, options?: { deleteAfterDays?: number; reason?: string }) => unknown;
    listSessionMessages: (options: { sessionId: string; limit?: number }) => unknown[];
    resumeLatestSession: (options?: { includeHidden?: boolean }) => unknown;
    exportSession: (sessionId: string, options?: { format?: "json" | "markdown" }) => unknown;
    previewSessionCompaction: (sessionId: string, options?: { maxMessages?: number }) => unknown;
    sessionUsage: (sessionId: string) => unknown;
    listCommands: () => unknown[];
    runCommand: (name: string, options?: { args?: string[]; input?: Record<string, unknown>; format?: "json" | "text"; maxPermission?: "read" | "write" | "danger" }) => Promise<unknown>;
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
  readAuthToken?: string;
  writeAuthToken?: string;
}): Promise<WebServerHandle> {
  const resolvedAuthToken = authToken || process.env.EMILY_WEB_TOKEN || randomUUID();
  const generatedAuthToken = !authToken && !process.env.EMILY_WEB_TOKEN;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app")) {
        if (url.searchParams.has("token") && !isLoopbackQueryTokenRequest(request, url)) {
          return sendJson(response, 400, { error: "Query token authentication is only allowed from loopback. Use x-emily-token or Authorization instead." });
        }
        return sendHtml(response, 200, webAppHtml());
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true });
      }

      const auth = authenticate(request, url, { authToken: resolvedAuthToken, readAuthToken, writeAuthToken }, {
        allowQueryToken: isLoopbackQueryTokenRequest(request, url),
      });
      if (!auth) {
        return sendJson(response, 401, { error: "Unauthorized" });
      }

      if (isUnsafeMethod(request.method) && !isAllowedOrigin(request, url)) {
        return sendJson(response, 403, { error: "Forbidden origin" });
      }

      if (isUnsafeMethod(request.method) && !canUsePermission(auth.maxPermission, "write")) {
        return sendJson(response, 403, { error: `This token is limited to ${auth.maxPermission} permission.` });
      }

      const runCommand = (
        name: string,
        options: { args?: string[]; input?: Record<string, unknown>; format?: "json" | "text"; maxPermission?: CommandPermission } = {},
      ) => runtime.runCommand(name, {
        ...options,
        maxPermission: minCommandPermission(options.maxPermission, auth.maxPermission),
      });

      if (request.method === "GET" && url.pathname === "/health/detail") {
        return sendJson(response, 200, { ok: true, runtime: runtime.health(), gateway: gatewayProtocolSpec() });
      }

      if (request.method === "GET" && url.pathname === "/events-snapshot") {
        return sendJson(response, 200, runtime.taskStore.getLatestEvents({
          afterId: Number(url.searchParams.get("afterId") || 0),
          limit: parseLimit(url.searchParams.get("limit"), 50, 500),
        }));
      }

      if (request.method === "GET" && url.pathname === "/doctor") {
        if (url.searchParams.get("repair") === "true" && !canUsePermission(auth.maxPermission, "write")) {
          return sendJson(response, 403, { error: `Doctor repair requires write permission; token is limited to ${auth.maxPermission}.` });
        }
        return sendJson(response, 200, await runCommand("doctor", {
          input: {
            deep: url.searchParams.get("deep") === "true",
            repair: url.searchParams.get("repair") === "true",
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/events") {
        return streamEvents({ runtime, request, response, afterId: Number(url.searchParams.get("afterId") || 0) });
      }

      if (request.method === "GET" && url.pathname === "/providers") {
        return sendJson(response, 200, await runCommand("providers"));
      }

      if (request.method === "GET" && url.pathname === "/providers/health") {
        return sendJson(response, 200, await runCommand("provider.health", {
          input: { deep: url.searchParams.get("deep") === "true" },
        }));
      }

      if (request.method === "GET" && url.pathname === "/providers/usage") {
        return sendJson(response, 200, await runCommand("provider.usage", {
          input: {
            since: url.searchParams.get("since") || undefined,
            until: url.searchParams.get("until") || undefined,
            providerId: url.searchParams.get("providerId") || undefined,
            limit: parseLimit(url.searchParams.get("limit"), 20, 500),
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/settings") {
        return sendJson(response, 200, await runCommand("settings.get"));
      }

      if (request.method === "POST" && url.pathname === "/settings") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("settings.update", { input: body }));
      }

      if (request.method === "GET" && url.pathname === "/providers/dashboard") {
        return sendHtml(response, 200, providerDashboardHtml());
      }

      if (request.method === "POST" && url.pathname === "/providers") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("provider.add", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/providers/enable") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("provider.enable", {
          input: { providerId: String(body.id || body.providerId || "") },
        }));
      }

      if (request.method === "POST" && url.pathname === "/providers/disable") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("provider.disable", {
          input: { providerId: String(body.id || body.providerId || "") },
        }));
      }

      if (request.method === "DELETE" && url.pathname === "/providers") {
        return sendJson(response, 200, await runCommand("provider.remove", {
          input: { providerId: String(url.searchParams.get("id") || url.searchParams.get("providerId") || "") },
        }));
      }

      if (request.method === "GET" && url.pathname === "/tools") {
        return sendJson(response, 200, await runCommand("tools"));
      }

      if (request.method === "GET" && url.pathname === "/subagents") {
        return sendJson(response, 200, await runCommand("subagents.list", {
          input: { includeIdle: url.searchParams.get("includeIdle") === "true" },
        }));
      }

      if (request.method === "POST" && url.pathname === "/tools/execute") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("tool.execute", { input: body }));
      }

      if (request.method === "GET" && url.pathname === "/skills") {
        return sendJson(response, 200, await runCommand("skills"));
      }

      if (request.method === "GET" && url.pathname === "/commands") {
        return sendJson(response, 200, runtime.listCommands());
      }

      if (request.method === "GET" && url.pathname === "/cron") {
        return sendJson(response, 200, await runCommand("cron.list", {
          input: { includePaused: url.searchParams.get("activeOnly") !== "true" },
        }));
      }

      if (request.method === "POST" && url.pathname === "/cron") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("cron.create", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/cron/update") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("cron.update", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/cron/pause") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("cron.pause", { input: { id: String(body.id || "") } }));
      }

      if (request.method === "POST" && url.pathname === "/cron/resume") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("cron.resume", { input: { id: String(body.id || "") } }));
      }

      if (request.method === "POST" && url.pathname === "/cron/run") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("cron.run", { input: { id: String(body.id || "") } }));
      }

      if (request.method === "DELETE" && url.pathname === "/cron") {
        return sendJson(response, 200, await runCommand("cron.delete", {
          input: { id: String(url.searchParams.get("id") || "") },
        }));
      }

      if (request.method === "POST" && url.pathname === "/commands/run") {
        const body = await readJson(request);
        const result = await runCommand(String(body.name || body.command || ""), {
          args: Array.isArray(body.args) ? body.args.map(String) : [],
          input: typeof body.input === "object" && body.input && !Array.isArray(body.input) ? body.input as Record<string, unknown> : body,
          format: body.format === "text" ? "text" : "json",
          maxPermission: "read",
        });
        return body.format === "text"
          ? sendText(response, 200, String(result), "text/plain; charset=utf-8")
          : sendJson(response, 200, result);
      }

      if (request.method === "GET" && url.pathname === "/skill-candidates") {
        return sendJson(response, 200, await runCommand("skills.candidates.list", {
          input: {
            status: url.searchParams.get("status") || undefined,
            limit: parseLimit(url.searchParams.get("limit"), 50, 500),
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/skill-candidates/build") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("skills.candidates.build", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/skill-candidates/approve") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("skills.candidates.approve", {
          input: {
            candidateId: String(body.candidateId || body.id || ""),
            reason: typeof body.reason === "string" ? body.reason : undefined,
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/skill-candidates/reject") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("skills.candidates.reject", {
          input: {
            candidateId: String(body.candidateId || body.id || ""),
            reason: String(body.reason || "rejected"),
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/roles") {
        return sendJson(response, 200, await runCommand("roles"));
      }

      if (request.method === "POST" && url.pathname === "/roles") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("role.add", {
          input: {
            ...body,
            role: typeof body.role === "string" ? body.role : String(body.name || ""),
            instructions: typeof body.instructions === "string" ? body.instructions : "Follow the task requirements and return a concise result.",
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/roles/defaults") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("role.initialize_defaults", {
          input: { overwrite: body.overwrite === true },
        }));
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        return sendJson(response, 200, await runCommand("session.list", {
          input: {
            status: url.searchParams.get("status") || undefined,
            includeHidden: url.searchParams.get("includeHidden") === "true",
            includeTrashed: url.searchParams.get("includeTrashed") === "true",
            includeDeleted: url.searchParams.get("includeDeleted") === "true",
            limit: parseLimit(url.searchParams.get("limit"), 50, 500),
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/sessions/messages") {
        return sendJson(response, 200, await runCommand("session.messages", {
          input: {
            sessionId: String(url.searchParams.get("sessionId") || ""),
            limit: parseLimit(url.searchParams.get("limit"), 100, 500),
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/sessions/resume-latest") {
        return sendJson(response, 200, await runCommand("session.resume_latest", {
          input: { includeHidden: url.searchParams.get("includeHidden") === "true" },
        }));
      }

      if (request.method === "GET" && url.pathname === "/sessions/export") {
        const format = url.searchParams.get("format") === "markdown" ? "markdown" : "json";
        const result = await runCommand("session.export", {
          input: { sessionId: String(url.searchParams.get("sessionId") || ""), format },
          format: format === "markdown" ? "text" : "json",
        });
        return format === "markdown"
          ? sendText(response, 200, String(result), "text/markdown; charset=utf-8")
          : sendJson(response, 200, result);
      }

      if (request.method === "GET" && url.pathname === "/sessions/compact-preview") {
        return sendJson(response, 200, await runCommand("session.compact_preview", {
          input: {
            sessionId: String(url.searchParams.get("sessionId") || ""),
            maxMessages: parseLimit(url.searchParams.get("maxMessages"), 20, 200),
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/sessions/usage") {
        return sendJson(response, 200, await runCommand("session.usage", {
          input: { sessionId: String(url.searchParams.get("sessionId") || "") },
        }));
      }

      if (request.method === "POST" && url.pathname === "/sessions/new") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("session.create", {
          input: {
            title: typeof body.title === "string" ? body.title : "New session",
            source: typeof body.source === "string" ? body.source : "web",
            metadata: { createdBy: "web" },
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/sessions/clear") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("session.clear", {
          input: {
            sessionId: String(body.sessionId || ""),
            source: "web",
            reason: typeof body.reason === "string" ? body.reason : "cleared from web",
            nextTitle: typeof body.nextTitle === "string" ? body.nextTitle : "New session",
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/sessions/restore") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("session.restore", {
          input: { sessionId: String(body.sessionId || body.id || "") },
        }));
      }

      if (request.method === "POST" && url.pathname === "/sessions/trash") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("session.trash", {
          input: {
            sessionId: String(body.sessionId || body.id || ""),
            deleteAfterDays: typeof body.deleteAfterDays === "number" ? body.deleteAfterDays : 30,
            reason: typeof body.reason === "string" ? body.reason : "trashed from web",
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/roles/provider") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("role.update_provider", {
          input: {
            name: String(body.name || ""),
            provider: typeof body.provider === "string" ? body.provider : undefined,
            model: typeof body.model === "string" ? body.model : undefined,
            temperature: typeof body.temperature === "number" ? body.temperature : undefined,
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/experiences") {
        return sendJson(response, 200, await runCommand("experiences.recall", {
          input: {
            q: url.searchParams.get("q") || undefined,
            limit: parseLimit(url.searchParams.get("limit"), 5, 100),
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/timeline") {
        const runId = String(url.searchParams.get("runId") || "");
        if (url.searchParams.get("format") === "text") {
          return sendText(response, 200, String(await runCommand("timeline.get", {
            input: { runId },
            format: "text",
          })), "text/plain; charset=utf-8");
        }
        return sendJson(response, 200, await runCommand("timeline.get", {
          input: { runId },
        }));
      }

      if (request.method === "GET" && url.pathname === "/dag") {
        const dagInput = {
          activeOnly: url.searchParams.get("activeOnly") === "true" || url.searchParams.get("mode") === "active",
          limit: url.searchParams.get("limit") || undefined,
        };
        if (url.searchParams.get("format") === "text") {
          return sendText(response, 200, String(await runCommand("dag.list", {
            input: dagInput,
            format: "text",
          })), "text/plain; charset=utf-8");
        }
        return sendJson(response, 200, await runCommand("dag.list", { input: dagInput }));
      }

      if (request.method === "GET" && url.pathname === "/graph") {
        const runId = String(url.searchParams.get("runId") || "");
        if (url.searchParams.get("format") === "text") {
          return sendText(response, 200, String(await runCommand("graph.view", {
            input: { runId },
            format: "text",
          })), "text/plain; charset=utf-8");
        }
        return sendJson(response, 200, await runCommand("graph.view", {
          input: { runId },
        }));
      }

      if (request.method === "GET" && url.pathname === "/graph-node") {
        return sendJson(response, 200, await runCommand("graph.node", {
          input: {
            runId: String(url.searchParams.get("runId") || ""),
            selector: String(url.searchParams.get("selector") || ""),
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/graph/add") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("graph.add", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/graph/add-before") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("graph.add_before", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/graph/add-after") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("graph.add_after", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/graph/update") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("graph.update", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/graph/delete") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("graph.delete", { input: body }));
      }

      if (request.method === "GET" && url.pathname === "/task-trace") {
        return sendJson(response, 200, await runCommand("task.trace", {
          input: { taskId: String(url.searchParams.get("taskId") || "") },
        }));
      }

      if (request.method === "GET" && url.pathname === "/diagnostics") {
        return sendJson(response, 200, await runCommand("diagnostics.run"));
      }

      if (request.method === "GET" && url.pathname === "/security/audit") {
        return sendJson(response, 200, await runCommand("security.audit"));
      }

      if (request.method === "GET" && url.pathname === "/context") {
        return sendJson(response, 200, await runCommand("context.build", {
          input: {
            query: String(url.searchParams.get("q") || url.searchParams.get("query") || ""),
            sessionId: String(url.searchParams.get("sessionId") || "web"),
            runId: url.searchParams.get("runId") || undefined,
            role: String(url.searchParams.get("role") || "web"),
            mode: url.searchParams.get("mode") === "deep" ? "deep" : "active",
          },
        }));
      }

      if (request.method === "GET" && url.pathname === "/route") {
        return sendJson(response, 200, await runCommand("router.route", {
          input: { input: String(url.searchParams.get("q") || url.searchParams.get("input") || "") },
        }));
      }

      if (request.method === "POST" && url.pathname === "/diagnostics/repair") {
        return sendJson(response, 200, await runCommand("diagnostics.repair"));
      }

      if (request.method === "POST" && url.pathname === "/experiences/build-daily") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("experiences.build_daily", { input: body }));
      }

      if (request.method === "POST" && url.pathname === "/maintenance") {
        const body = await readJson(request);
        const result = await runCommand("maintenance.run", { input: body });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/experiences/feedback") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("experiences.feedback", {
          input: {
            experienceId: String(body.experienceId || ""),
            rating: String(body.rating || ""),
            comment: String(body.comment || ""),
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/cancel-task") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("task.cancel", {
          input: {
            taskId: String(body.taskId || ""),
            reason: String(body.reason || "cancelled by user"),
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/cancel-run") {
        const body = await readJson(request);
        return sendJson(response, 200, await runCommand("run.cancel", {
          input: {
            runId: String(body.runId || ""),
            reason: String(body.reason || "cancelled by user"),
          },
        }));
      }

      if (request.method === "POST" && url.pathname === "/chat") {
        const body = await readJson(request);
        const result = await runtime.handleUserMessage(String(body.message || ""), {
          sessionId: String(body.sessionId || "web"),
          source: "web",
          permissionMode: assertPermissionModeWithinCommandPermission(body.permissionMode, auth.maxPermission),
        });
        return sendJson(response, 200, result);
      }

      sendJson(response, 404, {
        error: "Not found",
        routes: ["GET /", "GET /health", "GET /health/detail", "GET /doctor", "GET /gateway (websocket upgrade)", "GET /events", "GET /events-snapshot", "GET /providers", "GET /providers/health", "GET /providers/usage", "GET /settings", "POST /settings", "GET /providers/dashboard", "POST /providers", "GET /tools", "GET /subagents", "POST /tools/execute", "GET /skills", "GET /commands", "POST /commands/run", "GET /cron", "POST /cron", "POST /cron/update", "POST /cron/pause", "POST /cron/resume", "POST /cron/run", "DELETE /cron", "GET /skill-candidates", "POST /skill-candidates/build", "POST /skill-candidates/approve", "POST /skill-candidates/reject", "GET /roles", "POST /roles", "POST /roles/defaults", "GET /sessions", "GET /sessions/messages", "GET /sessions/resume-latest", "GET /sessions/export", "GET /sessions/compact-preview", "GET /sessions/usage", "POST /sessions/new", "POST /sessions/clear", "POST /sessions/restore", "POST /sessions/trash", "POST /roles/provider", "GET /experiences", "GET /timeline", "GET /dag", "GET /graph", "GET /graph-node", "POST /graph/add", "POST /graph/add-before", "POST /graph/add-after", "POST /graph/update", "POST /graph/delete", "GET /task-trace", "GET /diagnostics", "GET /security/audit", "GET /context", "GET /route", "POST /diagnostics/repair", "POST /maintenance", "POST /cancel-task", "POST /cancel-run", "POST /experiences/build-daily", "POST /experiences/feedback", "POST /chat"],
      });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : error instanceof CommandPermissionError ? 403 : 500;
      sendJson(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    const netSocket = socket as Socket;
    if (url.pathname !== "/gateway" && url.pathname !== "/ws") {
      rejectUpgrade(netSocket, 404, "Not Found");
      return;
    }
    const auth = authenticate(request, url, { authToken: resolvedAuthToken, readAuthToken, writeAuthToken }, {
      allowQueryToken: isLoopbackQueryTokenRequest(request, url),
    });
    if (!auth) {
      rejectUpgrade(netSocket, 401, "Unauthorized");
      return;
    }
    if (!isAllowedOrigin(request, url)) {
      rejectUpgrade(netSocket, 403, "Forbidden origin");
      return;
    }
    acceptGatewaySocket({ runtime, request, socket: netSocket, head, maxPermission: auth.maxPermission });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${resolvedPort}`;
  console.log(`Emily Agent web adapter listening on ${url}`);
  console.log(`Emily Agent web token: ${generatedAuthToken ? resolvedAuthToken : redactToken(resolvedAuthToken)}`);
  return {
    server,
    authToken: resolvedAuthToken,
    url,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, max);
}

function isUnsafeMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

interface AuthContext {
  maxPermission: CommandPermission;
}

function authenticate(
  request: IncomingMessage,
  url: URL,
  tokens: { authToken: string; readAuthToken?: string; writeAuthToken?: string },
  options: { allowQueryToken?: boolean } = {},
): AuthContext | null {
  const presented = authTokenFromRequest(request, url, options);
  if (!presented) return null;
  if (safeTokenEquals(presented, tokens.authToken)) return { maxPermission: "danger" };
  if (tokens.writeAuthToken && safeTokenEquals(presented, tokens.writeAuthToken)) return { maxPermission: "write" };
  if (tokens.readAuthToken && safeTokenEquals(presented, tokens.readAuthToken)) return { maxPermission: "read" };
  return null;
}

function authTokenFromRequest(request: IncomingMessage, url: URL, options: { allowQueryToken?: boolean } = {}): string {
  const headerToken = request.headers["x-emily-token"];
  if (typeof headerToken === "string") return headerToken;
  const authorization = request.headers.authorization || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return bearer[1];
  if (options.allowQueryToken === false) return "";
  return url.searchParams.get("token") || "";
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function redactToken(token: string): string {
  if (!token) return "(empty)";
  if (token.length <= 8) return "(redacted)";
  return `${token.slice(0, 4)}...${token.slice(-4)} (${token.length} chars)`;
}

function canUsePermission(actual: CommandPermission, required: CommandPermission): boolean {
  return permissionRank(actual) >= permissionRank(required);
}

function minCommandPermission(left: CommandPermission | undefined, right: CommandPermission): CommandPermission {
  if (!left) return right;
  return permissionRank(left) <= permissionRank(right) ? left : right;
}

function permissionRank(permission: CommandPermission): number {
  if (permission === "danger") return 2;
  if (permission === "write") return 1;
  return 0;
}

function isAllowedOrigin(request: IncomingMessage, url: URL): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === url.origin;
}

function isLoopbackQueryTokenRequest(request: IncomingMessage, url: URL): boolean {
  if (!url.searchParams.has("token")) return true;
  return isLoopbackHost(request.headers.host || url.host) && isLoopbackAddress(request.socket.remoteAddress || "");
}

function isLoopbackHost(hostHeader: string): boolean {
  try {
    return isLoopbackAddress(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return isLoopbackAddress(hostHeader.split(":")[0] || "");
  }
}

function isLoopbackAddress(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.+$/, "").replace(/\.+$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  if (isIP(normalized) === 6) return normalized === "::1" || normalized.startsWith("::ffff:127.");
  return false;
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
  maxPermission,
}: {
  runtime: {
    taskStore: { addEvent?: (input: { type: string; payload?: Metadata }) => number };
    roleAgentManager: NodeJS.EventEmitter;
  } & Parameters<typeof dispatchGatewayRequest>[0];
  request: IncomingMessage;
  socket: Socket;
  head: Buffer;
  maxPermission: CommandPermission;
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
  const limiter = new GatewayConnectionLimiter();
  let inFlight = 0;
  let idleTimer = setTimeout(() => socket.end(), GATEWAY_IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
  const refreshIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => socket.end(), GATEWAY_IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  };
  runtime.taskStore.addEvent?.({
    type: "gateway.connected",
    payload: { remoteAddress: socket.remoteAddress || "" },
  });

  const onRuntimeEvent = (event: unknown) => {
    connection.send(gatewayEvent("runtime.event", event));
  };
  runtime.roleAgentManager.on("event", onRuntimeEvent);
  socket.on("close", () => {
    clearTimeout(idleTimer);
    runtime.roleAgentManager.off("event", onRuntimeEvent);
  });
  connection.onMessage = (message) => {
    refreshIdleTimer();
    let requestId = "";
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(message);
      if (parsedInput && typeof parsedInput === "object" && typeof (parsedInput as { id?: unknown }).id === "string") {
        requestId = (parsedInput as { id: string }).id;
      }
      if (!limiter.consume()) {
        connection.send(gatewayErrorResponse(requestId, "gateway_rate_limited", `Gateway message rate limit exceeded: ${GATEWAY_MAX_MESSAGES_PER_WINDOW} messages per ${GATEWAY_RATE_WINDOW_MS}ms.`));
        return;
      }
      if (inFlight >= GATEWAY_MAX_IN_FLIGHT) {
        connection.send(gatewayErrorResponse(requestId, "gateway_busy", `Gateway connection already has ${GATEWAY_MAX_IN_FLIGHT} in-flight requests.`));
        return;
      }
      const parsed = parseGatewayRequest(parsedInput);
      requestId = parsed.id;
      runtime.taskStore.addEvent?.({
        type: "gateway.request",
        payload: { id: parsed.id, method: parsed.method },
      });
      inFlight += 1;
      void dispatchGatewayRequest(runtime, parsed, { maxPermission })
        .then((response) => {
          runtime.taskStore.addEvent?.({
            type: "gateway.response",
            payload: { id: response.id, ok: response.ok, method: parsed.method },
          });
          connection.send(response);
        })
        .catch((error) => {
          connection.send(gatewayErrorResponse(requestId, "gateway_handler_error", error instanceof Error ? error.message : String(error)));
        })
        .finally(() => {
          inFlight -= 1;
        });
    } catch (error) {
      connection.send(gatewayErrorResponse(requestId || "unknown", "invalid_gateway_message", error instanceof Error ? error.message : String(error)));
    }
  };
  if (head.length) connection.push(head);
  connection.send(gatewayEvent("gateway.ready", gatewayProtocolSpec()));
}

class GatewayConnectionLimiter {
  private windowStartedAt = Date.now();
  private messagesInWindow = 0;

  consume(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt >= GATEWAY_RATE_WINDOW_MS) {
      this.windowStartedAt = now;
      this.messagesInWindow = 0;
    }
    this.messagesInWindow += 1;
    return this.messagesInWindow <= GATEWAY_MAX_MESSAGES_PER_WINDOW;
  }
}

function gatewayErrorResponse(id: string, code: string, message: string) {
  return {
    type: "response",
    id: id || "unknown",
    ok: false,
    error: { code, message },
  };
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

function sendText(response: ServerResponse, statusCode: number, payload: string, contentType: string): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
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

function providerDashboardHtml(): string {
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
let AUTH_TOKEN = localStorage.getItem('emily.authToken') || '';
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
if (token) {
  AUTH_TOKEN = token;
  localStorage.setItem('emily.authToken', token);
  params.delete('token');
  const next = location.pathname + (params.toString() ? '?' + params.toString() : '');
  history.replaceState(null, '', next);
}
function authHeaders() {
  return AUTH_TOKEN ? { 'x-emily-token': AUTH_TOKEN } : {};
}
async function load() {
  const data = await fetch('/providers/usage', { headers: authHeaders() }).then((res) => res.json());
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
