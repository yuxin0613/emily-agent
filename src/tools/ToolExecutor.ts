import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { domainToASCII } from "node:url";
import { promisify } from "node:util";
import type { Metadata, PermissionMode, RoleDefinition, Task, ToolPermission } from "../types.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import { getTaskMindMapNode } from "../tasks/TaskMindMap.ts";
import { parsePermissionMode } from "./PermissionMode.ts";
import { ToolGateway } from "./ToolGateway.ts";
import { createDefaultToolRegistry, type ToolRegistry } from "./ToolRegistry.ts";
import type { ToolDefinition } from "../types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 3600 * 1000;

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

interface OllamaWebSearchAttempt {
  baseUrl: URL;
  path: string;
  apiKey?: string;
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

export interface ToolExecutionEvent {
  eventId: number;
  type: string;
  request: ToolExecutionRequest;
  payload: Record<string, unknown>;
}

export class ToolExecutor {
  workspaceDir: string;
  taskStore: TaskStore | null;
  registry: ToolRegistry;
  toolCallTimeoutMs: number;
  onEvent: ((event: ToolExecutionEvent) => void) | null;

  constructor({
    workspaceDir = process.cwd(),
    taskStore = null,
    registry = createDefaultToolRegistry(),
    toolCallTimeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS,
    onEvent = null,
  }: {
    workspaceDir?: string;
    taskStore?: TaskStore | null;
    registry?: ToolRegistry;
    toolCallTimeoutMs?: number;
    onEvent?: ((event: ToolExecutionEvent) => void) | null;
  } = {}) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.taskStore = taskStore;
    this.registry = registry;
    this.toolCallTimeoutMs = normalizeToolCallTimeoutMs(toolCallTimeoutMs);
    this.onEvent = onEvent;
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
      const allowedDefinition = gateway.assertAllowed(request.tool);
      definition = allowedDefinition;
      const approvalRequirement = approvalRequirementFor(definition, request.args || {});
      startedEventId = this.addEvent("tool.execution.started", request, {
        tool: definition.name,
        permissionMode,
        timeoutMs: this.toolCallTimeoutMs,
        requiresApproval: definition.requiresApproval,
        approvalTemplate: approvalRequirement.template || "",
        args: summarizeArgs(request.args || {}),
      });
      this.assertApproved(approvalRequirement, request);
      const output = await withToolCallTimeout(
        () => this.executeAllowed(allowedDefinition.name, request.args || {}, request),
        this.toolCallTimeoutMs,
        allowedDefinition.name,
      );
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
        timeoutMs: this.toolCallTimeoutMs,
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
        timeoutMs: this.toolCallTimeoutMs,
        timedOut: error instanceof ToolCallTimeoutError,
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
    if (tool === "llm_wiki") return this.llmWiki(args);
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
    const method = parseHttpMethod(args.method);
    const maxBytes = positiveNumber(args.maxBytes, 256000);
    const timeoutMs = positiveNumber(args.timeoutMs, 15000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchWithPinnedEgress(url, {
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

  private async llmWiki(args: Record<string, unknown>): Promise<unknown> {
    const action = parseLlmWikiAction(args.action);
    const baseUrl = parseHttpUrl(String(args.baseUrl || process.env.EMILY_LLM_WIKI_BASE_URL || process.env.LLM_WIKI_BASE_URL || "http://127.0.0.1:6081"));
    if (action === "health") {
      return this.llmWikiRequest(baseUrl, "/health", { method: "GET", args });
    }
    if (action === "query") {
      return this.llmWikiRequest(baseUrl, "/v1/query", {
        method: "POST",
        args,
        body: {
          query: requiredString(args.query ?? args.q, "query"),
          top_k: boundedPositiveNumber(args.topK ?? args.top_k ?? args.limit, 5, 1, 50),
        },
      });
    }
    if (action === "import_url") {
      const urls = stringArray(args.urls ?? args.url, "urls");
      if (!urls.length) throw new Error("llm_wiki import_url requires urls.");
      return this.llmWikiRequest(baseUrl, "/v1/import-url", {
        method: "POST",
        args,
        body: { urls },
      });
    }
    if (action === "status") {
      const url = new URL("/v1/worker/status", baseUrl);
      url.searchParams.set("limit", String(boundedPositiveNumber(args.limit, 20, 1, 100)));
      return this.llmWikiRequest(url, "", { method: "GET", args });
    }
    if (action === "concepts") {
      return this.llmWikiRequest(baseUrl, "/v1/concepts", { method: "GET", args });
    }
    if (action === "analyze_page") {
      return this.llmWikiRequest(baseUrl, "/v1/pages/analyze", {
        method: "POST",
        args,
        body: {
          page_slug: requiredString(args.pageSlug ?? args.page_slug ?? args.slug, "pageSlug"),
          analysis_request: requiredString(args.analysisRequest ?? args.analysis_request ?? args.prompt, "analysisRequest"),
          ...(args.maxPages || args.max_pages ? { max_pages: boundedPositiveNumber(args.maxPages ?? args.max_pages, 3, 1, 20) } : {}),
        },
      });
    }
    if (action === "upload") {
      return this.llmWikiUpload(baseUrl, args);
    }
    throw new Error(`Unsupported llm_wiki action: ${action}`);
  }

  private async llmWikiRequest(baseUrl: URL, endpoint: string, {
    method,
    args,
    body,
  }: {
    method: "GET" | "POST";
    args: Record<string, unknown>;
    body?: unknown;
  }): Promise<unknown> {
    const url = endpoint ? new URL(endpoint, baseUrl) : baseUrl;
    const response = await fetchWithPinnedEgress(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Emily-AgentOS/1.0 llm_wiki",
        ...llmWikiAuthHeaders(args),
      },
      body: method === "POST" ? JSON.stringify(body || {}) : undefined,
      signal: AbortSignal.timeout(positiveNumber(args.timeoutMs, 30000)),
    });
    const text = await readResponseText(response, positiveNumber(args.maxBytes, 512000));
    if (!response.ok) throw new Error(`llm_wiki ${url.pathname} failed (${response.status}): ${text.text}`);
    return text.text ? parseJsonPayload(text.text, `llm_wiki ${url.pathname} response`) : {};
  }

  private async llmWikiUpload(baseUrl: URL, args: Record<string, unknown>): Promise<unknown> {
    const filePath = await this.resolveReadableWorkspacePath(requiredString(args.path ?? args.filePath ?? args.file, "path"));
    const url = new URL("/v1/upload", baseUrl);
    const content = await readFile(filePath);
    const filename = typeof args.name === "string" && args.name.trim() ? args.name.trim() : path.basename(filePath);
    const boundary = `----emily-agentos-${randomUUID()}`;
    const body = multipartFileBody({ boundary, fieldName: "files", filename, content });
    const response = await fetchWithPinnedEgress(url, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.byteLength),
        "User-Agent": "Emily-AgentOS/1.0 llm_wiki",
        ...llmWikiAuthHeaders(args),
      },
      body,
      signal: AbortSignal.timeout(positiveNumber(args.timeoutMs, 60000)),
    });
    const text = await readResponseText(response, positiveNumber(args.maxBytes, 512000));
    if (!response.ok) throw new Error(`llm_wiki upload failed (${response.status}): ${text.text}`);
    return text.text ? parseJsonPayload(text.text, "llm_wiki upload response") : {};
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
    const response = await fetchWithPinnedEgress(url, {
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
    const baseUrl = parseHttpUrl(String(args.baseUrl || process.env.EMILY_OLLAMA_BASE_URL || process.env.OLLAMA_HOST || "http://127.0.0.1:11434"));
    const configuredApiKey = firstString(args.apiKey, process.env.EMILY_OLLAMA_API_KEY);
    const envApiKey = String(process.env.OLLAMA_API_KEY || "").trim() || undefined;
    const attempts = buildOllamaWebSearchAttempts({ baseUrl, configuredApiKey, envApiKey });
    const body = JSON.stringify({ query, max_results: count });
    let lastError: Error | null = null;

    for (const attempt of attempts) {
      const endpoint = new URL(attempt.path, attempt.baseUrl);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "Emily-AgentOS/0.1 web_search",
      };
      if (attempt.apiKey) headers.Authorization = `Bearer ${attempt.apiKey}`;
      const response = await fetchWithPinnedEgress(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(positiveNumber(args.timeoutMs, 15000)),
      });
      if (response.status === 401) throw new Error("Ollama web search authentication failed. Run ollama signin or configure EMILY_OLLAMA_API_KEY/OLLAMA_API_KEY.");
      if (response.status === 403) throw new Error("Ollama web search is unavailable on the configured host.");
      if (!response.ok) {
        const detail = await readResponseText(response, 64000);
        const message = `Ollama web search failed (${response.status}): ${detail.text || ""}`.trim();
        lastError = new Error(message);
        if (response.status === 404) continue;
        throw lastError;
      }
      const payload = parseJsonPayload((await readResponseText(response, 256000)).text, "Ollama web search response");
      return webSearchResponse(query, "ollama", normalizeWebSearchPayload(payload, count), startedAt);
    }

    throw lastError || new Error("Ollama web search failed");
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
    const response = await fetchWithPinnedEgress(url, {
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
    if (typeof args.runId === "string" && typeof args.selector === "string") {
      return getTaskMindMapNode(this.taskStore, args.runId, args.selector);
    }
    const taskId = requiredString(args.taskId, "taskId");
    return this.taskStore.getTaskTrace(taskId);
  }

  private createTask(args: Record<string, unknown>, request: ToolExecutionRequest): unknown {
    if (!this.taskStore) throw new Error("create_task requires a TaskStore.");
    const graphKey = typeof args.graphKey === "string" && args.graphKey.trim() ? args.graphKey.trim() : "";
    const parentGraphKey = typeof args.parentKey === "string" && args.parentKey.trim()
      ? args.parentKey.trim()
      : typeof request.task?.metadata.graphKey === "string" ? request.task.metadata.graphKey : "";
    if (graphKey) {
      validateCreateTaskGraphNode({
        taskStore: this.taskStore,
        requestTask: request.task || null,
        graphKey,
        parentGraphKey,
      });
    }
    const inheritedGraph: Metadata = graphKey ? {
      graphKey,
      graphId: typeof request.task?.metadata.graphId === "string" ? request.task.metadata.graphId : "",
      parentKey: parentGraphKey,
      graphRole: requiredString(args.role, "role"),
      acceptanceCriteria: stringArray(args.acceptanceCriteria, "acceptanceCriteria").length
        ? stringArray(args.acceptanceCriteria, "acceptanceCriteria")
        : ["Task produces a useful result for the graph."],
      toolHints: stringArray(args.toolHints, "toolHints"),
      skillHints: stringArray(args.skillHints, "skillHints"),
      timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 30000,
      maxResultChars: typeof args.maxResultChars === "number" ? args.maxResultChars : 12000,
      maxMemoryCandidates: typeof args.maxMemoryCandidates === "number" ? args.maxMemoryCandidates : 1,
      wave: typeof request.task?.metadata.wave === "number" ? request.task.metadata.wave + 1 : 1,
      expandable: args.expandable === true,
      expansionGoal: typeof args.expansionGoal === "string" ? args.expansionGoal : "",
      maxExpansionDepth: typeof args.maxExpansionDepth === "number" ? args.maxExpansionDepth : 0,
    } : {};
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
        ...inheritedGraph,
      },
    });
    if (graphKey && request.task) {
      this.taskStore.addTaskDependency(task.id, request.task.id, args.dependencyType === "finished" ? "finished" : "success");
      this.taskStore.addEvent({
        type: "task_graph.node_added",
        taskId: task.id,
        payload: {
          runId: request.runId || request.task.metadata.runId || "",
          graphId: request.task.metadata.graphId || "",
          key: graphKey,
          parentKey: parentGraphKey,
          createdByTool: true,
        },
      });
    }
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
    const sanitizedPayload = sanitizeEventRecord(payload);
    const eventId = this.taskStore?.addEvent({
      type,
      taskId: request.task?.id || null,
      payload: {
        ...sanitizedPayload,
        runId: request.runId || request.task?.metadata.runId || "",
        sessionId: request.sessionId || request.task?.metadata.sessionId || "",
      },
    }) ?? null;
    if (eventId) this.onEvent?.({
      eventId,
      type,
      request: sanitizeRequestForEvent(request),
      payload: sanitizedPayload,
    });
    return eventId;
  }
}

function parseSafeTestCommand(input: unknown): string[] {
  const command = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.trim().split(/\s+/) : ["npm", "run", "check"];
  if (command[0] === "npm" && command[1] === "test" && command.length === 2) return command;
  if (command[0] === "npm" && command[1] === "run" && (command[2] === "check" || command[2] === "test") && command.length === 3) return command;
  if (command[0] === "node" && /^test\/[A-Za-z0-9._/-]+\.test\.ts$/.test(command[1] || "") && command.length === 2) return command;
  throw new Error(`run_tests only allows npm test, npm run check/test, or node test/*.test.ts. Received: ${command.join(" ")}`);
}

class ToolCallTimeoutError extends Error {
  constructor(tool: string, timeoutMs: number) {
    super(`Tool ${tool} timed out after ${timeoutMs}ms.`);
    this.name = "ToolCallTimeoutError";
  }
}

async function withToolCallTimeout<T>(operation: () => Promise<T>, timeoutMs: number, tool: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolCallTimeoutError(tool, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeToolCallTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 24 * 60 * 60 * 1000) {
    throw new Error("toolCallTimeoutMs must be between 1 and 86400000.");
  }
  return Math.round(value);
}

function parseHttpUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`http_fetch only supports http and https URLs. Received: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("HTTP URLs with embedded credentials are not allowed.");
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
    if (lower === "authorization" || lower === "cookie" || lower === "proxy-authorization" || lower === "host" || lower === "content-length" || lower === "transfer-encoding") {
      throw new Error(`Sensitive header ${key} is not allowed in tool args.`);
    }
    result[key] = String(value);
  }
  return result;
}

interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
  signal?: AbortSignal;
}

interface HttpEgressTarget {
  url: URL;
  connectHostname: string;
  hostHeader: string;
  servername?: string;
}

async function fetchWithPinnedEgress(url: URL, init: PinnedFetchInit = {}, redirectCount = 0): Promise<Response> {
  const target = await resolveHttpEgressTarget(url);
  return nativeHttpRequest(target, init, redirectCount);
}

async function resolveHttpEgressTarget(url: URL): Promise<HttpEgressTarget> {
  assertHttpUrlSafe(url);
  const hostname = url.hostname.toLowerCase();
  const literalIp = ipAddressFromHost(hostname);
  const hostHeader = url.host;
  const servername = literalIp ? undefined : url.hostname;

  if (isHttpEgressAllowedByPolicy(url)) {
    const connectHostname = literalIp || await firstResolvedAddress(hostname);
    return { url, connectHostname, hostHeader, servername };
  }

  if (isBlockedHostname(hostname)) {
    throw new Error(`HTTP egress to private or local host is blocked: ${url.hostname}`);
  }
  if (literalIp) {
    if (isPrivateAddress(literalIp)) {
      throw new Error(`HTTP egress to private or local address is blocked: ${url.hostname}`);
    }
    return { url, connectHostname: literalIp, hostHeader, servername };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const publicAddress = addresses.find((entry) => !isPrivateAddress(entry.address));
  if (!publicAddress) {
    throw new Error(`HTTP egress to private or local resolved address is blocked: ${url.hostname}`);
  }
  return { url, connectHostname: publicAddress.address, hostHeader, servername };
}

function nativeHttpRequest(target: HttpEgressTarget, init: PinnedFetchInit, redirectCount: number): Promise<Response> {
  const method = String(init.method || "GET").toUpperCase();
  const headers = pinnedRequestHeaders(init.headers, target.hostHeader);
  const transport = target.url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.url.protocol,
      hostname: target.connectHostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method,
      headers,
      signal: init.signal,
      ...(target.url.protocol === "https:" && target.servername ? { servername: target.servername } : {}),
    }, (response) => {
      const status = response.statusCode || 500;
      const headers = responseHeaders(response.headers);
      const location = headers.get("location");
      if (isRedirectStatus(status) && location && redirectCount < 5) {
        response.resume();
        const nextUrl = new URL(location, target.url);
        resolveHttpEgressTarget(nextUrl)
          .then((nextTarget) => nativeHttpRequest(nextTarget, redirectInit(init, status, method), redirectCount + 1))
          .then(resolve, reject);
        return;
      }
      const body = status === 204 || status === 304 ? null : Readable.toWeb(response) as unknown as BodyInit;
      resolve(new Response(body, {
        status,
        statusText: response.statusMessage,
        headers,
      }));
    });
    request.on("error", reject);
    if (init.body !== undefined && method !== "GET" && method !== "HEAD") {
      request.write(init.body);
    }
    request.end();
  });
}

function assertHttpUrlSafe(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HTTP tools only support http and https URLs. Received: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("HTTP URLs with embedded credentials are not allowed.");
  }
}

async function firstResolvedAddress(hostname: string): Promise<string> {
  const literalIp = ipAddressFromHost(hostname);
  if (literalIp) return literalIp;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  const first = addresses[0]?.address;
  if (!first) throw new Error(`Could not resolve HTTP egress host: ${hostname}`);
  return first;
}

function pinnedRequestHeaders(headers: Record<string, string> | undefined, hostHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === "host") continue;
    result[key] = value;
  }
  result.Host = hostHeader;
  return result;
}

function responseHeaders(rawHeaders: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectInit(init: PinnedFetchInit, status: number, method: string): PinnedFetchInit {
  if ((status === 301 || status === 302 || status === 303) && method !== "GET" && method !== "HEAD") {
    return {
      ...init,
      method: "GET",
      body: undefined,
      headers: withoutBodyHeaders(init.headers),
    };
  }
  return init;
}

function withoutBodyHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "content-type" || lower === "content-length" || lower === "transfer-encoding") continue;
    result[key] = value;
  }
  return result;
}

function llmWikiAuthHeaders(args: Record<string, unknown>): Record<string, string> {
  const token = typeof args.token === "string" && args.token.trim()
    ? args.token.trim()
    : String(process.env.EMILY_LLM_WIKI_TOKEN || process.env.LLM_WIKI_API_TOKEN || process.env.API_ACCESS_TOKEN || "").trim();
  return token ? { "X-API-Key": token, Authorization: `Bearer ${token}` } : {};
}

function stringArray(value: unknown, label: string): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.map(String).map((item) => item.trim()).filter(Boolean);
}

function multipartFileBody({
  boundary,
  fieldName,
  filename,
  content,
}: {
  boundary: string;
  fieldName: string;
  filename: string;
  content: Buffer;
}): Buffer {
  const escapedName = multipartToken(fieldName);
  const escapedFilename = multipartToken(filename);
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, "utf8"),
    Buffer.from(`Content-Disposition: form-data; name="${escapedName}"; filename="${escapedFilename}"\r\n`, "utf8"),
    Buffer.from("Content-Type: application/octet-stream\r\n\r\n", "utf8"),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
}

function multipartToken(value: string): string {
  return value.replace(/[\r\n"]/g, "_").slice(0, 200);
}

function isHttpEgressAllowedByPolicy(url: URL): boolean {
  if (process.env.EMILY_HTTP_ALLOW_PRIVATE === "true") return true;
  const hostname = canonicalHostname(url.hostname);
  const origin = canonicalOrigin(url);
  return parseCsvEnv("EMILY_HTTP_EGRESS_ALLOWLIST").some((entry) => allowlistEntryMatches(entry, hostname, origin));
}

function parseCsvEnv(name: string): string[] {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

type HttpEgressAllowlistEntry =
  | { kind: "host"; hostname: string }
  | { kind: "origin"; origin: string }
  | { kind: "wildcard"; suffix: string };

function allowlistEntryMatches(entry: string, hostname: string, origin: string): boolean {
  const normalized = normalizeAllowlistEntry(entry);
  if (!normalized) return false;
  if (normalized.kind === "origin") return normalized.origin === origin;
  if (normalized.kind === "wildcard") return hostname !== normalized.suffix && hostname.endsWith(`.${normalized.suffix}`);
  return normalized.hostname === hostname;
}

function normalizeAllowlistEntry(entry: string): HttpEgressAllowlistEntry | null {
  const raw = entry.trim().toLowerCase();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
      return { kind: "origin", origin: canonicalOrigin(url) };
    } catch {
      return null;
    }
  }
  if (raw.startsWith("*.")) {
    const suffix = canonicalHostname(raw.slice(2));
    if (!suffix || suffix.includes("*") || suffix.includes(":") || !/[a-z]/i.test(suffix)) return null;
    return { kind: "wildcard", suffix };
  }
  const hostname = canonicalHostname(raw);
  if (!hostname || hostname.includes("*") || hostname.includes(":")) return null;
  return { kind: "host", hostname };
}

function canonicalHostname(hostname: string): string {
  const stripped = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!stripped) return "";
  const literalIp = ipAddressFromHost(stripped);
  if (literalIp) return literalIp.toLowerCase();
  return (domainToASCII(stripped) || stripped).toLowerCase();
}

function canonicalOrigin(url: URL): string {
  const hostname = canonicalHostname(url.hostname);
  const literalIp = ipAddressFromHost(hostname);
  const host = literalIp && isIP(literalIp) === 6 ? `[${literalIp}]` : hostname;
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
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
  const normalized = address.replace(/^\[|\]$/g, "").toLowerCase().replace(/%.+$/, "");
  const embeddedIpv4 = normalized.match(/(?:^|:)(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) return isPrivateIpv4(embeddedIpv4);
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) {
    const mappedIpv4 = ipv4FromMappedIpv6(normalized);
    if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
    return normalized === "::1"
      || normalized === "::"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:");
  }
  return false;
}

function ipv4FromMappedIpv6(address: string): string | null {
  const hextets = expandIpv6(address);
  if (!hextets) return null;
  const prefixIsZero = hextets.slice(0, 5).every((part) => part === 0);
  if (!prefixIsZero || (hextets[5] !== 0 && hextets[5] !== 0xffff)) return null;
  const high = hextets[6];
  const low = hextets[7];
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join(".");
}

function expandIpv6(address: string): number[] | null {
  if (address.includes(".")) return null;
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces[1] ? pieces[1].split(":") : [];
  const missing = pieces.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const raw = pieces.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (raw.length !== 8) return null;
  const hextets: number[] = [];
  for (const part of raw) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    hextets.push(Number.parseInt(part, 16));
  }
  return hextets;
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
  if (definition.name === "llm_wiki") {
    const template = llmWikiActionCategory(args) === "write" ? "network_write" : "network_read";
    return {
      required: true,
      template,
      reason: "LLM Wiki tool execution requires explicit network approval",
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

type LlmWikiAction = "health" | "query" | "import_url" | "status" | "concepts" | "analyze_page" | "upload";

function parseLlmWikiAction(value: unknown): LlmWikiAction {
  const action = String(value || "query").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (action === "health") return "health";
  if (action === "query" || action === "search") return "query";
  if (action === "import_url" || action === "import" || action === "import_urls") return "import_url";
  if (action === "status" || action === "worker_status") return "status";
  if (action === "concepts" || action === "list_concepts" || action === "pages") return "concepts";
  if (action === "analyze_page" || action === "analyze") return "analyze_page";
  if (action === "upload" || action === "ingest_file" || action === "file") return "upload";
  throw new Error(`Unsupported llm_wiki action: ${String(value)}`);
}

function llmWikiActionCategory(args: Record<string, unknown>): "read" | "write" {
  const action = parseLlmWikiAction(args.action);
  return action === "import_url" || action === "analyze_page" || action === "upload" ? "write" : "read";
}

function parseWebSearchProvider(value: unknown): "endpoint" | "ollama" | "duckduckgo" {
  const raw = String(value || process.env.EMILY_WEB_SEARCH_PROVIDER || (process.env.EMILY_WEB_SEARCH_ENDPOINT ? "endpoint" : "ollama")).trim().toLowerCase();
  if (raw === "endpoint" || raw === "custom") return "endpoint";
  if (raw === "ollama") return "ollama";
  if (raw === "duckduckgo" || raw === "ddg") return "duckduckgo";
  throw new Error(`Unsupported web_search provider: ${raw}`);
}

const OLLAMA_HOSTED_WEB_SEARCH_PATH = "/api/web_search";
const OLLAMA_LOCAL_WEB_SEARCH_PROXY_PATH = "/api/experimental/web_search";
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";

function buildOllamaWebSearchAttempts({
  baseUrl,
  configuredApiKey,
  envApiKey,
}: {
  baseUrl: URL;
  configuredApiKey?: string;
  envApiKey?: string;
}): OllamaWebSearchAttempt[] {
  if (isOllamaCloudBaseUrl(baseUrl)) {
    return [{
      baseUrl,
      path: OLLAMA_HOSTED_WEB_SEARCH_PATH,
      apiKey: configuredApiKey || envApiKey,
    }];
  }

  const attempts: OllamaWebSearchAttempt[] = [
    {
      baseUrl,
      path: OLLAMA_LOCAL_WEB_SEARCH_PROXY_PATH,
      apiKey: configuredApiKey,
    },
    {
      baseUrl,
      path: OLLAMA_HOSTED_WEB_SEARCH_PATH,
      apiKey: configuredApiKey,
    },
  ];
  if (envApiKey) {
    attempts.push({
      baseUrl: new URL(OLLAMA_CLOUD_BASE_URL),
      path: OLLAMA_HOSTED_WEB_SEARCH_PATH,
      apiKey: envApiKey,
    });
  }
  return attempts;
}

function isOllamaCloudBaseUrl(baseUrl: URL): boolean {
  return baseUrl.protocol === "https:" && canonicalHostname(baseUrl.hostname) === "ollama.com";
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
    const hasBodyInput = normalized.some((part) => part === "-f"
      || part === "--field"
      || part.startsWith("--field=")
      || part === "--raw-field"
      || part.startsWith("--raw-field=")
      || part === "--input"
      || part.startsWith("--input="));
    return method !== "get" || hasBodyInput;
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

const GRAPH_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

function validateCreateTaskGraphNode({
  taskStore,
  requestTask,
  graphKey,
  parentGraphKey,
}: {
  taskStore: TaskStore;
  requestTask: Task | null;
  graphKey: string;
  parentGraphKey: string;
}): void {
  if (!GRAPH_KEY_PATTERN.test(graphKey)) throw new Error(`invalid graphKey: ${graphKey}`);
  if (!parentGraphKey) throw new Error("parentKey is required when graphKey is provided.");
  if (!GRAPH_KEY_PATTERN.test(parentGraphKey)) throw new Error(`invalid parentKey: ${parentGraphKey}`);
  if (parentGraphKey === graphKey) throw new Error(`task cannot be its own parent: ${graphKey}`);

  const graphId = typeof requestTask?.metadata.graphId === "string" ? requestTask.metadata.graphId : "";
  if (!graphId) throw new Error("create_task graphKey requires an existing graph task context.");

  const existingKeys = new Set(taskStore.getTasksForGraph(graphId).map(taskGraphKey).filter(Boolean));
  if (existingKeys.has(graphKey)) throw new Error(`graphKey already exists: ${graphKey}`);
  if (!existingKeys.has(parentGraphKey)) throw new Error(`unknown parentKey for ${graphKey}: ${parentGraphKey}`);
}

function taskGraphKey(task: Task): string {
  return typeof task.metadata.graphKey === "string" ? task.metadata.graphKey : "";
}

function sanitizeRequestForEvent(request: ToolExecutionRequest): ToolExecutionRequest {
  return {
    ...request,
    args: request.args ? summarizeArgs(request.args) : request.args,
    approval: request.approval ? sanitizeEventRecord(request.approval as Record<string, unknown>) as ToolApproval : request.approval,
  };
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return sanitizeEventRecord(args);
}

function sanitizeEventRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const seen = new WeakSet<object>();
  for (const [key, value] of Object.entries(record)) {
    result[key] = sanitizeEventValue(key, value, seen);
  }
  return result;
}

function sanitizeEventValue(key: string, value: unknown, seen: WeakSet<object>): unknown {
  if (isSensitiveEventKey(key)) return "[redacted]";
  if (isLargeEventKey(key)) return `[${String(value).length} chars]`;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeEventValue("", item, seen));
  }
  if (isObject(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeEventValue(childKey, childValue, seen);
    }
    seen.delete(value);
    return result;
  }
  return value;
}

function isSensitiveEventKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("token")
    || normalized.includes("apikey")
    || normalized.includes("authorization")
    || normalized.includes("password")
    || normalized.includes("secret")
    || normalized.includes("credential")
    || normalized.includes("privatekey")
    || normalized.includes("cookie");
}

function isLargeEventKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("content") || normalized.includes("body");
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
