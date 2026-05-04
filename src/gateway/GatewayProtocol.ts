import { parsePermissionMode } from "../tools/PermissionMode.ts";
import type { CommandPermission } from "../commands/CommandRegistry.ts";
import type { Metadata, ToolPermission } from "../types.ts";

export interface GatewayRequest {
  type: "request";
  id: string;
  method: GatewayMethod;
  params?: Record<string, unknown>;
}

export interface GatewayResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface GatewayEvent {
  type: "event";
  event: string;
  payload: unknown;
}

export type GatewayMethod =
  | "chat.send"
  | "sessions.list"
  | "sessions.create"
  | "sessions.clear"
  | "sessions.restore"
  | "sessions.trash"
  | "tasks.cancel"
  | "runs.cancel"
  | "providers.list"
  | "providers.add"
  | "providers.enable"
  | "providers.disable"
  | "providers.remove"
  | "providers.health"
  | "providers.usage"
  | "roles.list"
  | "roles.add"
  | "roles.update_provider"
  | "roles.defaults"
  | "tools.list"
  | "tools.execute"
  | "skills.list"
  | "skills.candidates.list"
  | "skills.candidates.build"
  | "skills.candidates.approve"
  | "skills.candidates.reject"
  | "experiences.recall"
  | "experiences.build_daily"
  | "experiences.feedback"
  | "timeline.get"
  | "diagnostics.run"
  | "diagnostics.repair"
  | "doctor.run"
  | "maintenance.run"
  | "security.audit"
  | "sessions.resume_latest"
  | "sessions.export"
  | "sessions.compact_preview"
  | "sessions.usage"
  | "commands.list"
  | "commands.run"
  | "cron.list"
  | "cron.create"
  | "cron.update"
  | "cron.pause"
  | "cron.resume"
  | "cron.delete"
  | "cron.run"
  | "context.build"
  | "router.route";

export const GATEWAY_METHODS: GatewayMethod[] = [
  "chat.send",
  "sessions.list",
  "sessions.create",
  "sessions.clear",
  "sessions.restore",
  "sessions.trash",
  "tasks.cancel",
  "runs.cancel",
  "providers.list",
  "providers.add",
  "providers.enable",
  "providers.disable",
  "providers.remove",
  "providers.health",
  "providers.usage",
  "roles.list",
  "roles.add",
  "roles.update_provider",
  "roles.defaults",
  "tools.list",
  "tools.execute",
  "skills.list",
  "skills.candidates.list",
  "skills.candidates.build",
  "skills.candidates.approve",
  "skills.candidates.reject",
  "experiences.recall",
  "experiences.build_daily",
  "experiences.feedback",
  "timeline.get",
  "diagnostics.run",
  "diagnostics.repair",
  "doctor.run",
  "maintenance.run",
  "security.audit",
  "sessions.resume_latest",
  "sessions.export",
  "sessions.compact_preview",
  "sessions.usage",
  "commands.list",
  "commands.run",
  "cron.list",
  "cron.create",
  "cron.update",
  "cron.pause",
  "cron.resume",
  "cron.delete",
  "cron.run",
  "context.build",
  "router.route",
];

export function parseGatewayRequest(value: unknown): GatewayRequest {
  if (!value || typeof value !== "object") throw new Error("Gateway message must be an object.");
  const input = value as Partial<GatewayRequest>;
  if (input.type !== "request") throw new Error("Gateway message type must be request.");
  if (typeof input.id !== "string" || !input.id.trim()) throw new Error("Gateway request id is required.");
  if (!isGatewayMethod(input.method)) throw new Error(`Unknown gateway method: ${String(input.method)}`);
  if (input.params !== undefined && (!input.params || typeof input.params !== "object" || Array.isArray(input.params))) {
    throw new Error("Gateway params must be an object when provided.");
  }
  return {
    type: "request",
    id: input.id,
    method: input.method,
    params: input.params || {},
  };
}

export async function dispatchGatewayRequest(
  runtime: GatewayRuntime,
  request: GatewayRequest,
  options: { maxPermission?: CommandPermission } = {},
): Promise<GatewayResponse> {
  try {
    const params = request.params || {};
    const maxPermission = options.maxPermission || "danger";
    assertGatewayMethodPermission(request.method, params, maxPermission);
    const result = await dispatch(scopeRuntime(runtime, maxPermission), request.method, params);
    return { type: "response", id: request.id, ok: true, result };
  } catch (error) {
    return {
      type: "response",
      id: request.id,
      ok: false,
      error: {
        code: "gateway_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function gatewayEvent(event: string, payload: unknown): GatewayEvent {
  return { type: "event", event, payload };
}

export function gatewayProtocolSpec() {
  return {
    version: 1,
    methods: GATEWAY_METHODS,
    requestShape: {
      type: "request",
      id: "client-generated id",
      method: "chat.send",
      params: {},
    },
    responseShape: {
      type: "response",
      id: "same id",
      ok: true,
      result: {},
    },
    eventShape: {
      type: "event",
      event: "task.changed",
      payload: {},
    },
  };
}

function isGatewayMethod(value: unknown): value is GatewayMethod {
  return typeof value === "string" && (GATEWAY_METHODS as string[]).includes(value);
}

function scopeRuntime(runtime: GatewayRuntime, maxPermission: CommandPermission): GatewayRuntime {
  return {
    ...runtime,
    runCommand: (name, options = {}) => runtime.runCommand(name, {
      ...options,
      maxPermission: minCommandPermission(options.maxPermission, maxPermission),
    }),
  };
}

function assertGatewayMethodPermission(
  method: GatewayMethod,
  params: Record<string, unknown>,
  maxPermission: CommandPermission,
): void {
  const required = gatewayMethodPermission(method, params);
  if (permissionRank(required) <= permissionRank(maxPermission)) return;
  throw new Error(`Gateway method ${method} requires ${required} permission; caller is limited to ${maxPermission}.`);
}

function gatewayMethodPermission(method: GatewayMethod, params: Record<string, unknown>): CommandPermission {
  if (method === "doctor.run" && params.repair === true) return "write";
  if (method === "diagnostics.run" && params.repair === true) return "write";
  if (method === "commands.run") return "read";
  if (READ_GATEWAY_METHODS.has(method)) return "read";
  return "write";
}

const READ_GATEWAY_METHODS = new Set<GatewayMethod>([
  "sessions.list",
  "providers.list",
  "providers.health",
  "providers.usage",
  "roles.list",
  "tools.list",
  "skills.list",
  "skills.candidates.list",
  "experiences.recall",
  "timeline.get",
  "diagnostics.run",
  "doctor.run",
  "security.audit",
  "sessions.resume_latest",
  "sessions.export",
  "sessions.compact_preview",
  "sessions.usage",
  "commands.list",
  "commands.run",
  "cron.list",
  "context.build",
  "router.route",
]);

function minCommandPermission(left: CommandPermission | undefined, right: CommandPermission): CommandPermission {
  if (!left) return right;
  return permissionRank(left) <= permissionRank(right) ? left : right;
}

function permissionRank(permission: CommandPermission): number {
  if (permission === "danger") return 2;
  if (permission === "write") return 1;
  return 0;
}

async function dispatch(runtime: GatewayRuntime, method: GatewayMethod, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "chat.send":
      return runtime.handleUserMessage(String(params.message || ""), {
        sessionId: typeof params.sessionId === "string" ? params.sessionId : "gateway",
        source: typeof params.source === "string" ? params.source : "gateway",
        permissionMode: parsePermissionMode(params.permissionMode),
      });
    case "sessions.list":
      return runtime.runCommand("session.list", {
        input: {
          status: typeof params.status === "string" ? params.status : undefined,
          includeHidden: params.includeHidden === true,
          includeTrashed: params.includeTrashed === true,
          includeDeleted: params.includeDeleted === true,
          limit: parseLimit(params.limit, 50, 500),
        },
      });
    case "sessions.create":
      return runtime.runCommand("session.create", {
        input: {
          title: typeof params.title === "string" ? params.title : "New session",
          source: typeof params.source === "string" ? params.source : "gateway",
          metadata: { createdBy: "gateway" },
        },
      });
    case "sessions.clear":
      return runtime.runCommand("session.clear", {
        input: {
          sessionId: String(params.sessionId || ""),
          source: "gateway",
          reason: typeof params.reason === "string" ? params.reason : "cleared from gateway",
          nextTitle: typeof params.nextTitle === "string" ? params.nextTitle : "New session",
        },
      });
    case "sessions.restore":
      return runtime.runCommand("session.restore", {
        input: { sessionId: String(params.sessionId || params.id || "") },
      });
    case "sessions.trash":
      return runtime.runCommand("session.trash", {
        input: {
          sessionId: String(params.sessionId || params.id || ""),
          deleteAfterDays: parseLimit(params.deleteAfterDays, 30, 365),
          reason: typeof params.reason === "string" ? params.reason : "trashed from gateway",
        },
      });
    case "tasks.cancel":
      return runtime.runCommand("task.cancel", {
        input: {
          taskId: String(params.taskId || ""),
          reason: typeof params.reason === "string" ? params.reason : "cancelled from gateway",
        },
      });
    case "runs.cancel":
      return runtime.runCommand("run.cancel", {
        input: {
          runId: String(params.runId || ""),
          reason: typeof params.reason === "string" ? params.reason : "cancelled from gateway",
        },
      });
    case "providers.list":
      return runtime.runCommand("providers");
    case "providers.add":
      return runtime.runCommand("provider.add", { input: params });
    case "providers.enable":
      return runtime.runCommand("provider.enable", {
        input: { providerId: String(params.providerId || params.id || "") },
      });
    case "providers.disable":
      return runtime.runCommand("provider.disable", {
        input: { providerId: String(params.providerId || params.id || "") },
      });
    case "providers.remove":
      return runtime.runCommand("provider.remove", {
        input: { providerId: String(params.providerId || params.id || "") },
      });
    case "providers.health":
      return runtime.runCommand("provider.health", { input: { deep: params.deep === true } });
    case "providers.usage":
      return runtime.runCommand("provider.usage", {
        input: {
          providerId: typeof params.providerId === "string" ? params.providerId : undefined,
          limit: parseLimit(params.limit, 20, 500),
        },
      });
    case "roles.list":
      return runtime.runCommand("roles");
    case "roles.add":
      return runtime.runCommand("role.add", { input: params });
    case "roles.update_provider":
      return runtime.runCommand("role.update_provider", {
        input: {
          name: String(params.name || ""),
          provider: typeof params.provider === "string" ? params.provider : undefined,
          model: typeof params.model === "string" ? params.model : undefined,
          temperature: typeof params.temperature === "number" ? params.temperature : undefined,
        },
      });
    case "roles.defaults":
      return runtime.runCommand("role.initialize_defaults", {
        input: { overwrite: params.overwrite === true },
      });
    case "tools.list":
      return runtime.runCommand("tools");
    case "tools.execute":
      return runtime.runCommand("tool.execute", { input: params });
    case "skills.list":
      return runtime.runCommand("skills");
    case "skills.candidates.list":
      return runtime.runCommand("skills.candidates.list", {
        input: {
          status: typeof params.status === "string" ? params.status : undefined,
          limit: parseLimit(params.limit, 50, 500),
        },
      });
    case "skills.candidates.build":
      return runtime.runCommand("skills.candidates.build", { input: params });
    case "skills.candidates.approve":
      return runtime.runCommand("skills.candidates.approve", {
        input: {
          candidateId: String(params.candidateId || params.id || ""),
          reason: typeof params.reason === "string" ? params.reason : undefined,
        },
      });
    case "skills.candidates.reject":
      return runtime.runCommand("skills.candidates.reject", {
        input: {
          candidateId: String(params.candidateId || params.id || ""),
          reason: typeof params.reason === "string" ? params.reason : "rejected from gateway",
        },
      });
    case "experiences.recall":
      return runtime.runCommand("experiences.recall", {
        input: {
          q: typeof params.q === "string" ? params.q : undefined,
          query: typeof params.query === "string" ? params.query : undefined,
          limit: parseLimit(params.limit, 5, 100),
        },
      });
    case "experiences.build_daily":
      return runtime.runCommand("experiences.build_daily", { input: params });
    case "experiences.feedback":
      return runtime.runCommand("experiences.feedback", {
        input: {
          experienceId: String(params.experienceId || params.id || ""),
          rating: String(params.rating || ""),
          comment: typeof params.comment === "string" ? params.comment : undefined,
        },
      });
    case "timeline.get":
      return runtime.runCommand("timeline.get", {
        input: { runId: String(params.runId || "") },
        format: params.format === "text" ? "text" : "json",
      });
    case "diagnostics.run":
      return params.repair === true ? runtime.runCommand("diagnostics.repair") : runtime.runCommand("diagnostics.run");
    case "diagnostics.repair":
      return runtime.runCommand("diagnostics.repair");
    case "doctor.run":
      return runtime.runCommand("doctor", { input: { deep: params.deep === true, repair: params.repair === true } });
    case "maintenance.run":
      return runtime.runCommand("maintenance.run", { input: params });
    case "security.audit":
      return runtime.runCommand("security.audit");
    case "sessions.resume_latest":
      return runtime.runCommand("session.resume_latest", { input: { includeHidden: params.includeHidden === true } });
    case "sessions.export":
      return runtime.runCommand("session.export", {
        input: {
          sessionId: String(params.sessionId || ""),
          format: params.format === "markdown" ? "markdown" : "json",
        },
        format: params.format === "markdown" ? "text" : "json",
      });
    case "sessions.compact_preview":
      return runtime.runCommand("session.compact_preview", {
        input: {
          sessionId: String(params.sessionId || ""),
          maxMessages: parseLimit(params.maxMessages, 20, 200),
        },
      });
    case "sessions.usage":
      return runtime.runCommand("session.usage", { input: { sessionId: String(params.sessionId || "") } });
    case "commands.list":
      return runtime.listCommands();
    case "commands.run":
      return runtime.runCommand(String(params.name || params.command || ""), {
        args: Array.isArray(params.args) ? params.args.map(String) : [],
        input: params.input && typeof params.input === "object" && !Array.isArray(params.input) ? params.input as Record<string, unknown> : params,
        format: params.format === "text" ? "text" : "json",
        maxPermission: "read",
      });
    case "cron.list":
      return runtime.runCommand("cron.list", {
        input: { includePaused: params.includePaused !== false },
      });
    case "cron.create":
      return runtime.runCommand("cron.create", { input: params });
    case "cron.update":
      return runtime.runCommand("cron.update", { input: params });
    case "cron.pause":
      return runtime.runCommand("cron.pause", { input: { id: String(params.id || "") } });
    case "cron.resume":
      return runtime.runCommand("cron.resume", { input: { id: String(params.id || "") } });
    case "cron.delete":
      return runtime.runCommand("cron.delete", { input: { id: String(params.id || "") } });
    case "cron.run":
      return runtime.runCommand("cron.run", { input: { id: String(params.id || "") } });
    case "context.build":
      return runtime.runCommand("context.build", {
        input: {
          query: String(params.query || params.message || ""),
          sessionId: typeof params.sessionId === "string" ? params.sessionId : "gateway",
          runId: typeof params.runId === "string" ? params.runId : undefined,
          role: typeof params.role === "string" ? params.role : "gateway",
          mode: params.mode === "deep" ? "deep" : "active",
        },
      });
    case "router.route":
      return runtime.runCommand("router.route", {
        input: { input: String(params.input || params.message || "") },
      });
  }
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(number, max);
}

export interface GatewayRuntime {
  handleUserMessage: (message: string, context: { sessionId?: string; source?: string; permissionMode?: unknown }) => Promise<unknown>;
  listSessions: (options?: { status?: "active" | "hidden" | "trashed" | "deleted"; includeHidden?: boolean; includeTrashed?: boolean; includeDeleted?: boolean; limit?: number }) => unknown[];
  createSession: (options?: { title?: string; source?: string; metadata?: Metadata }) => unknown;
  clearSession: (sessionId: string, options?: { source?: string; reason?: string; nextTitle?: string }) => unknown;
  restoreSession: (sessionId: string) => unknown;
  cancelTask: (taskId: string, reason?: string) => Promise<unknown>;
  cancelRun: (runId: string, reason?: string) => Promise<unknown>;
  listProviders: () => unknown[];
  checkProviders: (options?: { deep?: boolean }) => Promise<unknown[]>;
  providerUsage: (options?: { providerId?: string; limit?: number }) => unknown;
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
  listTools: () => unknown[];
  listSkills: () => unknown[];
  listSkillCandidates: (options?: { status?: "proposed" | "approved" | "merged" | "rejected"; limit?: number }) => unknown[];
  experienceStore: {
    listActive: () => unknown[];
    recall: (query: string, options?: { scope?: "project"; limit?: number }) => unknown[];
  };
  getTimeline: (options: { runId: string }) => unknown;
  diagnostics: (options?: { repair?: boolean }) => unknown;
  doctor: (options?: { deep?: boolean; repair?: boolean }) => Promise<unknown>;
  maintenance: (options?: Record<string, unknown>) => Promise<unknown>;
  securityAudit: () => Promise<unknown>;
  resumeLatestSession: (options?: { includeHidden?: boolean }) => unknown;
  exportSession: (sessionId: string, options?: { format?: "json" | "markdown" }) => unknown;
  previewSessionCompaction: (sessionId: string, options?: { maxMessages?: number }) => unknown;
  sessionUsage: (sessionId: string) => unknown;
  listCommands: () => unknown[];
  runCommand: (name: string, options?: { args?: string[]; input?: Record<string, unknown>; format?: "json" | "text"; maxPermission?: CommandPermission }) => Promise<unknown>;
  buildContext: (options: { query: string; sessionId?: string; runId?: string | null; role?: string; mode?: "active" | "deep" }) => Promise<unknown>;
  routeMessage: (input: string) => unknown;
}
