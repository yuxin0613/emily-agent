import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function startTui({ runtime }) {
  const rl = readline.createInterface({ input, output });
  const state = {
    sessionId: "tui",
    lastRunId: "",
  };

  printBanner();
  printHelp();

  try {
    while (true) {
      const raw = await rl.question(promptFor(state));
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
        output.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n\n`);
      }
    }
  } finally {
    rl.close();
  }
}

function printBanner(): void {
  output.write("\nEmily AgentOS TUI\n");
  output.write("Runtime, tasks, knowledge, and chat in one console.\n\n");
}

function printHelp(): void {
  output.write([
    "Commands:",
    "  :help                         show commands",
    "  :health                       runtime health",
    "  :doctor [deep|repair]         aggregated runtime doctor",
    "  :providers                    list providers",
    "  :roles                        list roles",
    "  :commands                     list command registry entries",
    "  :cron                         list cron jobs",
    "  :cron-add <name> <cron> <msg>  schedule a chat cron job",
    "  :cron-pause <id>               pause cron job",
    "  :cron-resume <id>              resume cron job",
    "  :cron-run <id>                 run cron job now",
    "  :cron-delete <id>              delete cron job",
    "  :sessions [all|hidden|trash]  list sessions",
    "  :resume latest [hidden]       resume latest session",
    "  :export-session <id> [md]     export session",
    "  :compact-preview <id> [n]     preview session compaction",
    "  :session-usage <id>           provider usage for a session",
    "  :tools                        list tools",
    "  :skills                       list skills",
    "  :candidates [status]          list skill candidates",
    "  :build-skills                 build skill candidates",
    "  :approve-skill <id> [reason]  approve proposed skill",
    "  :reject-skill <id> [reason]   reject proposed skill",
    "  :experiences [query]          list or search experiences",
    "  :timeline [runId]             show run timeline",
    "  :trace <taskId>               show task trace",
    "  :diagnostics [repair]         runtime diagnostics",
    "  :maintenance                  run maintenance",
    "  :session <id>                 set chat session",
    "  :messages                    show current session messages",
    "  :restore-session <id>         restore hidden or trashed session",
    "  :trash-session <id>           move session to trash",
    "  /new                          start a new visible session",
    "  /clear                        hide current session and start a new one",
    "  :clear-screen                 clear screen",
    "  exit                          quit",
    "",
  ].join("\n"));
}

function promptFor(state: { sessionId: string; lastRunId: string }): string {
  const run = state.lastRunId ? ` run:${state.lastRunId.slice(0, 8)}` : "";
  return `[${state.sessionId}${run}] > `;
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
      output.write(`\nSession: ${state.sessionId}\n\n`);
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
      return;
    case "clear-screen":
      output.write("\x1Bc");
      return;
    default:
      output.write(`\nUnknown command: ${command}\n\n`);
      printHelp();
  }
}

async function sendChat(runtime, state, message: string): Promise<void> {
  const response = await runtime.handleUserMessage(message, {
    sessionId: state.sessionId,
    source: "tui",
  });
  if (response.runId) state.lastRunId = response.runId;
  output.write(`\n${response.content}\n`);
  if (response.delegatedTo?.length) {
    output.write(`\nDelegated: ${response.delegatedTo.join(", ")}\n`);
  }
  if (response.runId) {
    output.write(`Run: ${response.runId}\n`);
  }
  if (response.needsUserInput?.questions?.length) {
    output.write(`Questions: ${response.needsUserInput.questions.join(" | ")}\n`);
  }
  output.write("\n");
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
  output.write(`\nNew session: ${session.id}\n\n`);
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
    output.write("\nNo session to resume.\n\n");
    return;
  }
  await selectSession(runtime, state, session.id);
  output.write(`\nResumed session: ${session.id}\n\n`);
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
  output.write(`\nHidden session: ${result.hidden?.id || "(none)"}\nNew session: ${result.next.id}\n\n`);
}

async function restoreSession(runtime, state, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("session id is required");
  const session = await runtime.runCommand("session.restore", {
    input: { sessionId: args[0] },
  });
  await selectSession(runtime, state, session.id);
  output.write(`\nRestored session: ${session.id}\n\n`);
}

async function trashSession(runtime, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("session id is required");
  const session = await runtime.runCommand("session.trash", {
    input: {
      sessionId: args[0],
      reason: "trashed from TUI",
    },
  });
  output.write(`\nTrashed session: ${session.id}\nDelete after: ${session.deleteAfter || "(not scheduled)"}\n\n`);
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

function printJson(value): void {
  output.write(`\n${JSON.stringify(value, null, 2)}\n\n`);
}

function printText(value): void {
  output.write(`\n${String(value)}\n\n`);
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
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function visibleLength(value: string): number {
  return value.length;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}
