import type { ProviderUsageSummary } from "../llm/ProviderUsageStore.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";

export interface SessionExportJson {
  session: unknown;
  runs: unknown[];
  messages: unknown[];
  timelines: unknown[];
}

export interface SessionCompactionPreview {
  sessionId: string;
  messageCount: number;
  keptMessages: number;
  archivedMessages: number;
  estimatedCharsBefore: number;
  estimatedCharsAfter: number;
  preview: string;
}

export function resumeLatestSession({
  taskStore,
  includeHidden = false,
}: {
  taskStore: TaskStore;
  includeHidden?: boolean;
}): unknown | null {
  return taskStore.listSessions({
    includeHidden,
    limit: 1,
  })[0] || null;
}

export function exportSession({
  taskStore,
  sessionId,
  format = "json",
}: {
  taskStore: TaskStore;
  sessionId: string;
  format?: "json" | "markdown";
}): SessionExportJson | string {
  const session = taskStore.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const runs = taskStore.getRunsForSession(sessionId, { limit: 200 });
  const messages = taskStore.listSessionMessages({ sessionId, limit: 1000 });
  const timelines = runs.map((run) => taskStore.getTimeline({ runId: run.id }));
  const json = { session, runs, messages, timelines };
  return format === "markdown" ? renderSessionMarkdown(json) : json;
}

export function previewSessionCompaction({
  taskStore,
  sessionId,
  maxMessages = 20,
}: {
  taskStore: TaskStore;
  sessionId: string;
  maxMessages?: number;
}): SessionCompactionPreview {
  const session = taskStore.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const messages = taskStore.listSessionMessages({ sessionId, limit: 1000 });
  const kept = messages.slice(-Math.max(1, maxMessages));
  const archived = messages.slice(0, Math.max(0, messages.length - kept.length));
  const preview = [
    `Session: ${session.title}`,
    `Messages: ${messages.length}`,
    `Keep latest: ${kept.length}`,
    "",
    "Archive summary preview:",
    ...archived.slice(-8).map((message) => `- ${message.role}: ${truncate(message.content, 140)}`),
  ].join("\n");
  return {
    sessionId,
    messageCount: messages.length,
    keptMessages: kept.length,
    archivedMessages: archived.length,
    estimatedCharsBefore: messages.reduce((sum, message) => sum + message.content.length, 0),
    estimatedCharsAfter: kept.reduce((sum, message) => sum + message.content.length, 0) + preview.length,
    preview,
  };
}

export function sessionUsage({
  taskStore,
  providerUsage,
  sessionId,
}: {
  taskStore: TaskStore;
  providerUsage: (runIds: string[]) => ProviderUsageSummary;
  sessionId: string;
}): {
  session: unknown;
  runCount: number;
  taskCount: number;
  usage: ProviderUsageSummary;
} {
  const session = taskStore.getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const runs = taskStore.getRunsForSession(sessionId, { limit: 500 });
  const runIds = runs.map((run) => run.id);
  return {
    session,
    runCount: runs.length,
    taskCount: runIds.reduce((sum, runId) => sum + taskStore.getTasksForRun(runId).length, 0),
    usage: providerUsage(runIds),
  };
}

function renderSessionMarkdown(input: SessionExportJson): string {
  const session = input.session as { id?: string; title?: string; status?: string; createdAt?: string; updatedAt?: string };
  const runs = input.runs as Array<{ id: string; status: string; userInput: string; startedAt: string }>;
  const messages = input.messages as Array<{ role: string; content: string; createdAt: string }>;
  return [
    `# Session: ${session.title || session.id}`,
    "",
    `- ID: ${session.id}`,
    `- Status: ${session.status}`,
    `- Created: ${session.createdAt}`,
    `- Updated: ${session.updatedAt}`,
    "",
    "## Runs",
    ...(runs.length ? runs.map((run) => `- ${run.id} ${run.status}: ${truncate(run.userInput, 120)}`) : ["- (none)"]),
    "",
    "## Messages",
    ...(messages.length ? messages.map((message) => `### ${message.role} ${message.createdAt}\n\n${message.content}`) : ["(none)"]),
    "",
  ].join("\n");
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
