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
      printHealth(await runtime.runCommand("health"));
      return;
    case "doctor":
      printJson(await runtime.runCommand("doctor", { args }));
      return;
    case "providers":
      printProviders(await runtime.runCommand("providers"));
      return;
    case "roles":
      printRoles(await runtime.runCommand("roles"));
      return;
    case "commands":
      printCommands(runtime.listCommands());
      return;
    case "sessions":
      printSessions(await runtime.runCommand("session.list", { input: sessionListOptions(args[0]) }));
      return;
    case "resume":
      await resumeLatest(runtime, state, args);
      return;
    case "export-session":
      await exportSession(runtime, args);
      return;
    case "compact-preview":
      printJson(await runtime.runCommand("session.compact_preview", {
        input: { sessionId: requiredArg(args[0], "session id"), maxMessages: numberArg(args[1], 20) },
      }));
      return;
    case "session-usage":
      printJson(await runtime.runCommand("session.usage", {
        input: { sessionId: requiredArg(args[0], "session id") },
      }));
      return;
    case "tools":
      printTools(await runtime.runCommand("tools"));
      return;
    case "skills":
      printSkills(await runtime.runCommand("skills"));
      return;
    case "candidates":
      printCandidates(await runtime.runCommand("skills.candidates.list", {
        input: { status: args[0] || undefined, limit: 50 },
      }));
      return;
    case "build-skills":
      printJson(await runtime.runCommand("skills.candidates.build", {
        input: { minOccurrences: numberArg(args[0], 3), minScore: numberArg(args[1], 0.68) },
      }));
      return;
    case "approve-skill":
      await approveSkill(runtime, args);
      return;
    case "reject-skill":
      await rejectSkill(runtime, args);
      return;
    case "experiences":
      printExperiences(await searchExperiences(runtime, args.join(" ")));
      return;
    case "timeline":
      await printTimeline(runtime, state, args[0]);
      return;
    case "trace":
      await printTrace(runtime, args[0]);
      return;
    case "diagnostics":
      printJson(args[0] === "repair" || args[0] === "true"
        ? await runtime.runCommand("diagnostics.repair")
        : await runtime.runCommand("diagnostics.run"));
      return;
    case "maintenance":
      printJson(await runtime.runCommand("maintenance.run"));
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
      selectSession(runtime, state, args[0]);
      output.write(`\nSession: ${state.sessionId}\n\n`);
      return;
    case "messages":
      printSessionMessages(await runtime.runCommand("session.messages", {
        input: { sessionId: state.sessionId, limit: numberArg(args[0], 40) },
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

function printHealth(health): void {
  output.write("\nRuntime Health\n");
  printTable([
    ["Metric", "Value"],
    ...Object.entries(health).map(([key, value]) => [key, formatValue(value)]),
  ]);
  output.write("\n");
}

function printProviders(providers): void {
  output.write("\nProviders\n");
  printTable([
    ["ID", "Type", "Model", "Enabled"],
    ...providers.map((provider) => [provider.id, provider.type, provider.model || "", provider.enabled === false ? "false" : "true"]),
  ]);
  output.write("\n");
}

function printRoles(roles): void {
  output.write("\nRoles\n");
  printTable([
    ["Name", "Provider", "Model", "Tools", "Skills"],
    ...roles.map((role) => [role.name, role.provider || "", role.model || "", (role.allowedTools || []).join(","), (role.skills || []).join(",")]),
  ]);
  output.write("\n");
}

function printSessions(sessions): void {
  output.write("\nSessions\n");
  printTable([
    ["ID", "Title", "Status", "Runs", "Last Active", "Delete After"],
    ...sessions.map((session) => [
      session.id.slice(0, 12),
      truncate(session.title || session.id, 34),
      session.status,
      String(session.runCount || 0),
      session.lastActiveAt || session.updatedAt || "",
      session.deleteAfter || "",
    ]),
  ]);
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

function printSessionMessages(messages): void {
  output.write("\nMessages\n");
  for (const message of messages) {
    const who = message.role === "user" ? "You" : "Emily";
    const run = message.runId ? ` ${message.runId.slice(0, 8)}` : "";
    output.write(`\n[${who}${run}] ${message.content}\n`);
  }
  if (!messages.length) output.write("\n(no messages)\n");
  output.write("\n");
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

function printTools(tools): void {
  output.write("\nTools\n");
  printTable([
    ["Name", "Category", "Side Effects", "Approval", "Description"],
    ...tools.map((tool) => [tool.name, tool.category, tool.sideEffects, tool.requiresApproval ? "yes" : "no", truncate(tool.description, 52)]),
  ]);
  output.write("\n");
}

function printSkills(skills): void {
  output.write("\nSkills\n");
  printTable([
    ["Name", "Source", "Tools", "Description"],
    ...skills.map((skill) => [skill.name, skill.source, (skill.toolHints || []).join(","), truncate(skill.description, 60)]),
  ]);
  output.write("\n");
}

function printCandidates(candidates): void {
  output.write("\nSkill Candidates\n");
  printTable([
    ["ID", "Name", "Status", "Type", "Score", "Freq"],
    ...candidates.map((candidate) => [
      candidate.id.slice(0, 8),
      candidate.name,
      candidate.status,
      candidate.proposalType,
      Number(candidate.score || 0).toFixed(3),
      String(candidate.frequency || 0),
    ]),
  ]);
  output.write("\n");
}

async function approveSkill(runtime, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("candidate id is required");
  const reason = args.slice(1).join(" ") || "approved from TUI";
  printJson(await runtime.runCommand("skills.candidates.approve", {
    input: { candidateId: args[0], reason },
  }));
}

async function rejectSkill(runtime, args: string[]): Promise<void> {
  if (!args[0]) throw new Error("candidate id is required");
  const reason = args.slice(1).join(" ") || "rejected from TUI";
  printJson(await runtime.runCommand("skills.candidates.reject", {
    input: { candidateId: args[0], reason },
  }));
}

async function searchExperiences(runtime, query: string): Promise<unknown[]> {
  return await runtime.runCommand("experiences.recall", {
    input: { q: query.trim() || undefined, limit: 8 },
  });
}

function printExperiences(experiences): void {
  output.write("\nExperiences\n");
  printTable([
    ["Topic", "Type", "Score", "Summary"],
    ...experiences.map((experience) => [
      experience.topicKey || experience.id,
      experience.type || "",
      experience.score === undefined ? "" : Number(experience.score).toFixed(3),
      truncate(experience.summary || experience.problemPattern || "", 72),
    ]),
  ]);
  output.write("\n");
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

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "object" && value) return JSON.stringify(value);
  return String(value);
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
