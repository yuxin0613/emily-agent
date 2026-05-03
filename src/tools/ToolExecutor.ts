import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Metadata, PermissionMode, RoleDefinition, Task, ToolPermission } from "../types.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import { parsePermissionMode } from "./PermissionMode.ts";
import { ToolGateway } from "./ToolGateway.ts";
import { createDefaultToolRegistry, type ToolRegistry } from "./ToolRegistry.ts";
import type { ToolDefinition } from "../types.ts";

const execFileAsync = promisify(execFile);

export interface ToolExecutionRequest {
  tool: string;
  args?: Record<string, unknown>;
  approval?: ToolApproval;
  roleDefinition: RoleDefinition;
  permissionMode?: PermissionMode | unknown;
  task?: Task | null;
  runId?: string | null;
  sessionId?: string | null;
}

export interface ToolApproval {
  approved?: boolean;
  reason?: string;
  approvedBy?: string;
}

export interface ToolExecutionResult {
  tool: ToolPermission;
  ok: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sideEffects: string;
  output?: unknown;
  error?: string;
}

export class ToolExecutor {
  workspaceDir: string;
  taskStore: TaskStore | null;
  registry: ToolRegistry;

  constructor({
    workspaceDir = process.cwd(),
    taskStore = null,
    registry = createDefaultToolRegistry(),
  }: {
    workspaceDir?: string;
    taskStore?: TaskStore | null;
    registry?: ToolRegistry;
  } = {}) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.taskStore = taskStore;
    this.registry = registry;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const permissionMode = parsePermissionMode(request.permissionMode);
    const gateway = new ToolGateway(request.roleDefinition, {
      registry: this.registry,
      permissionMode,
    });
    const startedAt = new Date();
    const requestedDefinition = this.registry.resolve(request.tool);
    let definition: ToolDefinition | null = null;
    let startedEventId: number | null = null;
    try {
      definition = gateway.assertAllowed(request.tool);
      startedEventId = this.addEvent("tool.execution.started", request, {
        tool: definition.name,
        permissionMode,
        requiresApproval: definition.requiresApproval,
        args: summarizeArgs(request.args || {}),
      });
      this.assertApproved(definition, request);
      const output = await this.executeAllowed(definition.name, request.args || {}, request);
      const result: ToolExecutionResult = {
        tool: definition.name,
        ok: true,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        sideEffects: definition.sideEffects,
        output,
      };
      this.addEvent("tool.execution.completed", request, {
        tool: definition.name,
        ok: true,
        durationMs: result.durationMs,
        startedEventId,
        output: summarizeOutput(output),
      });
      return result;
    } catch (error) {
      const failedDefinition = definition || requestedDefinition;
      if (error instanceof ToolApprovalRequiredError) {
        this.addEvent("tool.execution.approval_required", request, {
          tool: failedDefinition?.name || String(request.tool),
          startedEventId,
          reason: error.message,
          sideEffects: failedDefinition?.sideEffects || "none",
        });
      }
      const result: ToolExecutionResult = {
        tool: (failedDefinition?.name || String(request.tool)) as ToolPermission,
        ok: false,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        sideEffects: failedDefinition?.sideEffects || "none",
        error: error instanceof Error ? error.message : String(error),
      };
      this.addEvent("tool.execution.failed", request, {
        tool: failedDefinition?.name || String(request.tool),
        ok: false,
        durationMs: result.durationMs,
        startedEventId,
        error: result.error,
      });
      return result;
    }
  }

  private async executeAllowed(tool: ToolPermission, args: Record<string, unknown>, request: ToolExecutionRequest): Promise<unknown> {
    if (tool === "read_file") return this.readFile(args);
    if (tool === "write_file") return this.writeFile(args);
    if (tool === "run_tests") return this.runTests(args);
    if (tool === "inspect_task") return this.inspectTask(args);
    if (tool === "create_task") return this.createTask(args, request);
    if (tool === "delete_file") return this.deleteFile(args);
    if (tool === "http_fetch") return this.httpFetch(args);
    if (tool === "browser") return this.browserSnapshot(args);
    if (tool === "github") return this.github(args);
    if (tool === "git_reset") throw new Error("git_reset is declared but not executable without an external approval executor.");
    if (tool === "shell") throw new Error("shell is declared but not executable through the built-in executor.");
    if (tool === "network") throw new Error("network is declared as a broad permission; use http_fetch, browser, or github instead.");
    throw new Error(`No executor registered for tool ${tool}.`);
  }

  private assertApproved(definition: ToolDefinition, request: ToolExecutionRequest): void {
    const needsApproval = definition.requiresApproval || definition.sideEffects === "destructive";
    if (!needsApproval) return;
    if (request.approval?.approved === true) return;
    throw new ToolApprovalRequiredError(`Tool ${definition.name} requires explicit approval before execution.`);
  }

  private async readFile(args: Record<string, unknown>): Promise<{ path: string; content: string; bytes: number; truncated: boolean }> {
    const filePath = this.resolveWorkspacePath(requiredString(args.path, "path"));
    const maxBytes = positiveNumber(args.maxBytes, 128000);
    const content = await readFile(filePath, "utf8");
    const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
    const output = truncated ? content.slice(0, maxBytes) : content;
    return {
      path: path.relative(this.workspaceDir, filePath),
      content: output,
      bytes: Buffer.byteLength(content, "utf8"),
      truncated,
    };
  }

  private async writeFile(args: Record<string, unknown>): Promise<{ path: string; bytes: number }> {
    const filePath = this.resolveWorkspacePath(requiredString(args.path, "path"));
    const content = String(args.content ?? "");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return {
      path: path.relative(this.workspaceDir, filePath),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  private async deleteFile(args: Record<string, unknown>): Promise<{ path: string; deleted: boolean }> {
    const filePath = this.resolveWorkspacePath(requiredString(args.path, "path"));
    await rm(filePath, { force: false, recursive: false });
    return {
      path: path.relative(this.workspaceDir, filePath),
      deleted: true,
    };
  }

  private async runTests(args: Record<string, unknown>): Promise<{ command: string[]; stdout: string; stderr: string }> {
    const command = parseSafeTestCommand(args.command);
    const { stdout, stderr } = await execFileAsync(command[0], command.slice(1), {
      cwd: this.workspaceDir,
      timeout: positiveNumber(args.timeoutMs, 120000),
      maxBuffer: positiveNumber(args.maxBuffer, 1024 * 1024),
    });
    return { command, stdout, stderr };
  }

  private async httpFetch(args: Record<string, unknown>): Promise<{
    url: string;
    method: string;
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    body: string;
    bytes: number;
    truncated: boolean;
  }> {
    const url = parseHttpUrl(requiredString(args.url, "url"));
    const method = parseHttpMethod(args.method);
    const maxBytes = positiveNumber(args.maxBytes, 256000);
    const timeoutMs = positiveNumber(args.timeoutMs, 15000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: parseHeaders(args.headers),
        body: method === "GET" || method === "HEAD" ? undefined : String(args.body ?? ""),
        signal: controller.signal,
      });
      const body = method === "HEAD" ? { text: "", bytes: 0, truncated: false } : await readResponseText(response, maxBytes);
      return {
        url: url.toString(),
        method,
        status: response.status,
        ok: response.ok,
        headers: selectedHeaders(response.headers),
        body: body.text,
        bytes: body.bytes,
        truncated: body.truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async browserSnapshot(args: Record<string, unknown>): Promise<{
    url: string;
    title: string;
    status: number;
    html: string;
    textPreview: string;
    truncated: boolean;
  }> {
    const fetched = await this.httpFetch({
      ...args,
      method: args.method || "GET",
      maxBytes: args.maxBytes || 384000,
    });
    const html = String(fetched.body || "");
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    const textPreview = html.replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
    return {
      url: fetched.url,
      title,
      status: fetched.status,
      html,
      textPreview,
      truncated: fetched.truncated,
    };
  }

  private async github(args: Record<string, unknown>): Promise<{ command: string[]; stdout: string; stderr: string }> {
    const command = parseGithubCommand(args.command);
    const { stdout, stderr } = await execFileAsync("gh", command, {
      cwd: this.workspaceDir,
      timeout: positiveNumber(args.timeoutMs, 30000),
      maxBuffer: positiveNumber(args.maxBuffer, 1024 * 1024),
    });
    return { command: ["gh", ...command], stdout, stderr };
  }

  private inspectTask(args: Record<string, unknown>): unknown {
    if (!this.taskStore) throw new Error("inspect_task requires a TaskStore.");
    const taskId = requiredString(args.taskId, "taskId");
    return this.taskStore.getTaskTrace(taskId);
  }

  private createTask(args: Record<string, unknown>, request: ToolExecutionRequest): unknown {
    if (!this.taskStore) throw new Error("create_task requires a TaskStore.");
    const task = this.taskStore.createTask({
      role: requiredString(args.role, "role"),
      title: requiredString(args.title, "title"),
      input: requiredString(args.input, "input"),
      parentTaskId: typeof args.parentTaskId === "string" ? args.parentTaskId : request.task?.id || null,
      maxRetries: typeof args.maxRetries === "number" ? args.maxRetries : undefined,
      metadata: {
        ...(isObject(args.metadata) ? args.metadata as Metadata : {}),
        sessionId: request.sessionId || request.task?.metadata.sessionId || "",
        runId: request.runId || request.task?.metadata.runId || "",
        createdByTool: request.tool,
      },
    });
    return task;
  }

  private resolveWorkspacePath(input: string): string {
    const resolved = path.resolve(this.workspaceDir, input);
    if (resolved !== this.workspaceDir && !resolved.startsWith(`${this.workspaceDir}${path.sep}`)) {
      throw new Error(`Path escapes workspace: ${input}`);
    }
    return resolved;
  }

  private addEvent(type: string, request: ToolExecutionRequest, payload: Record<string, unknown>): number | null {
    return this.taskStore?.addEvent({
      type,
      taskId: request.task?.id || null,
      payload: {
        ...payload,
        runId: request.runId || request.task?.metadata.runId || "",
        sessionId: request.sessionId || request.task?.metadata.sessionId || "",
      },
    }) ?? null;
  }
}

function parseSafeTestCommand(input: unknown): string[] {
  const command = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.trim().split(/\s+/) : ["npm", "run", "check"];
  if (command[0] === "npm" && command[1] === "test" && command.length === 2) return command;
  if (command[0] === "npm" && command[1] === "run" && (command[2] === "check" || command[2] === "test") && command.length === 3) return command;
  if (command[0] === "node" && /^test\/[A-Za-z0-9._/-]+\.test\.ts$/.test(command[1] || "") && command.length === 2) return command;
  throw new Error(`run_tests only allows npm test, npm run check/test, or node test/*.test.ts. Received: ${command.join(" ")}`);
}

function parseHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`http_fetch only supports http and https URLs. Received: ${url.protocol}`);
  }
  return url;
}

function parseHttpMethod(input: unknown): string {
  const method = String(input || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(method)) {
    throw new Error(`http_fetch allows GET, HEAD, or POST. Received: ${method}`);
  }
  return method;
}

function parseHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error(`Invalid header name: ${key}`);
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization") {
      throw new Error(`Sensitive header ${key} is not allowed in tool args.`);
    }
    result[key] = String(value);
  }
  return result;
}

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes <= maxBytes) {
      chunks.push(value);
      continue;
    }
    const remaining = Math.max(0, maxBytes - (bytes - value.byteLength));
    if (remaining > 0) chunks.push(value.slice(0, remaining));
    truncated = true;
    await reader.cancel().catch(() => undefined);
    break;
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated,
  };
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["content-type", "content-length", "last-modified", "etag"]) {
    const value = headers.get(key);
    if (value) result[key] = value;
  }
  return result;
}

function parseGithubCommand(input: unknown): string[] {
  const command = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.trim().split(/\s+/) : [];
  if (!command.length) throw new Error("github tool requires args.command.");
  const allowed = new Set(["api", "issue", "pr", "repo", "search", "workflow", "run"]);
  if (!allowed.has(command[0])) throw new Error(`github tool does not allow gh ${command[0]}.`);
  if (command.some((part) => /[;&|`$<>]/.test(part))) {
    throw new Error("github command arguments must not contain shell metacharacters.");
  }
  return command;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const normalized = key.toLowerCase();
    result[key] = normalized.includes("content") || normalized.includes("body")
      ? `[${String(value).length} chars]`
      : value;
  }
  return result;
}

function summarizeOutput(output: unknown): unknown {
  if (typeof output !== "object" || !output) return output;
  if ("content" in output && typeof output.content === "string") {
    return { ...output, content: `[${output.content.length} chars]` };
  }
  if ("stdout" in output && typeof output.stdout === "string") {
    return {
      ...output,
      stdout: `[${output.stdout.length} chars]`,
      stderr: typeof output.stderr === "string" ? `[${output.stderr.length} chars]` : output.stderr,
    };
  }
  return output;
}

class ToolApprovalRequiredError extends Error {}
