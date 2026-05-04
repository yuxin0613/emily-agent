import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

const VALID_PERMISSION_MODES = new Set(["read_only", "workspace_write", "danger_full_access"]);

export async function startTui({ runtime }) {
  const rl = readline.createInterface({ input, output });
  const state = {
    sessionId: "tui",
    lastRunId: "",
    permissionMode: "workspace_write",
  };

  await printBanner(runtime, state);
  printHelp();

  try {
    while (true) {
      const raw = await readPromptLine(rl, state);
      if (raw === null) break;
      const message = raw.trim();
      if (!message) continue;
      if (["exit", "quit", ":q", "/q"].includes(message.toLowerCase())) break;

      try {
        if (isCommand(message)) {
          await handleCommand(runtime, state, message);
        } else {
          await sendChat(runtime, state, message);
        }
      } catch (error) {
        printError(error);
      }
    }
  } finally {
    rl.close();
  }
}

async function readPromptLine(
  rl: readline.Interface,
  state: { sessionId: string; lastRunId: string; permissionMode: string },
): Promise<string | null> {
  try {
    return await rl.question(promptFor(state));
  } catch (error) {
    if (!isTuiAbortError(error)) throw error;
    output.write("\n");
    return null;
  }
}

export function isTuiAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

async function printBanner(runtime, state): Promise<void> {
  const health = await safeHealth(runtime);
  const summary = [
    `session ${state.sessionId}`,
    `mode ${state.permissionMode}`,
    health ? `tasks ${health.pendingTasks}/${health.runningTasks}` : "tasks ?/?",
    health ? `graphs ${health.openTaskGraphs}` : "graphs ?",
  ].join("  ");
  if (output.isTTY) output.write("\x1Bc");
  else output.write("\n");
  output.write(`${style("Emily AgentOS", "bold")} ${style("terminal workspace", "dim")}\n`);
  output.write(`${style(summary, "gray")}\n`);
  output.write(`${style("Type a request, or use :help for commands. /new starts fresh; /clear hides this session.", "dim")}\n\n`);
}

function printHelp(): void {
  output.write(formatTuiHelp());
}

function promptFor(state: { sessionId: string; lastRunId: string; permissionMode: string }): string {
  const session = style(shortId(state.sessionId, 18), "cyan");
  const run = state.lastRunId ? ` ${style(`run ${state.lastRunId.slice(0, 8)}`, "gray")}` : "";
  const mode = state.permissionMode === "danger_full_access"
    ? style("danger", "yellow")
    : style(state.permissionMode === "read_only" ? "read" : "write", "gray");
  return `${style("emily", "bold")} ${session}${run} ${mode} ${style(">", "green")} `;
}

function isCommand(message: string): boolean {
  return message.startsWith(":") || message.startsWith("/");
}

async function handleCommand(runtime, state, message: string): Promise<void> {
  const prefix = message[0];
  const [command, ...args] = splitArgs(message.replace(/^[:/]/, ""));
  switch (command) {
    case "help":
    case "h":
      printHelp();
      return;
    case "health":
      printText(await runtime.runCommand("health", { format: "text" }));
      return;
    case "status":
      await printStatus(runtime, state);
      return;
    case "mode":
      setPermissionMode(state, args[0]);
      return;
    case "doctor":
      printText(await runtime.runCommand("doctor", { args, format: "text" }));
      return;
    case "providers":
      printText(await runtime.runCommand("providers", { format: "text" }));
      return;
    case "roles":
      printText(await runtime.runCommand("roles", { format: "text" }));
      return;
    case "commands":
      printCommands(runtime.listCommands());
      return;
    case "cron":
      printText(await runtime.runCommand("cron.list", { format: "text" }));
      return;
    case "cron-add":
      await addCron(runtime, state, args);
      return;
    case "cron-pause":
      printText(await runtime.runCommand("cron.pause", {
        input: { id: requiredArg(args[0], "cron id") },
        format: "text",
      }));
      return;
    case "cron-resume":
      printText(await runtime.runCommand("cron.resume", {
        input: { id: requiredArg(args[0], "cron id") },
        format: "text",
      }));
      return;
    case "cron-run":
      printText(await runtime.runCommand("cron.run", {
        input: { id: requiredArg(args[0], "cron id") },
        format: "text",
      }));
      return;
    case "cron-delete":
      printText(await runtime.runCommand("cron.delete", {
        input: { id: requiredArg(args[0], "cron id") },
        format: "text",
      }));
      return;
    case "sessions":
      printText(await runtime.runCommand("session.list", { input: sessionListOptions(args[0]), format: "text" }));
      return;
    case "resume":
      await resumeLatest(runtime, state, args);
      return;
    case "export-session":
      await exportSession(runtime, args);
      return;
    case "compact-preview":
      printText(await runtime.runCommand("session.compact_preview", {
        input: { sessionId: requiredArg(args[0], "session id"), maxMessages: numberArg(args[1], 20) },
        format: "text",
      }));
      return;
    case "session-usage":
      printText(await runtime.runCommand("session.usage", {
        input: { sessionId: requiredArg(args[0], "session id") },
        format: "text",
      }));
      return;
    case "tools":
      printText(await runtime.runCommand("tools", { format: "text" }));
      return;
    case "skills":
      printText(await runtime.runCommand("skills", { format: "text" }));
      return;
    case "candidates":
      printText(await runtime.runCommand("skills.candidates.list", {
        input: { status: args[0] || undefined, limit: 50 },
        format: "text",
      }));
      return;
    case "build-skills":
      printText(await runtime.runCommand("skills.candidates.build", {
        input: { minOccurrences: numberArg(args[0], 3), minScore: numberArg(args[1], 0.68) },
        format: "text",
      }));
      return;
    case "approve-skill":
      await approveSkill(runtime, args);
      return;
    case "reject-skill":
      await rejectSkill(runtime, args);
      return;
    case "experiences":
      printText(await runtime.runCommand("experiences.recall", {
        input: { q: args.join(" ").trim() || undefined, limit: 8 },
        format: "text",
      }));
      return;
    case "timeline":
      await printTimeline(runtime, state, args[0]);
      return;
    case "trace":
      await printTrace(runtime, args[0]);
      return;
    case "diagnostics":
      printText(args[0] === "repair" || args[0] === "true"
        ? await runtime.runCommand("diagnostics.repair", { format: "text" })
        : await runtime.runCommand("diagnostics.run", { format: "text" }));
      return;
    case "maintenance":
      printText(await runtime.runCommand("maintenance.run", { format: "text" }));
      return;
    case "new":
      await startNewSession(runtime, state, args);
      return;
    case "restore-session":
      await restoreSession(runtime, state, args);
      return;
    case "trash-session":
      await trashSession(runtime, args);
      return;
    case "session":
      if (!args[0]) throw new Error("session id is required");
      await selectSession(runtime, state, args[0]);
      printPanel("Session", state.sessionId, "cyan");
      return;
    case "messages":
      printText(await runtime.runCommand("session.messages", {
        input: { sessionId: state.sessionId, limit: numberArg(args[0], 40) },
        format: "text",
      }));
      return;
    case "clear":
      if (prefix === "/") {
        await clearCurrentSession(runtime, state);
        return;
      }
      output.write("\x1Bc");
      await printBanner(runtime, state);
      return;
    case "clear-screen":
      await printBanner(runtime, state);
      return;
    default:
      output.write(`\nUnknown command: ${command}\n\n`);
      printHelp();
  }
}

async function sendChat(runtime, state, message: string): Promise<void> {
  printChatBlock("Human", message, "cyan");
  const detachProgress = attachProgressReporter(runtime, state);
  const startedAt = Date.now();
  output.write(`${style("Working", "dim")} ${style("planner, agents, memory, and review will report progress here when active.", "gray")}\n`);
  let response;
  try {
    response = await runtime.handleUserMessage(message, {
      sessionId: state.sessionId,
      source: "tui",
      permissionMode: state.permissionMode,
    });
  } finally {
    detachProgress();
  }
  if (response.runId) state.lastRunId = response.runId;
  printChatBlock("Emily", response.content, "green");
  const meta = [];
  if (response.runId) meta.push(`run ${response.runId}`);
  if (response.delegatedTo?.length) meta.push(`agents ${response.delegatedTo.join(", ")}`);
  meta.push(`elapsed ${formatDuration(Date.now() - startedAt)}`);
  printMeta(meta);
  if (response.needsUserInput?.questions?.length) {
    printPanel("Needs Input", response.needsUserInput.questions.map((question) => `- ${question}`).join("\n"), "yellow");
  }
  output.write("\n");
}

async function printStatus(runtime, state): Promise<void> {
  const health = await safeHealth(runtime);
  const session = await runtime.runCommand("session.messages", {
    input: { sessionId: state.sessionId, limit: 1 },
  }).catch(() => []);
  const lines = [
    `session: ${state.sessionId}`,
    `permission mode: ${state.permissionMode}`,
    `last run: ${state.lastRunId || "(none)"}`,
    `messages loaded: ${Array.isArray(session) ? session.length : 0}`,
    health ? `tasks: ${health.pendingTasks} pending, ${health.runningTasks} running, ${health.expiredLeases} expired leases` : "tasks: unavailable",
    health ? `graphs: ${health.openTaskGraphs} open, diagnostics ${health.diagnostics}` : "graphs: unavailable",
  ];
  printPanel("Status", lines.join("\n"), "cyan");
}

function setPermissionMode(state, value?: string): void {
  if (!value) {
    printPanel("Permission Mode", [
      `current: ${state.permissionMode}`,
      "available: read_only, workspace_write, danger_full_access",
    ].join("\n"), "cyan");
    return;
  }
  if (!VALID_PERMISSION_MODES.has(value)) {
    throw new Error(`invalid permission mode: ${value}`);
  }
  state.permissionMode = value;
  printPanel("Permission Mode", `current: ${state.permissionMode}`, value === "danger_full_access" ? "yellow" : "cyan");
}

function printCommands(commands): void {
  output.write("\nCommands\n");
  printTable([
    ["Name", "Aliases", "Perm", "Description"],
    ...commands.map((command) => [
      command.name,
      (command.aliases || []).join(","),
      command.permission || "",
      truncate(command.description || "", 62),
    ]),
  ]);
  output.write("\n");
}

async function startNewSession(runtime, state, args: string[] = []): Promise<void> {
  const session = await runtime.runCommand("session.create", {
    input: {
      title: args.join(" ") || "New session",
      source: "tui",
      metadata: { createdBy: "tui" },
    },
  });
  state.sessionId = session.id;
  state.lastRunId = "";
  printPanel("New Session", session.id, "cyan");
}

async function addCron(runtime, state, args: string[]): Promise<void> {
  const name = requiredArg(args[0], "cron name");
  const schedule = requiredArg(args[1], "cron schedule");
  const message = args.slice(2).join(" ").trim();
  if (!message) throw new Error("cron message is required");
  printText(await runtime.runCommand("cron.create", {
    input: {
      name,
      schedule,
      message,
      sessionId: state.sessionId,
      source: "tui-cron",
    },
    format: "text",
  }));
}

async function resumeLatest(runtime, state, args: string[]): Promise<void> {
  if (args[0] && args[0] !== "latest") throw new Error("usage: :resume latest [hidden]");
  const session = await runtime.runCommand("session.resume_latest", {
    input: { includeHidden: args.includes("hidden") || args.includes("--hidden") },
  });
  if (!session) {
    printPanel("Resume", "No session to resume.", "yellow");
    return;
  }
  await selectSession(runtime, state, session.id);
  printPanel("Resumed Session", session.id, "cyan");
}

async function exportSession(runtime, args: string[]): Promise<void> {
  const sessionId = requiredArg(args[0], "session id");
  const format = args.includes("md") || args.includes("markdown") || args.includes("--markdown") ? "markdown" : "json";
  const exported = await runtime.runCommand("session.export", {
    input: { sessionId, format },
    format: format === "markdown" ? "text" : "json",
  });
  if (format === "markdown") {
    output.write(`\n${exported}\n`);
    return;
  }
  printJson(exported);
}

async function selectSession(runtime, state, sessionId: string): Promise<void> {
  state.sessionId = sessionId;
  const messages = await runtime.runCommand("session.messages", {
    input: { sessionId, limit: 40 },
  });
  const latest = [...messages].reverse().find((message) => message.runId);
  state.lastRunId = latest?.runId || "";
}

async function clearCurrentSession(runtime, state): Promise<void> {
  const result = await runtime.runCommand("session.clear", {
    input: {
      sessionId: state.sessionId,
      source: "tui",
      reason: "cleared from TUI",
      nextTitle: "New session",
    },
  });
  state.sessionId = result.next.id;
  state.lastRunId = "";
  printPanel("Session Cleared", [
    `hidden: ${result.hidden?.id || "(none)"}`,
    `current: ${result.next.id}`,
  ].join("\n"), "cyan");
}

async function restoreSession(runtime, state, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("session id is required");
  const session = await runtime.runCommand("session.restore", {
    input: { sessionId: args[0] },
  });
  await selectSession(runtime, state, session.id);
  printPanel("Restored Session", session.id, "cyan");
}

async function trashSession(runtime, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("session id is required");
  const session = await runtime.runCommand("session.trash", {
    input: {
      sessionId: args[0],
      reason: "trashed from TUI",
    },
  });
  printPanel("Trashed Session", [
    `session: ${session.id}`,
    `delete after: ${session.deleteAfter || "(not scheduled)"}`,
  ].join("\n"), "yellow");
}

async function approveSkill(runtime, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("candidate id is required");
  const reason = args.slice(1).join(" ") || "approved from TUI";
  printText(await runtime.runCommand("skills.candidates.approve", {
    input: { candidateId: args[0], reason },
    format: "text",
  }));
}

async function rejectSkill(runtime, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("candidate id is required");
  const reason = args.slice(1).join(" ") || "rejected from TUI";
  printText(await runtime.runCommand("skills.candidates.reject", {
    input: { candidateId: args[0], reason },
    format: "text",
  }));
}

async function printTimeline(runtime, state, runId?: string): Promise<void> {
  const targetRunId = runId || state.lastRunId;
  if (!targetRunId) throw new Error("run id is required");
  state.lastRunId = targetRunId;
  const timeline = await runtime.runCommand("timeline.get", {
    input: { runId: targetRunId },
  });
  output.write(`\nTimeline ${targetRunId}\n`);
  if (timeline.run) printJson(timeline.run);
  printTable([
    ["Task", "Role", "Status", "Title"],
    ...timeline.tasks.map((task) => [task.id.slice(0, 8), task.role, task.status, truncate(task.title, 64)]),
  ]);
  output.write("\nEvents\n");
  printTable([
    ["ID", "Type", "Task", "Created"],
    ...timeline.events.slice(-20).map((event) => [String(event.id), event.type, event.taskId ? event.taskId.slice(0, 8) : "", event.createdAt]),
  ]);
  output.write("\n");
}

async function printTrace(runtime, taskId?: string): Promise<void> {
  if (!taskId) throw new Error("task id is required");
  const trace = await runtime.runCommand("task.trace", {
    input: { taskId },
  });
  output.write(`\nTask Trace ${taskId}\n`);
  printJson(trace);
}

function attachProgressReporter(runtime, state): () => void {
  const manager = runtime.roleAgentManager;
  if (!manager?.on || !manager?.off) return () => undefined;
  const seen = new Set<string>();
  const handler = (envelope) => {
    const event = envelope?.event || null;
    const task = envelope?.task || null;
    const type = event?.type || envelope?.type || "";
    if (!shouldShowProgressEvent(type)) return;
    const eventKey = event?.id ? String(event.id) : `${type}:${envelope?.taskId || ""}:${task?.status || ""}`;
    if (seen.has(eventKey)) return;
    seen.add(eventKey);
    if (task?.metadata?.sessionId && task.metadata.sessionId !== state.sessionId) return;
    const line = formatProgressEvent(type, task, event);
    if (line) output.write(`${style("  |", "gray")} ${style(line, "gray")}\n`);
  };
  manager.on("event", handler);
  return () => manager.off("event", handler);
}

function shouldShowProgressEvent(type: string): boolean {
  if (!type) return false;
  if (/heartbeat|acknowledged|metadata|session\./.test(type)) return false;
  return type.startsWith("task.")
    || type.startsWith("task_graph.")
    || type.startsWith("tool.execution.")
    || type === "runtime.anomaly";
}

function formatProgressEvent(type: string, task, event): string {
  if (type.startsWith("task.")) {
    const status = type.replace(/^task\./, "");
    const role = task?.role ? `${task.role} ` : "";
    const title = task?.title ? ` - ${truncate(task.title, 72)}` : "";
    return `${role}${status}${title}`;
  }
  if (type.startsWith("task_graph.")) {
    return type.replace(/^task_graph\./, "graph ");
  }
  if (type.startsWith("tool.execution.")) {
    const tool = event?.payload?.tool || "tool";
    return `${tool} ${type.replace(/^tool\.execution\./, "")}`;
  }
  if (type === "runtime.anomaly") {
    return `anomaly: ${event?.payload?.code || event?.payload?.message || "runtime"}`;
  }
  return type;
}

function printChatBlock(label: string, content: string, color: keyof typeof ANSI): void {
  output.write("\n");
  output.write(`${style(label, color)}\n`);
  for (const line of wrapBlock(String(content || "").trim() || "(empty)", terminalWidth() - 4)) {
    output.write(`  ${line}\n`);
  }
  output.write("\n");
}

function printPanel(title: string, content: string, color: keyof typeof ANSI = "cyan"): void {
  output.write("\n");
  output.write(`${style(title, color)}\n`);
  for (const line of String(content || "").split("\n")) {
    output.write(`  ${line}\n`);
  }
  output.write("\n");
}

function printMeta(items: string[]): void {
  if (!items.length) return;
  output.write(`${style(items.map((item) => `[${item}]`).join(" "), "gray")}\n`);
}

function printJson(value): void {
  output.write(`\n${JSON.stringify(value, null, 2)}\n\n`);
}

function printText(value): void {
  output.write(`\n${String(value).trimEnd()}\n\n`);
}

function printError(error): void {
  const message = error instanceof Error ? error.message : String(error);
  printPanel("Error", message, "red");
}

function printTable(rows: string[][]): void {
  if (!rows.length) return;
  const widths = rows[0].map((_, index) => Math.min(34, Math.max(...rows.map((row) => visibleLength(row[index] || "")))));
  for (const [rowIndex, row] of rows.entries()) {
    output.write(row.map((cell, index) => pad(truncate(String(cell || ""), widths[index]), widths[index])).join("  "));
    output.write("\n");
    if (rowIndex === 0) {
      output.write(widths.map((width) => "-".repeat(width)).join("  "));
      output.write("\n");
    }
  }
}

function splitArgs(message: string): string[] {
  return message.match(/"[^"]*"|'[^']*'|\S+/g)?.map((item) => item.replace(/^["']|["']$/g, "")) || [];
}

function sessionListOptions(value?: string): {
  status?: "active" | "hidden" | "trashed" | "deleted";
  includeHidden?: boolean;
  includeTrashed?: boolean;
  includeDeleted?: boolean;
  limit?: number;
} {
  if (!value || value === "active") return { limit: 50 };
  if (value === "all") return { includeHidden: true, includeTrashed: true, limit: 80 };
  if (value === "hidden") return { status: "hidden", limit: 50 };
  if (value === "trash" || value === "trashed") return { status: "trashed", limit: 50 };
  if (value === "deleted") return { status: "deleted", limit: 50 };
  throw new Error(`invalid session list mode: ${value}`);
}

export function formatTuiHelp(): string {
  const sections: Array<[string, string[][]]> = [
    ["Chat", [
      ["type anything", "send a message to the current session"],
      ["/new [title]", "create a new visible session"],
      ["/clear", "hide current session and create a new one"],
      [":mode [mode]", "show or set read_only, workspace_write, danger_full_access"],
      [":status", "show current TUI/runtime status"],
    ]],
    ["Runtime", [
      [":health", "runtime health"],
      [":doctor [deep|repair]", "aggregated runtime doctor"],
      [":diagnostics [repair]", "runtime diagnostics"],
      [":maintenance", "run maintenance"],
      [":commands", "list command registry entries"],
    ]],
    ["Sessions", [
      [":sessions [all|hidden|trash]", "list sessions"],
      [":session <id>", "switch session"],
      [":messages [limit]", "show current session messages"],
      [":resume latest [hidden]", "resume latest session"],
      [":export-session <id> [md]", "export session"],
      [":compact-preview <id> [n]", "preview session compaction"],
      [":session-usage <id>", "provider usage for a session"],
      [":restore-session <id>", "restore hidden or trashed session"],
      [":trash-session <id>", "move session to trash"],
    ]],
    ["Work", [
      [":timeline [runId]", "show run timeline"],
      [":trace <taskId>", "show task trace"],
      [":providers", "list providers"],
      [":roles", "list roles"],
      [":tools", "list tools"],
      [":skills", "list skills"],
      [":experiences [query]", "list or search experiences"],
    ]],
    ["Skills And Cron", [
      [":candidates [status]", "list skill candidates"],
      [":build-skills", "build skill candidates"],
      [":approve-skill <id> [reason]", "approve proposed skill"],
      [":reject-skill <id> [reason]", "reject proposed skill"],
      [":cron", "list cron jobs"],
      [":cron-add <name> <cron> <msg>", "schedule a chat cron job"],
      [":cron-pause|resume|run|delete <id>", "control cron jobs"],
    ]],
    ["Shell", [
      [":clear-screen", "redraw the TUI"],
      ["exit", "quit"],
    ]],
  ];
  const lines = ["Commands"];
  for (const [section, rows] of sections) {
    lines.push("", `  ${section}`);
    const width = Math.max(...rows.map(([command]) => command.length));
    for (const [command, description] of rows) {
      lines.push(`    ${command.padEnd(width)}  ${description}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requiredArg(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function truncate(value: string, maxLength: number): string {
  value = stripAnsi(value);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

async function safeHealth(runtime): Promise<Record<string, number> | null> {
  try {
    return runtime.health();
  } catch {
    return null;
  }
}

function supportsColor(): boolean {
  return Boolean(output.isTTY && !process.env.NO_COLOR);
}

function style(value: string, key: keyof typeof ANSI): string {
  if (!supportsColor()) return value;
  const code = ANSI[key] || "";
  return `${code}${value}${ANSI.reset}`;
}

function stripAnsi(value: string): string {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function terminalWidth(): number {
  return Math.max(60, Math.min(120, output.columns || 88));
}

function wrapBlock(content: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim()) {
      lines.push("");
      continue;
    }
    lines.push(...wrapLine(rawLine, width));
  }
  return lines;
}

function wrapLine(line: string, width: number): string[] {
  if (visibleLength(line) <= width) return [line];
  const words = line.split(/(\s+)/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!word) continue;
    if (visibleLength(`${current}${word}`) <= width) {
      current += word;
      continue;
    }
    if (current.trim()) lines.push(current.trimEnd());
    current = word.trimStart();
    while (visibleLength(current) > width) {
      lines.push(current.slice(0, width));
      current = current.slice(width);
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length ? lines : [line.slice(0, width)];
}

function shortId(value: string, maxLength = 12): string {
  if (!value) return "";
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
