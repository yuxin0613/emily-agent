import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
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
    if (tool === "web_search") return this.webSearch(args);
    if (tool === "browser") return this.browser(args);
    if (tool === "github") return this.github(args);
    if (tool === "git_reset") throw new Error("git_reset is declared but not executable without an external approval executor.");
    if (tool === "shell") throw new Error("shell is declared but not executable through the built-in executor.");
    if (tool === "network") throw new Error("network is declared as a broad permission; use web_search, http_fetch, browser, or github instead.");
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
    const filePath = await this.resolveReadableWorkspacePath(requiredString(args.path, "path"));
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
    const filePath = await this.resolveWritableWorkspacePath(requiredString(args.path, "path"));
    const content = String(args.content ?? "");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return {
      path: path.relative(this.workspaceDir, filePath),
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }

  private async deleteFile(args: Record<string, unknown>): Promise<{ path: string; deleted: boolean }> {
    const filePath = await this.resolveDeletableWorkspacePath(requiredString(args.path, "path"));
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
    await assertAllowedHttpEgress(url);
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

  private async webSearch(args: Record<string, unknown>): Promise<{
    query: string;
    provider: string;
    count: number;
    tookMs: number;
    externalContent: { untrusted: boolean; source: string; provider: string };
    results: WebSearchResult[];
    setupHint?: string;
  }> {
    const query = requiredString(args.query ?? args.q, "query").trim();
    const count = boundedPositiveNumber(args.count ?? args.limit, 5, 1, 10);
    const provider = parseWebSearchProvider(args.provider);
    const startedAt = Date.now();
    if (provider === "endpoint") return this.endpointWebSearch(args, query, count, startedAt);
    if (provider === "ollama") return this.ollamaWebSearch(args, query, count, startedAt);
    return this.duckDuckGoWebSearch(query, count, startedAt);
  }

  private async endpointWebSearch(args: Record<string, unknown>, query: string, count: number, startedAt: number): Promise<{
    query: string;
    provider: string;
    count: number;
    tookMs: number;
    externalContent: { untrusted: boolean; source: string; provider: string };
    results: WebSearchResult[];
    setupHint?: string;
  }> {
    const endpoint = typeof args.endpoint === "string" && args.endpoint.trim()
      ? args.endpoint.trim()
      : String(process.env.EMILY_WEB_SEARCH_ENDPOINT || "").trim();
    if (!endpoint) {
      return webSearchResponse(query, "endpoint", [], startedAt, "Set EMILY_WEB_SEARCH_ENDPOINT or use provider=duckduckgo/ollama.");
    }
    const method = String(args.method || process.env.EMILY_WEB_SEARCH_METHOD || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error(`web_search endpoint supports GET or POST. Received: ${method}`);
    const url = new URL(endpoint);
    if (method === "GET") {
      url.searchParams.set("query", query);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      url.searchParams.set("limit", String(count));
    }
    await assertAllowedHttpEgress(url);
    const response = await fetch(url.toString(), {
      method,
      headers: { "Content-Type": "application/json", "User-Agent": "Emily-AgentOS/0.1 web_search" },
      body: method === "POST" ? JSON.stringify({ query, q: query, count, limit: count }) : undefined,
      signal: AbortSignal.timeout(positiveNumber(args.timeoutMs, 15000)),
    });
    if (!response.ok) {
      const detail = await readResponseText(response, 64000);
      throw new Error(`web_search endpoint failed (${response.status}): ${detail.text || ""}`.trim());
    }
    const payload = parseJsonPayload((await readResponseText(response, 256000)).text, "web_search endpoint response");
    return webSearchResponse(query, "endpoint", normalizeWebSearchPayload(payload, count), startedAt);
  }

  private async ollamaWebSearch(args: Record<string, unknown>, query: string, count: number, startedAt: number): Promise<{
    query: string;
    provider: string;
    count: number;
    tookMs: number;
    externalContent: { untrusted: boolean; source: string; provider: string };
    results: WebSearchResult[];
  }> {
    const baseUrl = new URL(String(args.baseUrl || process.env.EMILY_OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434"));
    const endpoint = new URL("/api/experimental/web_search", baseUrl);
    await assertAllowedHttpEgress(endpoint);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Emily-AgentOS/0.1 web_search",
    };
    if (process.env.EMILY_OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.EMILY_OLLAMA_API_KEY}`;
    const response = await fetch(endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ query, max_results: count }),
      signal: AbortSignal.timeout(positiveNumber(args.timeoutMs, 15000)),
    });
    if (response.status === 401) throw new Error("Ollama web search authentication failed. Run ollama signin or configure EMILY_OLLAMA_API_KEY.");
    if (response.status === 403) throw new Error("Ollama web search is unavailable on the configured host.");
    if (!response.ok) {
      const detail = await readResponseText(response, 64000);
      throw new Error(`Ollama web search failed (${response.status}): ${detail.text || ""}`.trim());
    }
    const payload = parseJsonPayload((await readResponseText(response, 256000)).text, "Ollama web search response");
    return webSearchResponse(query, "ollama", normalizeWebSearchPayload(payload, count), startedAt);
  }

  private async duckDuckGoWebSearch(query: string, count: number, startedAt: number): Promise<{
    query: string;
    provider: string;
    count: number;
    tookMs: number;
    externalContent: { untrusted: boolean; source: string; provider: string };
    results: WebSearchResult[];
  }> {
    const url = new URL("https://duckduckgo.com/html/");
    url.searchParams.set("q", query);
    await assertAllowedHttpEgress(url);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": "Emily-AgentOS/0.1 web_search" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const detail = await readResponseText(response, 64000);
      throw new Error(`DuckDuckGo web search failed (${response.status}): ${detail.text || ""}`.trim());
    }
    const body = await readResponseText(response, 512000);
    return webSearchResponse(query, "duckduckgo", parseDuckDuckGoResults(body.text, url.toString(), count), startedAt);
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

  private resolveLexicalWorkspacePath(input: string): string {
    const resolved = path.resolve(this.workspaceDir, input);
    if (resolved !== this.workspaceDir && !resolved.startsWith(`${this.workspaceDir}${path.sep}`)) {
      throw new Error(`Path escapes workspace: ${input}`);
    }
    return resolved;
  }

  private async resolveReadableWorkspacePath(input: string): Promise<string> {
    const resolved = this.resolveLexicalWorkspacePath(input);
    const real = await realpath(resolved);
    await this.assertRealPathInsideWorkspace(real, input);
    return real;
  }

  private async resolveWritableWorkspacePath(input: string): Promise<string> {
    const resolved = this.resolveLexicalWorkspacePath(input);
    await this.assertParentInsideWorkspace(path.dirname(resolved), input);
    const stats = await lstat(resolved).catch((error) => {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    });
    if (stats?.isSymbolicLink()) {
      throw new Error(`Refusing to write through workspace symlink: ${input}`);
    }
    if (stats) await this.assertRealPathInsideWorkspace(await realpath(resolved), input);
    return resolved;
  }

  private async resolveDeletableWorkspacePath(input: string): Promise<string> {
    const resolved = this.resolveLexicalWorkspacePath(input);
    await this.assertParentInsideWorkspace(path.dirname(resolved), input);
    const stats = await lstat(resolved);
    if (!stats.isSymbolicLink()) await this.assertRealPathInsideWorkspace(await realpath(resolved), input);
    return resolved;
  }

  private async assertParentInsideWorkspace(parentPath: string, originalInput: string): Promise<void> {
    const existingParent = await nearestExistingParent(parentPath);
    await this.assertRealPathInsideWorkspace(await realpath(existingParent), originalInput);
  }

  private async assertRealPathInsideWorkspace(realTarget: string, originalInput: string): Promise<void> {
    const realWorkspace = await realpath(this.workspaceDir);
    if (realTarget !== realWorkspace && !realTarget.startsWith(`${realWorkspace}${path.sep}`)) {
      throw new Error(`Path escapes workspace through symlink: ${originalInput}`);
    }
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

async function assertAllowedHttpEgress(url: URL): Promise<void> {
  if (isHttpEgressAllowedByPolicy(url)) return;
  const hostname = url.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new Error(`HTTP egress to private or local host is blocked: ${url.hostname}`);
  }
  const literalIp = ipAddressFromHost(hostname);
  if (literalIp && isPrivateAddress(literalIp)) {
    throw new Error(`HTTP egress to private or local address is blocked: ${url.hostname}`);
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new Error(`HTTP egress to private or local resolved address is blocked: ${url.hostname}`);
    }
  }
}

function isHttpEgressAllowedByPolicy(url: URL): boolean {
  if (process.env.EMILY_HTTP_ALLOW_PRIVATE === "true") return true;
  const hostname = url.hostname.toLowerCase();
  const origin = url.origin.toLowerCase();
  return parseCsvEnv("EMILY_HTTP_EGRESS_ALLOWLIST").some((entry) => {
    const normalized = entry.toLowerCase();
    if (normalized === hostname || normalized === origin) return true;
    if (normalized.startsWith("*.")) return hostname.endsWith(normalized.slice(1));
    return false;
  });
}

function parseCsvEnv(name: string): string[] {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function ipAddressFromHost(hostname: string): string | null {
  const bracketless = hostname.replace(/^\[|\]$/g, "");
  return isIP(bracketless) ? bracketless : null;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "0"
    || normalized === "0.0.0.0"
    || normalized === "::"
    || normalized === "::1";
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
  const embeddedIpv4 = normalized.match(/(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) return isPrivateIpv4(embeddedIpv4);
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) {
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("2001:db8:");
  }
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
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
  if (definition.name === "web_search") {
    return {
      required: true,
      template: "network_read",
      reason: "Web search requires explicit network approval",
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

function parseWebSearchProvider(value: unknown): "endpoint" | "ollama" | "duckduckgo" {
  const raw = String(value || process.env.EMILY_WEB_SEARCH_PROVIDER || (process.env.EMILY_WEB_SEARCH_ENDPOINT ? "endpoint" : "duckduckgo")).trim().toLowerCase();
  if (raw === "endpoint" || raw === "custom") return "endpoint";
  if (raw === "ollama") return "ollama";
  if (raw === "duckduckgo" || raw === "ddg") return "duckduckgo";
  throw new Error(`Unsupported web_search provider: ${raw}`);
}

function webSearchResponse(
  query: string,
  provider: string,
  results: WebSearchResult[],
  startedAt: number,
  setupHint?: string,
): {
  query: string;
  provider: string;
  count: number;
  tookMs: number;
  externalContent: { untrusted: boolean; source: string; provider: string };
  results: WebSearchResult[];
  setupHint?: string;
} {
  return {
    query,
    provider,
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider,
    },
    results,
    ...(setupHint ? { setupHint } : {}),
  };
}

function normalizeWebSearchPayload(payload: unknown, count: number): WebSearchResult[] {
  const rawResults = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.results)
      ? payload.results
      : isObject(payload) && Array.isArray(payload.items)
        ? payload.items
        : [];
  const results: WebSearchResult[] = [];
  for (const raw of rawResults) {
    const normalized = normalizeWebSearchResult(raw);
    if (!normalized) continue;
    results.push(normalized);
    if (results.length >= count) break;
  }
  return results;
}

function normalizeWebSearchResult(value: unknown): WebSearchResult | null {
  if (!isObject(value)) return null;
  const url = firstString(value.url, value.link, value.href);
  if (!url) return null;
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const title = truncateText(firstString(value.title, value.name) || parsed.hostname, 200);
  const snippet = truncateText(firstString(value.snippet, value.content, value.description, value.text) || "", 320);
  return {
    title,
    url: parsed.toString(),
    snippet,
    siteName: siteName(parsed),
  };
}

function parseDuckDuckGoResults(html: string, baseUrl: string, count: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const blockPattern = /<div\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bresult\b|$)/gi;
  for (const block of html.matchAll(blockPattern)) {
    const body = block[1] || "";
    const href = attributeValue(body.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>/i)?.[0] || "", "href");
    if (!href) continue;
    const url = normalizeSearchResultUrl(new URL(href, baseUrl).toString());
    if (!url || seen.has(url) || isSearchUtilityUrl(url)) continue;
    const title = decodeHtml(stripHtml(body.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1] || "")).replace(/\s+/g, " ").trim();
    const snippet = decodeHtml(stripHtml(body.match(/<a\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i)?.[1]
      || body.match(/<div\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]
      || "")).replace(/\s+/g, " ").trim();
    const parsed = safeUrl(url);
    if (!parsed) continue;
    seen.add(url);
    results.push({
      title: truncateText(title || parsed.hostname, 200),
      url,
      snippet: truncateText(snippet, 320),
      siteName: siteName(parsed),
    });
    if (results.length >= count) return results;
  }
  for (const link of extractLinks(html, baseUrl)) {
    const url = normalizeSearchResultUrl(link.url);
    if (!url || seen.has(url) || isSearchUtilityUrl(url)) continue;
    const parsed = safeUrl(url);
    if (!parsed) continue;
    seen.add(url);
    results.push({
      title: truncateText(link.text || parsed.hostname, 200),
      url,
      snippet: "",
      siteName: siteName(parsed),
    });
    if (results.length >= count) break;
  }
  return results;
}

function normalizeSearchResultUrl(input: string): string | null {
  const parsed = safeUrl(input);
  if (!parsed) return null;
  const uddg = parsed.searchParams.get("uddg");
  if (uddg) return safeUrl(uddg)?.toString() || null;
  return parsed.toString();
}

function isSearchUtilityUrl(input: string): boolean {
  const parsed = safeUrl(input);
  if (!parsed) return true;
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "duckduckgo.com"
    || hostname.endsWith(".duckduckgo.com")
    || parsed.protocol !== "http:" && parsed.protocol !== "https:";
}

function siteName(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars).trim()}...` : value;
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
  const normalized = command.map((part) => part.toLowerCase());
  if (normalized[0] === "api") {
    const method = githubApiMethod(normalized);
    if (method && method !== "get") return true;
    return normalized.some((part) => part === "-f"
      || part === "--field"
      || part.startsWith("--field=")
      || part === "--raw-field"
      || part.startsWith("--raw-field=")
      || part === "--input"
      || part.startsWith("--input="));
  }
  const joined = normalized.join(" ");
  return /\b(comment|create|edit|close|reopen|merge|ready|review|rerun|cancel|delete|dispatch)\b/.test(joined);
}

function githubApiMethod(command: string[]): string | null {
  for (let index = 0; index < command.length; index += 1) {
    const part = command[index];
    if (part === "--method" || part === "-x") return command[index + 1] || null;
    const match = part.match(/^--method=(.+)$/);
    if (match) return match[1];
  }
  return null;
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

async function nearestExistingParent(inputPath: string): Promise<string> {
  let current = inputPath;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const next = path.dirname(current);
      if (next === current) throw error;
      current = next;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function positiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boundedPositiveNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Math.floor(positiveNumber(value, fallback));
  return Math.max(min, Math.min(max, number));
}

function parseJsonPayload(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
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
  if (hasStringProperty(output, "stdout")) {
    const stderr = hasStringProperty(output, "stderr") ? output.stderr : undefined;
    return {
      ...output,
      stdout: `[${output.stdout.length} chars]`,
      stderr: stderr === undefined ? undefined : `[${stderr.length} chars]`,
    };
  }
  return output;
}

function hasStringProperty<T extends string>(value: object, key: T): value is object & Record<T, string> {
  return key in value && typeof (value as Record<string, unknown>)[key] === "string";
}

class ToolApprovalRequiredError extends Error {
  template?: ToolApprovalTemplate;

  constructor(message: string, template?: ToolApprovalTemplate) {
    super(message);
    this.template = template;
  }
}
