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
  template?: ToolApprovalTemplate;
  reason?: string;
  approvedBy?: string;
  expiresAt?: string;
  scope?: string;
}

export type ToolApprovalTemplate =
  | "network_read"
  | "network_write"
  | "browser_interaction"
  | "github_read"
  | "github_write"
  | "destructive_workspace";

interface ToolApprovalRequirement {
  required: boolean;
  template?: ToolApprovalTemplate;
  reason?: string;
}

interface BrowserSnapshot {
  url: string;
  title: string;
  status: number;
  html: string;
  textPreview: string;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; url: string; href: string }>;
  forms: Array<{ method: string; action: string; inputs: Array<{ name: string; type: string }> }>;
  truncated: boolean;
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
      const approvalRequirement = approvalRequirementFor(definition, request.args || {});
      startedEventId = this.addEvent("tool.execution.started", request, {
        tool: definition.name,
        permissionMode,
        requiresApproval: definition.requiresApproval,
        approvalTemplate: approvalRequirement.template || "",
        args: summarizeArgs(request.args || {}),
      });
      this.assertApproved(approvalRequirement, request);
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
          approvalTemplate: error.template,
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
    if (tool === "browser") return this.browser(args);
    if (tool === "github") return this.github(args);
    if (tool === "git_reset") throw new Error("git_reset is declared but not executable without an external approval executor.");
    if (tool === "shell") throw new Error("shell is declared but not executable through the built-in executor.");
    if (tool === "network") throw new Error("network is declared as a broad permission; use http_fetch, browser, or github instead.");
    throw new Error(`No executor registered for tool ${tool}.`);
  }

  private assertApproved(requirement: ToolApprovalRequirement, request: ToolExecutionRequest): void {
    if (!requirement.required) return;
    const approval = request.approval;
    if (approval?.approved === true && approval.template === requirement.template && !isExpiredApproval(approval)) return;
    const suffix = requirement.template ? ` using approval template ${requirement.template}` : "";
    throw new ToolApprovalRequiredError(`${requirement.reason || `Tool ${request.tool} requires explicit approval before execution`}${suffix}.`, requirement.template);
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

  private async browser(args: Record<string, unknown>): Promise<unknown> {
    const action = parseBrowserAction(args.action);
    if (action === "sequence") return this.browserSequence(args);
    const snapshot = await this.browserSnapshot(requiredString(args.url, "url"), args);
    if (action === "snapshot") return snapshot;
    if (action === "links") return { url: snapshot.url, status: snapshot.status, links: snapshot.links };
    if (action === "forms") return { url: snapshot.url, status: snapshot.status, forms: snapshot.forms };
    if (action === "text") return { url: snapshot.url, status: snapshot.status, title: snapshot.title, headings: snapshot.headings, text: snapshot.textPreview };
    if (action === "assert_text") {
      const text = requiredString(args.text, "text");
      return {
        url: snapshot.url,
        status: snapshot.status,
        text,
        found: snapshot.textPreview.toLowerCase().includes(text.toLowerCase()),
      };
    }
    if (action === "follow_link") {
      const link = findBrowserLink(snapshot.links, args);
      const followed = await this.browserSnapshot(link.url, args);
      return {
        action,
        from: snapshot.url,
        followed: link,
        snapshot: followed,
      };
    }
    return snapshot;
  }

  private async browserSequence(args: Record<string, unknown>): Promise<{ steps: unknown[]; finalUrl: string }> {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length) throw new Error("browser sequence requires steps.");
    if (steps.length > 10) throw new Error("browser sequence allows at most 10 steps.");
    let currentUrl = typeof args.url === "string" && args.url.trim() ? args.url : "";
    let currentSnapshot: BrowserSnapshot | null = null;
    const results: unknown[] = [];
    for (const rawStep of steps) {
      if (!isObject(rawStep)) throw new Error("browser sequence steps must be objects.");
      const action = parseBrowserAction(rawStep.action);
      if (action === "sequence") throw new Error("nested browser sequences are not allowed.");
      if (action === "snapshot" || action === "links" || action === "forms" || action === "text" || action === "assert_text" || action === "follow_link") {
        if (!currentUrl && typeof rawStep.url === "string") currentUrl = rawStep.url;
        if (!currentUrl) throw new Error("browser sequence needs a url before reading.");
        currentSnapshot ||= await this.browserSnapshot(currentUrl, args);
      }
      if (action === "snapshot") {
        currentSnapshot = await this.browserSnapshot(currentUrl, { ...args, ...rawStep });
        results.push({ action, snapshot: currentSnapshot });
      } else if (action === "links") {
        results.push({ action, url: currentSnapshot?.url, links: currentSnapshot?.links || [] });
      } else if (action === "forms") {
        results.push({ action, url: currentSnapshot?.url, forms: currentSnapshot?.forms || [] });
      } else if (action === "text") {
        results.push({ action, url: currentSnapshot?.url, text: currentSnapshot?.textPreview || "" });
      } else if (action === "assert_text") {
        const text = requiredString(rawStep.text, "steps[].text");
        results.push({
          action,
          text,
          found: Boolean(currentSnapshot?.textPreview.toLowerCase().includes(text.toLowerCase())),
        });
      } else if (action === "follow_link") {
        const link = findBrowserLink(currentSnapshot?.links || [], rawStep);
        currentUrl = link.url;
        currentSnapshot = await this.browserSnapshot(currentUrl, { ...args, ...rawStep });
        results.push({ action, followed: link, snapshot: currentSnapshot });
      } else {
        currentUrl = requiredString(rawStep.url || args.url, "steps[].url");
        currentSnapshot = await this.browserSnapshot(currentUrl, { ...args, ...rawStep });
        results.push({ action: "goto", snapshot: currentSnapshot });
      }
    }
    return { steps: results, finalUrl: currentSnapshot?.url || currentUrl };
  }

  private async browserSnapshot(url: string, args: Record<string, unknown>): Promise<BrowserSnapshot> {
    const fetched = await this.httpFetch({
      ...args,
      url,
      method: "GET",
      maxBytes: args.maxBytes || 384000,
    });
    return parseBrowserSnapshot(fetched.url, fetched.status, String(fetched.body || ""), fetched.truncated);
  }

  private async github(args: Record<string, unknown>): Promise<{ action: string; command: string[]; stdout: string; stderr: string; parsed?: unknown }> {
    const built = buildGithubCommand(args);
    const command = built.command;
    const { stdout, stderr } = await execFileAsync("gh", command, {
      cwd: this.workspaceDir,
      timeout: positiveNumber(args.timeoutMs, 30000),
      maxBuffer: positiveNumber(args.maxBuffer, 1024 * 1024),
    });
    return {
      action: built.action,
      command: ["gh", ...command],
      stdout,
      stderr,
      parsed: built.expectJson ? parseJsonOutput(stdout) : undefined,
    };
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

function approvalRequirementFor(definition: ToolDefinition, args: Record<string, unknown>): ToolApprovalRequirement {
  if (definition.name === "http_fetch") {
    const method = parseHttpMethod(args.method);
    return {
      required: true,
      template: method === "GET" || method === "HEAD" ? "network_read" : "network_write",
      reason: `Tool ${definition.name} requires explicit network approval`,
    };
  }
  if (definition.name === "browser") {
    return {
      required: true,
      template: "browser_interaction",
      reason: "Browser interaction requires explicit approval",
    };
  }
  if (definition.name === "github") {
    const template = githubActionCategory(args) === "write" ? "github_write" : "github_read";
    return {
      required: true,
      template,
      reason: "GitHub tool execution requires explicit approval",
    };
  }
  if (definition.name === "delete_file" || definition.sideEffects === "destructive") {
    return {
      required: true,
      template: "destructive_workspace",
      reason: `Tool ${definition.name} requires destructive workspace approval`,
    };
  }
  if (definition.requiresApproval) {
    return {
      required: true,
      template: "destructive_workspace",
      reason: `Tool ${definition.name} requires explicit approval before execution`,
    };
  }
  return { required: false };
}

function isExpiredApproval(approval: ToolApproval): boolean {
  if (!approval.expiresAt) return false;
  const expiresAt = new Date(approval.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function parseBrowserAction(value: unknown): "goto" | "snapshot" | "links" | "forms" | "text" | "assert_text" | "follow_link" | "sequence" {
  const action = String(value || "snapshot").toLowerCase();
  if (action === "goto" || action === "snapshot" || action === "links" || action === "forms" || action === "text" || action === "assert_text" || action === "follow_link" || action === "sequence") {
    return action;
  }
  throw new Error(`Unsupported browser action: ${action}`);
}

function parseBrowserSnapshot(url: string, status: number, html: string, truncated: boolean): BrowserSnapshot {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const textPreview = decodeHtml(stripHtml(html)).replace(/\s+/g, " ").trim().slice(0, 6000);
  return {
    url,
    title,
    status,
    html,
    textPreview,
    headings: extractHeadings(html),
    links: extractLinks(html, url),
    forms: extractForms(html, url),
    truncated,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function extractHeadings(html: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  const pattern = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of html.matchAll(pattern)) {
    headings.push({
      level: Number(match[1]),
      text: decodeHtml(stripHtml(match[2] || "")).replace(/\s+/g, " ").trim(),
    });
    if (headings.length >= 30) break;
  }
  return headings.filter((heading) => heading.text);
}

function extractLinks(html: string, baseUrl: string): Array<{ text: string; url: string; href: string }> {
  const links: Array<{ text: string; url: string; href: string }> = [];
  const pattern = /<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = String(match[1] || "").trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    links.push({
      href,
      url: new URL(href, baseUrl).toString(),
      text: decodeHtml(stripHtml(match[2] || "")).replace(/\s+/g, " ").trim(),
    });
    if (links.length >= 100) break;
  }
  return links;
}

function extractForms(html: string, baseUrl: string): Array<{ method: string; action: string; inputs: Array<{ name: string; type: string }> }> {
  const forms: Array<{ method: string; action: string; inputs: Array<{ name: string; type: string }> }> = [];
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  for (const form of html.matchAll(formPattern)) {
    const attrs = form[1] || "";
    const body = form[2] || "";
    const method = attributeValue(attrs, "method")?.toUpperCase() || "GET";
    const action = new URL(attributeValue(attrs, "action") || baseUrl, baseUrl).toString();
    const inputs: Array<{ name: string; type: string }> = [];
    for (const input of body.matchAll(/<(?:input|textarea|select)\b([^>]*)>/gi)) {
      const inputAttrs = input[1] || "";
      const name = attributeValue(inputAttrs, "name") || "";
      if (!name) continue;
      inputs.push({ name, type: attributeValue(inputAttrs, "type") || "text" });
    }
    forms.push({ method, action, inputs });
    if (forms.length >= 20) break;
  }
  return forms;
}

function attributeValue(attrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*["']?([^"'\\s>]+)`, "i");
  return attrs.match(pattern)?.[1] || null;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function findBrowserLink(links: Array<{ text: string; url: string; href: string }>, args: Record<string, unknown>): { text: string; url: string; href: string } {
  const href = typeof args.href === "string" ? args.href : "";
  const text = typeof args.text === "string" ? args.text.toLowerCase() : "";
  const link = links.find((candidate) => href && (candidate.href === href || candidate.url === href))
    || links.find((candidate) => text && candidate.text.toLowerCase().includes(text));
  if (!link) throw new Error(`browser follow_link could not find link${text ? ` with text ${args.text}` : ""}${href ? ` with href ${href}` : ""}.`);
  return link;
}

function buildGithubCommand(args: Record<string, unknown>): { action: string; command: string[]; expectJson: boolean; category: "read" | "write" } {
  if (typeof args.action !== "string" || !args.action.trim()) {
    const command = parseGithubCommand(args.command);
    return {
      action: command.join(" "),
      command,
      expectJson: command.includes("--json"),
      category: isGithubWriteCommand(command) ? "write" : "read",
    };
  }
  const action = args.action;
  const state = typeof args.state === "string" ? args.state : "open";
  const limit = String(Math.min(100, positiveNumber(args.limit, 30)));
  if (action === "pr.get") {
    return {
      action,
      command: ["pr", "view", githubTarget(args), "--json", "number,title,state,author,headRefName,baseRefName,url,body,labels,reviewDecision,statusCheckRollup"],
      expectJson: true,
      category: "read",
    };
  }
  if (action === "pr.list") {
    return {
      action,
      command: ["pr", "list", "--state", state, "--limit", limit, "--json", "number,title,state,author,headRefName,baseRefName,url,labels"],
      expectJson: true,
      category: "read",
    };
  }
  if (action === "issue.get") {
    return {
      action,
      command: ["issue", "view", githubTarget(args), "--json", "number,title,state,author,url,body,labels,assignees,comments"],
      expectJson: true,
      category: "read",
    };
  }
  if (action === "issue.list") {
    return {
      action,
      command: ["issue", "list", "--state", state, "--limit", limit, "--json", "number,title,state,author,url,labels,assignees"],
      expectJson: true,
      category: "read",
    };
  }
  if (action === "pr.comment") {
    return {
      action,
      command: ["pr", "comment", githubTarget(args), "--body", githubBody(args)],
      expectJson: false,
      category: "write",
    };
  }
  if (action === "issue.comment") {
    return {
      action,
      command: ["issue", "comment", githubTarget(args), "--body", githubBody(args)],
      expectJson: false,
      category: "write",
    };
  }
  throw new Error(`Unsupported github structured action: ${action}`);
}

function githubActionCategory(args: Record<string, unknown>): "read" | "write" {
  return buildGithubCommand(args).category;
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

function isGithubWriteCommand(command: string[]): boolean {
  const joined = command.join(" ");
  return /\b(comment|create|edit|close|reopen|merge|ready|review|rerun|cancel|delete|dispatch)\b/.test(joined);
}

function githubTarget(args: Record<string, unknown>): string {
  const target = args.target ?? args.number ?? args.url ?? args.branch;
  const value = requiredString(target, "github target");
  if (/[;&|`$<>]/.test(value)) throw new Error("github target must not contain shell metacharacters.");
  return value;
}

function githubBody(args: Record<string, unknown>): string {
  const body = requiredString(args.body, "body");
  if (body.length > 20000) throw new Error("github body is too large.");
  return body;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
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

class ToolApprovalRequiredError extends Error {
  template?: ToolApprovalTemplate;

  constructor(message: string, template?: ToolApprovalTemplate) {
    super(message);
    this.template = template;
  }
}
