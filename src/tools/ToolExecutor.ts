import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Metadata, PermissionMode, RoleDefinition, Task, ToolPermission } from "../types.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import { parsePermissionMode } from "./PermissionMode.ts";
import { ToolGateway } from "./ToolGateway.ts";
import { createDefaultToolRegistry, type ToolRegistry } from "./ToolRegistry.ts";

const execFileAsync = promisify(execFile);

export interface ToolExecutionRequest {
  tool: string;
  args?: Record<string, unknown>;
  roleDefinition: RoleDefinition;
  permissionMode?: PermissionMode | unknown;
  task?: Task | null;
  runId?: string | null;
  sessionId?: string | null;
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
    const definition = gateway.assertAllowed(request.tool);
    const startedAt = new Date();
    const startedEventId = this.addEvent("tool.execution.started", request, {
      tool: definition.name,
      permissionMode,
      args: summarizeArgs(request.args || {}),
    });
    try {
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
      const result: ToolExecutionResult = {
        tool: definition.name,
        ok: false,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        sideEffects: definition.sideEffects,
        error: error instanceof Error ? error.message : String(error),
      };
      this.addEvent("tool.execution.failed", request, {
        tool: definition.name,
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
    if (tool === "git_reset") throw new Error("git_reset is declared but not executable without an external approval executor.");
    if (tool === "shell") throw new Error("shell is declared but not executable through the built-in executor.");
    if (tool === "network") throw new Error("network is declared but should be implemented by a dedicated browser/http executor.");
    throw new Error(`No executor registered for tool ${tool}.`);
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
    result[key] = key.toLowerCase().includes("content") ? `[${String(value).length} chars]` : value;
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
