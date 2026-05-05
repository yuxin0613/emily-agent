import readline from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { statusLabel } from "../tasks/TaskMindMap.ts";

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

const TUI_GLYPHS = {
  user: "❯",
  assistant: "┊",
  system: "·",
  tool: "⚡",
};

const EMILY_WORDMARK = [
  "███████╗███╗   ███╗██╗██╗     ██╗   ██╗",
  "██╔════╝████╗ ████║██║██║     ╚██╗ ██╔╝",
  "█████╗  ██╔████╔██║██║██║      ╚████╔╝ ",
  "██╔══╝  ██║╚██╔╝██║██║██║       ╚██╔╝  ",
  "███████╗██║ ╚═╝ ██║██║███████╗   ██║   ",
  "╚══════╝╚═╝     ╚═╝╚═╝╚══════╝   ╚═╝   ",
  "              AGENTOS                  ",
];

const EMILY_3D_LOGO = [
  "  ______ __  __  ____ __    __ __  ",
  " / ____//  |/  |/  _// /   / // /  ",
  "/ __/  / /|_/ / / / / /   / // /   ",
  "/ /___ / /  / /_/ / / /___/ // /___ ",
  "/_____//_/  /_//___//_____//_____/",
  "  ╲_____╲╲_____╲╲____╲╲____╲╲____╲ ",
  "   ╲_____╲╲_____╲╲____╲╲____╲╲____╲",
  "        E M I L Y   A G E N T O S  ",
];

const VALID_PERMISSION_MODES = new Set(["read_only", "workspace_write", "danger_full_access"]);
const BUSY_SAFE_COMMANDS = new Set([
  "help",
  "h",
  "health",
  "status",
  "sub",
  "subagents",
  "providers",
  "roles",
  "tools",
  "skills",
  "dag",
  "graph",
  "mindmap",
  "node",
  "timeline",
  "messages",
  "commands",
]);

type TuiHelpMode = "common" | "all";
type TuiHelpSection = [string, string[][]];

const TUI_COMMON_HELP_SECTIONS: TuiHelpSection[] = [
  ["Chat", [
    ["type anything", "send a message to the current session"],
    ["/help", "show common commands"],
    ["/help all", "show every advanced command"],
    ["/new [title]", "create a new visible session"],
    ["/clear", "hide current session and create a new one"],
    ["/status", "show current TUI/runtime status"],
    ["/mode [mode]", "show or set read_only, workspace_write, danger_full_access"],
  ]],
  ["Sessions", [
    ["/sessions [all|hidden|trash]", "list sessions"],
    ["/messages [limit]", "show current session messages"],
    ["/resume latest [hidden]", "resume latest session"],
    ["/export-session <id> [md]", "export session"],
  ]],
  ["Inspect", [
    ["/providers", "list providers"],
    ["/sub", "show running subagents and tasks"],
    ["/roles", "list roles"],
    ["/tools", "list tools"],
    ["/skills", "list skills"],
    ["/dag list", "list recent DAG roots"],
    ["/dag <root_id>", "open interactive DAG editor"],
    ["/graph [runId]", "show task mind map"],
    ["/node <key> [runId]", "inspect a mind-map node"],
    ["/timeline [runId]", "show the latest or selected run timeline"],
  ]],
  ["Shell", [
    ["/clear-screen", "redraw the TUI"],
    ["exit", "quit"],
  ]],
];

const TUI_ADVANCED_HELP_SECTIONS: TuiHelpSection[] = [
  ...TUI_COMMON_HELP_SECTIONS.filter(([section]) => section !== "Shell"),
  ["Runtime", [
    ["/health", "runtime health"],
    ["/doctor [deep|repair]", "aggregated runtime doctor"],
    ["/diagnostics [repair]", "runtime diagnostics"],
    ["/maintenance", "run maintenance"],
    ["/commands", "list command registry entries"],
  ]],
  ["Sessions Advanced", [
    ["/session <id>", "switch session"],
    ["/compact-preview <id> [n]", "preview session compaction"],
    ["/session-usage <id>", "provider usage for a session"],
    ["/restore-session <id>", "restore hidden or trashed session"],
    ["/trash-session <id>", "move session to trash"],
  ]],
  ["Work Advanced", [
    [":add_before <text>", "DAG editor: insert before selected node"],
    [":add_after <text>", "DAG editor: insert after selected node"],
    [":update <text>", "DAG editor: replace selected node instructions"],
    [":del", "DAG editor: delete selected unexecuted node"],
    ["/graph-add <parent> <key> <role> <title>", "add a child node under an unexecuted branch"],
    ["/graph-update <key> <field> <value>", "edit an unexecuted node"],
    ["/trace <taskId>", "show task trace"],
    ["/experiences [query]", "list or search experiences"],
  ]],
  ["Skills And Cron", [
    ["/candidates [status]", "list skill candidates"],
    ["/build-skills", "build skill candidates"],
    ["/approve-skill <id> [reason]", "approve proposed skill"],
    ["/reject-skill <id> [reason]", "reject proposed skill"],
    ["/cron", "list cron jobs"],
    ["/cron-add <name> <cron> <msg>", "schedule a chat cron job"],
    ["/cron-pause <id>", "pause a cron job"],
    ["/cron-resume <id>", "resume a cron job"],
    ["/cron-run <id>", "run a cron job now"],
    ["/cron-delete <id>", "delete a cron job"],
  ]],
  ["Shell", [
    ["/clear-screen", "redraw the TUI"],
    ["exit", "quit"],
  ]],
];

export async function startTui({ runtime }) {
  const rl = readline.createInterface({ input, output });
  const state = {
    sessionId: "tui",
    lastRunId: "",
    permissionMode: "workspace_write",
  };

  await printBanner(runtime, state);

  try {
    const queuedMessages: string[] = [];
    while (true) {
      const raw = queuedMessages.length ? queuedMessages.shift() || "" : await readPromptLine(rl, state);
      if (raw === null) break;
      const message = raw.trim();
      if (!message) continue;
      if (["exit", "quit", ":q", "/q"].includes(message.toLowerCase())) break;

      try {
        if (isCommand(message)) {
          await handleCommand(runtime, state, message, rl);
        } else {
          queuedMessages.push(...await sendChat(runtime, state, message, rl));
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
    const answer = await rl.question(promptFor(state));
    clearSubmittedPromptLine();
    return answer;
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
  if (output.isTTY) output.write("\x1Bc");
  else output.write("\n");
  output.write(formatTuiHome({
    state,
    health,
    provider: currentProvider(runtime),
    tools: safeList(runtime, "listTools"),
    skills: safeList(runtime, "listSkills"),
  }));
}

function printHelp(modeArg?: string): void {
  output.write(formatTuiHelp(parseHelpMode(modeArg)));
}

function promptFor(_state: { sessionId: string; lastRunId: string; permissionMode: string }): string {
  return `${style(TUI_GLYPHS.user, "cyan")} `;
}

function clearSubmittedPromptLine(): void {
  if (!output.isTTY) return;
  output.write("\x1b[1A\r\x1b[2K");
}

function isCommand(message: string): boolean {
  return message.startsWith(":") || message.startsWith("：") || message.startsWith("/");
}

async function handleCommand(runtime, state, message: string, rl?: readline.Interface): Promise<void> {
  const prefix = message[0] === "：" ? ":" : message[0];
  const [command, ...args] = splitArgs(message.replace(/^[:：/]/, ""));
  if (!command) {
    printText(formatTuiCommandHints(prefix));
    return;
  }
  switch (command) {
    case "help":
    case "h":
      printHelp(args[0]);
      return;
    case "health":
      printText(await runtime.runCommand("health", { format: "text" }));
      return;
    case "status":
      await printStatus(runtime, state);
      return;
    case "sub":
    case "subagents":
      await printSubagents(runtime, args);
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
    case "dag":
      await handleDagCommand(runtime, state, args, rl);
      return;
    case "graph":
    case "mindmap":
      await printGraph(runtime, state, args[0]);
      return;
    case "node":
      await printNode(runtime, state, args);
      return;
    case "graph-add":
      await graphAdd(runtime, state, args);
      return;
    case "graph-update":
      await graphUpdate(runtime, state, args);
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
      const hints = formatTuiCommandHints(prefix, command);
      if (hints) printText(hints);
      else printHelp();
  }
}

async function sendChat(runtime, state, message: string, rl?: readline.Interface): Promise<string[]> {
  output.write(formatTuiSubmittedInput(message));
  const thinking = createThinkingIndicator();
  const busyReader = rl ? attachBusyInputReader(runtime, state, rl, thinking) : null;
  const detachModelThinking = attachModelThinkingReporter(runtime, state, thinking);
  const detachProgress = attachProgressReporter(
    runtime,
    state,
    () => {
      busyReader?.clearReadyPrompt();
      thinking.stop();
    },
    () => busyReader?.writeReadyPrompt(),
  );
  const startedAt = Date.now();
  let response;
  let queuedMessages: string[] = [];
  try {
    response = await runtime.handleUserMessage(message, {
      sessionId: state.sessionId,
      source: "tui",
      permissionMode: state.permissionMode,
    });
  } finally {
    thinking.stop();
    detachModelThinking();
    detachProgress();
    queuedMessages = busyReader ? await busyReader.detach() : [];
  }
  if (response.runId) state.lastRunId = response.runId;
  printAssistantMessage(response.content);
  const meta = [];
  if (response.runId) meta.push(`run ${response.runId}`);
  if (response.delegatedTo?.length) meta.push(`agents ${response.delegatedTo.join(", ")}`);
  meta.push(`elapsed ${formatDuration(Date.now() - startedAt)}`);
  printMeta(meta);
  if (response.needsUserInput?.questions?.length) {
    printPanel("Needs Input", response.needsUserInput.questions.map((question) => `- ${question}`).join("\n"), "yellow");
  }
  output.write("\n");
  return queuedMessages;
}

function attachBusyInputReader(
  runtime,
  state,
  rl: readline.Interface,
  thinking: ReturnType<typeof createThinkingIndicator>,
): { detach: () => Promise<string[]>; writeReadyPrompt: () => void; clearReadyPrompt: () => void } {
  let closed = false;
  let promptVisible = false;
  const queuedMessages: string[] = [];
  const pending = new Set<Promise<void>>();
  const writeReadyPrompt = () => {
    if (closed) return;
    output.write(promptFor(state));
    promptVisible = true;
  };
  const clearReadyPrompt = () => {
    if (!promptVisible || !output.isTTY) return;
    output.write("\r\x1b[2K");
    promptVisible = false;
  };
  const onLine = (line: string) => {
    if (closed) return;
    const message = line.trim();
    clearSubmittedPromptLine();
    promptVisible = false;
    if (!message) {
      writeReadyPrompt();
      return;
    }
    if (!isCommand(message)) {
      thinking.stop();
      output.write(formatTuiSubmittedInput(message));
      queuedMessages.push(message);
      output.write(`${style("·", "gray")} queued context ${queuedMessages.length}\n\n`);
      writeReadyPrompt();
      return;
    }
    const task = runBusyCommand(runtime, state, message, thinking)
      .catch((error) => printError(error))
      .finally(() => {
        pending.delete(task);
        writeReadyPrompt();
      });
    pending.add(task);
  };
  rl.on("line", onLine);
  writeReadyPrompt();
  return {
    writeReadyPrompt,
    clearReadyPrompt,
    async detach() {
      closed = true;
      rl.off("line", onLine);
      await Promise.allSettled([...pending]);
      return queuedMessages;
    },
  };
}

async function runBusyCommand(
  runtime,
  state,
  message: string,
  thinking: ReturnType<typeof createThinkingIndicator>,
): Promise<void> {
  thinking.stop();
  if (!isBusySafeCommand(message)) {
    printPanel("Busy", `当前 main agent 还在处理上下文。现在支持只读命令，例如 /dag list、/sub、/status、/timeline；普通文本会进入 context queue。`, "yellow");
    return;
  }
  await handleCommand(runtime, state, message);
}

function busyCommandName(message: string): string {
  return (splitArgs(message.replace(/^[:：/]/, ""))[0] || "").toLowerCase();
}

function busyCommandArgs(message: string): string[] {
  return splitArgs(message.replace(/^[:：/]/, "")).slice(1);
}

function isBusySafeCommand(message: string): boolean {
  const command = busyCommandName(message);
  if (!BUSY_SAFE_COMMANDS.has(command)) return false;
  if (command === "dag") {
    const args = busyCommandArgs(message);
    return !args[0] || args[0] === "list";
  }
  return true;
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
    `subagents: ${formatActiveSubagents(runtime.listSubagents?.() || [])}`,
  ];
  printPanel("Status", lines.join("\n"), "cyan");
}

async function printSubagents(runtime, args: string[] = []): Promise<void> {
  printText(await runtime.runCommand("subagents.list", {
    args,
    format: "text",
  }));
}

function formatActiveSubagents(subagents: unknown): string {
  if (!Array.isArray(subagents) || !subagents.length) return "(none running)";
  return subagents.map((item) => {
    const value = item as { agentId?: string; configuredRole?: string; taskTitle?: string; taskId?: string };
    const task = value.taskTitle ? ` ${truncate(value.taskTitle, 32)}` : "";
    const taskId = value.taskId ? `#${String(value.taskId).slice(0, 8)}` : "";
    return `${value.agentId || value.configuredRole || "subagent"}${taskId}${task}`;
  }).join("; ");
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

async function handleDagCommand(runtime, state, args: string[], rl?: readline.Interface): Promise<void> {
  if (!args[0] || args[0] === "list") {
    printText(await runtime.runCommand("dag.list", { args: args.slice(args[0] === "list" ? 1 : 0), format: "text" }));
    return;
  }
  const runId = await resolveDagRunId(runtime, args[0]);
  state.lastRunId = runId;
  if (!output.isTTY || !input.isTTY || !rl) {
    await printGraph(runtime, state, runId);
    return;
  }
  await startDagEditor(runtime, state, runId, rl);
}

async function resolveDagRunId(runtime, rootId: string): Promise<string> {
  try {
    await runtime.runCommand("graph.view", { input: { runId: rootId } });
    return rootId;
  } catch {
    const roots = await runtime.runCommand("dag.list") as Array<{ rootId: string; runId: string; graphId: string; roots?: Array<{ key: string; taskId: string }> }>;
    const match = roots.find((root) => root.rootId === rootId
      || root.runId === rootId
      || root.graphId === rootId
      || root.graphId.startsWith(rootId)
      || root.roots?.some((node) => node.taskId === rootId || node.taskId.startsWith(rootId) || node.key === rootId));
    if (!match) throw new Error(`DAG root not found: ${rootId}`);
    return match.runId;
  }
}

async function startDagEditor(runtime, state, runId: string, rl: readline.Interface): Promise<void> {
  let selectedIndex = 0;
  let selectedKey = "";
  let message = "";
  let map = await loadDagMap(runtime, runId);

  const refresh = async (nextSelectedKey = selectedKey): Promise<void> => {
    map = await loadDagMap(runtime, runId);
    const nodes = flattenDagEditorNodes(map);
    selectedIndex = Math.max(0, nodes.findIndex((node) => node.key === nextSelectedKey));
    if (selectedIndex < 0) selectedIndex = 0;
    selectedKey = nodes[selectedIndex]?.key || "";
    render();
  };
  const render = (): void => {
    const nodes = flattenDagEditorNodes(map);
    if (selectedIndex >= nodes.length) selectedIndex = Math.max(0, nodes.length - 1);
    selectedKey = nodes[selectedIndex]?.key || "";
    output.write("\x1b[2J\x1b[H");
    output.write(formatDagEditorView(map, selectedIndex, message));
  };

  rl.pause();
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  render();

  try {
    while (true) {
      const action = await readDagEditorAction();
      const nodes = flattenDagEditorNodes(map);
      if (action.type === "exit") break;
      if (action.type === "move") {
        selectedIndex = clamp(selectedIndex + action.delta, 0, Math.max(0, nodes.length - 1));
        message = "";
        render();
        continue;
      }
      if (action.type === "inspect") {
        const selected = nodes[selectedIndex];
        message = selected ? selected.input : "";
        render();
        continue;
      }
      if (action.type === "command") {
        const selected = nodes[selectedIndex];
        if (!selected) {
          message = "No node selected.";
          render();
          continue;
        }
        try {
          const commandResult = await runDagEditorCommand(runtime, runId, selected, action.command);
          selectedKey = commandResult.selectedKey || selected.key;
          message = commandResult.message;
          await refresh(selectedKey);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
          render();
        }
      }
    }
  } finally {
    input.setRawMode?.(false);
    input.pause();
    rl.resume();
    output.write("\x1b[2J\x1b[H");
    await printBanner(runtime, state);
  }
}

async function loadDagMap(runtime, runId: string) {
  return await runtime.runCommand("graph.view", { input: { runId } });
}

function readDagEditorAction(): Promise<
  | { type: "move"; delta: number }
  | { type: "command"; command: string }
  | { type: "inspect" }
  | { type: "exit" }
> {
  return new Promise((resolve) => {
    let commandMode = false;
    let buffer = "";
    const cleanup = () => input.off("keypress", onKeypress);
    const finish = (action: Parameters<typeof resolve>[0]) => {
      cleanup();
      resolve(action);
    };
    const renderCommand = () => {
      output.write(`\r\x1b[2K:${buffer}`);
    };
    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (key.ctrl && key.name === "c") return finish({ type: "exit" });
      if (commandMode) {
        if (key.name === "escape") return finish({ type: "inspect" });
        if (key.name === "return" || key.name === "enter") {
          output.write("\r\x1b[2K");
          return finish({ type: "command", command: buffer.trim() });
        }
        if (key.name === "backspace" || key.name === "delete") {
          buffer = buffer.slice(0, -1);
          renderCommand();
          return;
        }
        if (str && !key.ctrl) {
          buffer += str;
          renderCommand();
        }
        return;
      }
      if (key.name === "up") return finish({ type: "move", delta: -1 });
      if (key.name === "down") return finish({ type: "move", delta: 1 });
      if (key.name === "return" || key.name === "enter") return finish({ type: "inspect" });
      if (key.name === "escape" || key.name === "q") return finish({ type: "exit" });
      if (str === ":" || str === "：" || key.sequence === ":") {
        commandMode = true;
        buffer = "";
        renderCommand();
      }
    };
    input.on("keypress", onKeypress);
  });
}

async function runDagEditorCommand(runtime, runId: string, selected, rawCommand: string): Promise<{ selectedKey?: string; message: string }> {
  const [command, ...rest] = splitArgs(rawCommand);
  const text = rest.join(" ").trim();
  if (!command || command === "help") {
    return {
      selectedKey: selected.key,
      message: "Commands: :add_before <text>, :add_after <text>, :update <text>, :del, :q",
    };
  }
  if (command === "q" || command === "quit") {
    return { selectedKey: selected.key, message: "Use Esc or q to leave the DAG editor." };
  }
  if (command === "add_before" || command === "add-before") {
    if (!text) throw new Error("usage: :add_before <description>");
    const result = await runtime.runCommand("graph.add_before", {
      input: dagSiblingCommandInput(runId, selected, text),
    }) as { node?: { key?: string } };
    return { selectedKey: result.node?.key || selected.key, message: `Added before ${selected.key}: ${text}` };
  }
  if (command === "add_after" || command === "add-after") {
    if (!text) throw new Error("usage: :add_after <description>");
    const result = await runtime.runCommand("graph.add_after", {
      input: dagSiblingCommandInput(runId, selected, text),
    }) as { node?: { key?: string } };
    return { selectedKey: result.node?.key || selected.key, message: `Added after ${selected.key}: ${text}` };
  }
  if (command === "update") {
    if (!text) throw new Error("usage: :update <description>");
    await runtime.runCommand("graph.update", {
      input: {
        runId,
        selector: selected.key,
        title: truncate(text, 80),
        input: text,
      },
    });
    return { selectedKey: selected.key, message: `Updated ${selected.key}.` };
  }
  if (command === "del" || command === "delete") {
    const result = await runtime.runCommand("graph.delete", {
      input: { runId, selector: selected.key, reason: "deleted from TUI DAG editor" },
    }) as { deleted?: string[] };
    return { message: `Deleted: ${(result.deleted || []).join(", ") || selected.key}` };
  }
  throw new Error(`Unknown DAG command: ${command}`);
}

function dagSiblingCommandInput(runId: string, selected, text: string): Record<string, unknown> {
  return {
    runId,
    selector: selected.key,
    key: `${selected.key}_${Date.now().toString(36)}`,
    role: selected.role,
    title: truncate(text, 80),
    input: text,
  };
}

export function flattenDagEditorNodes(map): Array<{
  key: string;
  taskId: string;
  depth: number;
  index: number;
  role: string;
  status: string;
  title: string;
  input: string;
  editable: boolean;
}> {
  const byKey = new Map((map.nodes || []).map((node) => [node.key, node]));
  const rows: Array<{ key: string; taskId: string; depth: number; index: number; role: string; status: string; title: string; input: string; editable: boolean }> = [];
  const visit = (key: string, depth: number) => {
    const node = byKey.get(key) as {
      key: string;
      id: string;
      role: string;
      status: string;
      title: string;
      input: string;
      editable?: boolean;
      children?: string[];
    } | undefined;
    if (!node) return;
    rows.push({
      key: node.key,
      taskId: node.id,
      depth,
      index: rows.length + 1,
      role: node.role,
      status: node.status,
      title: node.title,
      input: node.input,
      editable: node.editable === true,
    });
    for (const child of node.children || []) visit(child, depth + 1);
  };
  for (const root of map.roots || []) visit(root, 0);
  return rows;
}

export function formatDagEditorView(map, selectedIndex = 0, message = "", width = terminalWidth()): string {
  const rows = flattenDagEditorNodes(map);
  const lines = [
    `DAG ${map.runId}`,
    `Goal: ${truncate(String(map.goal || ""), Math.max(40, width - 8))}`,
    "Use ↑/↓ to select, Enter to inspect, :add_before/:add_after/:update/:del, q to exit.",
    "",
  ];
  if (!rows.length) {
    lines.push("(empty DAG)");
  }
  for (const row of rows) {
    const selected = row.index - 1 === selectedIndex;
    const marker = selected ? ">" : " ";
    const indentText = "  ".repeat(row.depth);
    const editMark = row.editable ? "*" : " ";
    lines.push(`${marker} ${String(row.index).padStart(2, " ")} ${indentText}${editMark} ${row.key} ${row.role} - ${truncate(row.title, Math.max(24, width - 40 - row.depth * 2))} · ${statusLabel(row.status)}`);
  }
  const selected = rows[selectedIndex];
  lines.push("");
  if (selected) {
    lines.push(`Selected: ${selected.index}. ${selected.key} (${statusLabel(selected.status)}) ${selected.editable ? "可编辑" : "已锁定"}`);
    lines.push(`Task: ${selected.taskId}`);
  }
  if (message) {
    lines.push("", message);
  }
  return `${lines.join("\n")}\n`;
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

async function printGraph(runtime, state, runId?: string): Promise<void> {
  const targetRunId = runId || state.lastRunId;
  if (!targetRunId) throw new Error("run id is required");
  state.lastRunId = targetRunId;
  printText(await runtime.runCommand("graph.view", {
    input: { runId: targetRunId },
    format: "text",
  }));
}

async function printNode(runtime, state, args: string[]): Promise<void> {
  const selector = requiredArg(args[0], "node key or task id");
  const runId = args[1] || state.lastRunId;
  if (!runId) throw new Error("run id is required");
  state.lastRunId = runId;
  printText(await runtime.runCommand("graph.node", {
    input: { runId, selector },
    format: "text",
  }));
}

async function graphAdd(runtime, state, args: string[]): Promise<void> {
  const runId = state.lastRunId;
  if (!runId) throw new Error("run id is required");
  const parent = requiredArg(args[0], "parent key");
  const key = requiredArg(args[1], "new node key");
  const role = requiredArg(args[2], "role");
  const title = args.slice(3).join(" ").trim();
  if (!title) throw new Error("title is required");
  printText(await runtime.runCommand("graph.add", {
    input: {
      runId,
      parent,
      key,
      role,
      title,
      input: title,
    },
    format: "text",
  }));
}

async function graphUpdate(runtime, state, args: string[]): Promise<void> {
  const runId = state.lastRunId;
  if (!runId) throw new Error("run id is required");
  const selector = requiredArg(args[0], "node key or task id");
  const field = requiredArg(args[1], "field");
  const value = args.slice(2).join(" ").trim();
  if (!value) throw new Error("value is required");
  const input: Record<string, unknown> = { runId, selector };
  if (field === "title" || field === "input" || field === "role" || field === "expansionGoal") {
    input[field] = value;
  } else if (field === "dependsOn") {
    input.dependsOn = value.split(",").map((item) => item.trim()).filter(Boolean);
  } else {
    throw new Error("field must be title, input, role, dependsOn, or expansionGoal");
  }
  printText(await runtime.runCommand("graph.update", {
    input,
    format: "text",
  }));
}

async function printTrace(runtime, taskId?: string): Promise<void> {
  if (!taskId) throw new Error("task id is required");
  const trace = await runtime.runCommand("task.trace", {
    input: { taskId },
  });
  output.write(`\nTask Trace ${taskId}\n`);
  printJson(trace);
}

function attachModelThinkingReporter(runtime, state, thinking: ReturnType<typeof createThinkingIndicator>): () => void {
  if (!runtime.addLifecycleHook) return () => undefined;
  const detachBefore = runtime.addLifecycleHook("beforeModelComplete", (event) => {
    const source = String(event.payload?.source || "");
    if (source && source !== `session:${state.sessionId}`) return;
    thinking.start();
  });
  const detachAfter = runtime.addLifecycleHook("afterModelComplete", (event) => {
    const source = String(event.payload?.source || "");
    if (source && source !== `session:${state.sessionId}`) return;
    thinking.stop();
  });
  return () => {
    detachBefore();
    detachAfter();
  };
}

function createThinkingIndicator(): { start: () => void; stop: () => void; isActive: () => boolean } {
  let timer: NodeJS.Timeout | null = null;
  let frame = 0;
  let active = false;
  let lineVisible = false;
  const render = (): void => {
    if (!output.isTTY) return;
    if (!lineVisible) lineVisible = true;
    output.write(`\r\x1b[2K${style(TUI_GLYPHS.assistant, "gray")} ${formatThinkingFrame(frame)}`);
    frame += 1;
  };
  return {
    start() {
      if (active) return;
      active = true;
      frame = 0;
      render();
      timer = setInterval(render, 140);
    },
    stop() {
      if (!active) return;
      active = false;
      if (timer) clearInterval(timer);
      timer = null;
      if (output.isTTY && lineVisible) output.write("\r\x1b[2K");
      lineVisible = false;
    },
    isActive() {
      return active;
    },
  };
}

export function formatThinkingFrame(frame: number): string {
  const text = "thinking...";
  const length = text.length;
  const position = frame % (length * 2);
  const boldUntil = position <= length ? position : length - (position - length);
  return [...text].map((char, index) => (
    index < boldUntil ? style(char, "bold") : style(char, "gray")
  )).join("");
}

function attachProgressReporter(
  runtime,
  state,
  beforePrint: () => void = () => undefined,
  afterPrint: () => void = () => undefined,
): () => void {
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
    if (line) {
      beforePrint();
      output.write(`${style(TUI_GLYPHS.assistant, "gray")} ${style(line, "gray")}\n`);
      afterPrint();
    }
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
    const agentId = task?.assignedAgentId || event?.agentId || "";
    const agent = agentId ? ` · subagent ${agentId}` : "";
    const taskId = task?.id ? ` · task ${String(task.id).slice(0, 8)}` : "";
    const title = task?.title ? ` - ${truncate(task.title, 72)}` : "";
    return `${role}${status}${agent}${taskId}${title}`;
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

function printAssistantMessage(content: string): void {
  output.write(formatTranscriptMessage("assistant", content));
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
  output.write(`${style(`${TUI_GLYPHS.system} ${items.join(" · ")}`, "gray")}\n`);
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

export function formatTuiHelp(mode: TuiHelpMode = "common"): string {
  const sections = mode === "all" ? TUI_ADVANCED_HELP_SECTIONS : TUI_COMMON_HELP_SECTIONS;
  const lines = [
    mode === "all" ? "Commands" : "Common Commands",
    mode === "all" ? "Most commands require an existing session, run id, task id, or cron id." : "Use /help all to show advanced runtime, task, skill, and cron commands.",
  ];
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

export function formatTuiCommandHints(prefix = "/", query = ""): string {
  const normalizedPrefix = prefix === ":" ? ":" : "/";
  const normalizedQuery = query.replace(/^[:/]/, "").trim().toLowerCase();
  const rows = tuiCommandRows(normalizedPrefix, normalizedQuery ? "all" : "common")
    .filter(([command]) => {
      if (!normalizedQuery) return true;
      return commandToken(command).includes(normalizedQuery);
    });
  if (!rows.length) return "";

  const visibleRows = rows.slice(0, normalizedQuery ? 12 : 18);
  const width = Math.max(...visibleRows.map(([command]) => command.length));
  const lines = [
    normalizedQuery ? `Command hints for ${normalizedPrefix}${normalizedQuery}` : "Command hints",
    normalizedQuery ? "Type /help all for every command." : "Type /help all for advanced commands.",
    "",
  ];
  for (const [command, description] of visibleRows) {
    lines.push(`  ${command.padEnd(width)}  ${description}`);
  }
  if (rows.length > visibleRows.length) {
    lines.push(`  ... ${rows.length - visibleRows.length} more`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatTuiHome({
  state = { sessionId: "tui", lastRunId: "", permissionMode: "workspace_write" },
  health = null,
  provider = null,
  tools = [],
  skills = [],
}: {
  state?: { sessionId: string; lastRunId: string; permissionMode: string };
  health?: Record<string, number> | null;
  provider?: { id?: string; model?: string; type?: string } | null;
  tools?: Array<{ name?: string; category?: string }>;
  skills?: Array<{ name?: string; title?: string; capabilities?: string[]; source?: string }>;
} = {}): string {
  const width = Math.max(88, terminalWidth());
  const boxWidth = Math.min(width - 2, 126);
  const leftWidth = 38;
  const rightWidth = Math.max(42, boxWidth - leftWidth - 7);
  const lines: string[] = [];
  lines.push("");
  for (const line of EMILY_WORDMARK) lines.push(style(line, "yellow"));
  lines.push("");
  lines.push(`${"─".repeat(Math.max(2, Math.floor((boxWidth - 36) / 2)))} ${style("Emily AgentOS terminal workspace", "yellow")} ${"─".repeat(12)}`);
  lines.push(`┌${"─".repeat(boxWidth - 2)}┐`);

  const left = [
    ...EMILY_3D_LOGO.map((line) => style(line, "yellow")),
    provider ? `${provider.model || "(model)"}  ·  ${provider.id || "(provider)"}` : "model unavailable",
    `Session: ${state.sessionId}`,
    health ? `Tasks: ${health.pendingTasks}/${health.runningTasks}  Graphs: ${health.openTaskGraphs}` : "Tasks: ?/?  Graphs: ?",
  ];
  const right = [
    style("Available Tools", "yellow"),
    ...formatToolGroups(tools).slice(0, 7),
    "",
    style("Available Skills", "yellow"),
    ...formatSkillGroups(skills).slice(0, 13),
    "",
    `${tools.length} tools · ${skills.length} skills · /help for commands`,
  ];
  const rowCount = Math.max(left.length, right.length, 18);
  for (let index = 0; index < rowCount; index += 1) {
    const leftCell = pad(truncate(left[index] || "", leftWidth), leftWidth);
    const rightCell = pad(truncate(right[index] || "", rightWidth), rightWidth);
    lines.push(`│ ${leftCell} │ ${rightCell} │`);
  }
  lines.push(`└${"─".repeat(boxWidth - 2)}┘`);
  lines.push("");
  lines.push(style("Welcome to Emily Agent! Type your message or /help for commands.", "gray"));
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function formatTuiSubmittedInput(message: string, width = terminalWidth()): string {
  return formatTranscriptMessage("user", message, width);
}

export function formatTranscriptMessage(
  role: "assistant" | "system" | "tool" | "user",
  content: string,
  width = terminalWidth(),
): string {
  const glyph = TUI_GLYPHS[role];
  const color: keyof typeof ANSI = role === "user" ? "cyan" : role === "assistant" ? "gray" : "gray";
  const bodyWidth = Math.max(24, width - visibleLength(glyph) - 2);
  const wrapped = wrapBlock(String(content || "").trim() || "(empty)", bodyWidth);
  const continuation = " ".repeat(visibleLength(glyph));
  const lines = role === "user" ? [""] : [];
  wrapped.forEach((line, index) => {
    const marker = index === 0 ? style(glyph, color) : continuation;
    lines.push(`${marker} ${line}`);
  });
  if (role === "user") lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatToolGroups(tools: Array<{ name?: string; category?: string }>): string[] {
  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const category = tool.category || "tools";
    const names = groups.get(category) || [];
    if (tool.name) names.push(tool.name);
    groups.set(category, names);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, names]) => `${category}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""}`);
}

function formatSkillGroups(skills: Array<{ name?: string; title?: string; capabilities?: string[]; source?: string }>): string[] {
  const groups = new Map<string, string[]>();
  for (const skill of skills) {
    const category = skill.capabilities?.[0] || skill.source || "skills";
    const names = groups.get(category) || [];
    names.push(skill.name || skill.title || "skill");
    groups.set(category, names);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, names]) => `${category}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", ..." : ""}`);
}

function currentProvider(runtime): { id?: string; model?: string; type?: string } | null {
  try {
    const providerId = runtime.providerRegistry?.defaultProviderId;
    if (providerId && runtime.providerRegistry?.getConfigIncludingDisabled) {
      return runtime.providerRegistry.getConfigIncludingDisabled(providerId);
    }
    const providers = runtime.listProviders?.() || [];
    return providers[0] || null;
  } catch {
    return null;
  }
}

function safeList(runtime, method: "listTools" | "listSkills"): unknown[] {
  try {
    const value = runtime[method]?.();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function tuiCommandRows(prefix: string, mode: TuiHelpMode = "common"): string[][] {
  const sections = mode === "all" ? TUI_ADVANCED_HELP_SECTIONS : TUI_COMMON_HELP_SECTIONS;
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const [, sectionRows] of sections) {
    for (const [command, description] of sectionRows) {
      const normalized = normalizeTuiCommand(command, prefix);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      rows.push([normalized, description]);
    }
  }
  return rows;
}

function parseHelpMode(value?: string): TuiHelpMode {
  return value === "all" || value === "--all" ? "all" : "common";
}

function normalizeTuiCommand(command: string, prefix: string): string | null {
  if (!command.startsWith(":") && !command.startsWith("/")) return null;
  return `${prefix}${command.slice(1)}`;
}

function commandToken(command: string): string {
  return command.replace(/^[:/]/, "").split(/[ <[]/)[0].toLowerCase();
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
