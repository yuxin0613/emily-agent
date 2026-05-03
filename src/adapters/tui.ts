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
    "  :providers                    list providers",
    "  :roles                        list roles",
    "  :sessions [all|hidden|trash]  list sessions",
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
      printHealth(runtime.health());
      return;
    case "providers":
      printProviders(runtime.listProviders());
      return;
    case "roles":
      printRoles(await runtime.listRoles());
      return;
    case "sessions":
      printSessions(runtime.listSessions(sessionListOptions(args[0])));
      return;
    case "tools":
      printTools(runtime.listTools());
      return;
    case "skills":
      printSkills(runtime.listSkills());
      return;
    case "candidates":
      printCandidates(runtime.listSkillCandidates({ status: parseStatus(args[0]), limit: 50 }));
      return;
    case "build-skills":
      printJson(runtime.buildSkillCandidates({ minOccurrences: numberArg(args[0], 3), minScore: numberArg(args[1], 0.68) }));
      return;
    case "approve-skill":
      await approveSkill(runtime, args);
      return;
    case "reject-skill":
      rejectSkill(runtime, args);
      return;
    case "experiences":
      printExperiences(searchExperiences(runtime, args.join(" ")));
      return;
    case "timeline":
      await printTimeline(runtime, state, args[0]);
      return;
    case "trace":
      printTrace(runtime, args[0]);
      return;
    case "diagnostics":
      printJson(runtime.diagnostics({ repair: args[0] === "repair" || args[0] === "true" }));
      return;
    case "maintenance":
      printJson(await runtime.maintenance());
      return;
    case "new":
      startNewSession(runtime, state, args);
      return;
    case "restore-session":
      restoreSession(runtime, state, args);
      return;
    case "trash-session":
      trashSession(runtime, args);
      return;
    case "session":
      if (!args[0]) throw new Error("session id is required");
      selectSession(runtime, state, args[0]);
      output.write(`\nSession: ${state.sessionId}\n\n`);
      return;
    case "messages":
      printSessionMessages(runtime.listSessionMessages({ sessionId: state.sessionId, limit: numberArg(args[0], 40) }));
      return;
    case "clear":
      if (prefix === "/") {
        clearCurrentSession(runtime, state);
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

function startNewSession(runtime, state, args: string[] = []): void {
  const session = runtime.createSession({
    title: args.join(" ") || "New session",
    source: "tui",
    metadata: { createdBy: "tui" },
  });
  state.sessionId = session.id;
  state.lastRunId = "";
  output.write(`\nNew session: ${session.id}\n\n`);
}

function selectSession(runtime, state, sessionId: string): void {
  state.sessionId = sessionId;
  const messages = runtime.listSessionMessages({ sessionId, limit: 40 });
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

function clearCurrentSession(runtime, state): void {
  const result = runtime.clearSession(state.sessionId, {
    source: "tui",
    reason: "cleared from TUI",
    nextTitle: "New session",
  });
  state.sessionId = result.next.id;
  state.lastRunId = "";
  output.write(`\nHidden session: ${result.hidden?.id || "(none)"}\nNew session: ${result.next.id}\n\n`);
}

function restoreSession(runtime, state, args: string[]): void {
  if (!args[0]) throw new Error("session id is required");
  const session = runtime.restoreSession(args[0]);
  state.sessionId = session.id;
  output.write(`\nRestored session: ${session.id}\n\n`);
}

function trashSession(runtime, args: string[]): void {
  if (!args[0]) throw new Error("session id is required");
  const session = runtime.trashSession(args[0], {
    reason: "trashed from TUI",
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
  printJson(await runtime.approveSkillCandidate(args[0], { reason }));
}

function rejectSkill(runtime, args: string[]): void {
  if (!args[0]) throw new Error("candidate id is required");
  const reason = args.slice(1).join(" ") || "rejected from TUI";
  printJson(runtime.rejectSkillCandidate(args[0], reason));
}

function searchExperiences(runtime, query: string): unknown[] {
  if (query.trim()) {
    return runtime.experienceStore.recall(query, { scope: "project", limit: 8 });
  }
  return runtime.experienceStore.listActive();
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
  const timeline = runtime.getTimeline({ runId: targetRunId });
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

function printTrace(runtime, taskId?: string): void {
  if (!taskId) throw new Error("task id is required");
  const trace = runtime.getTaskTrace(taskId);
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

function parseStatus(value?: string): "proposed" | "approved" | "merged" | "rejected" | undefined {
  if (!value) return "proposed";
  if (value === "proposed" || value === "approved" || value === "merged" || value === "rejected") return value;
  throw new Error(`invalid candidate status: ${value}`);
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
