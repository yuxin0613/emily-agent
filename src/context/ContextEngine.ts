import type { ExperienceRecallResult, MemoryRecallResult, MemoryRecord, Metadata, SessionMessage, Task, TaskEvent } from "../types.ts";
import type { ExperienceStore } from "../experience/ExperienceStore.ts";
import type { MemorySystem } from "../memory/MemorySystem.ts";
import type { LifecycleHooks } from "../runtime/LifecycleHooks.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";

export type ContextMode = "active" | "deep";

export interface ContextBundle {
  query: string;
  sessionId: string;
  runId: string | null;
  role: string;
  mode: ContextMode;
  tokenBudget: number;
  memory: MemoryRecallResult;
  experiences: ExperienceRecallResult[];
  sessionMessages: SessionMessage[];
  graph: {
    tasks: Task[];
    events: TaskEvent[];
  };
  budget: {
    memoryRecords: number;
    experienceRecords: number;
    sessionMessages: number;
    graphTasks: number;
    graphEvents: number;
    estimatedChars: number;
  };
  sections: string[];
  metadata: Metadata;
}

export class ContextEngine {
  memory: MemorySystem;
  taskStore: TaskStore;
  experienceStore: ExperienceStore;
  hooks: LifecycleHooks | null;

  constructor({
    memory,
    taskStore,
    experienceStore,
    hooks = null,
  }: {
    memory: MemorySystem;
    taskStore: TaskStore;
    experienceStore: ExperienceStore;
    hooks?: LifecycleHooks | null;
  }) {
    this.memory = memory;
    this.taskStore = taskStore;
    this.experienceStore = experienceStore;
    this.hooks = hooks;
  }

  async build({
    query,
    sessionId = "default",
    runId = null,
    role = "main",
    mode = "active",
    tokenBudget = 12000,
    memoryLimit = 5,
    experienceLimit = 3,
    sessionMessageLimit = 12,
    graphEventLimit = 40,
  }: {
    query: string;
    sessionId?: string;
    runId?: string | null;
    role?: string;
    mode?: ContextMode;
    tokenBudget?: number;
    memoryLimit?: number;
    experienceLimit?: number;
    sessionMessageLimit?: number;
    graphEventLimit?: number;
  }): Promise<ContextBundle> {
    await this.hooks?.emit("beforeContextBuild", {
      payload: { query, sessionId, runId: runId || "", role, mode, tokenBudget },
    });

    const fullMemory = mode === "active" ? await this.memory.recallActive(query, {
      scope: sessionId,
      limit: memoryLimit,
    }) : await this.memory.recall(query, {
      scope: sessionId,
      limit: memoryLimit,
    });
    const memory = fullMemory;
    const sessionMessages = mode === "deep"
      ? searchMessages(this.taskStore.listSessionMessages({ sessionId, limit: Math.max(sessionMessageLimit, 100) }), query)
        .slice(0, sessionMessageLimit)
      : this.taskStore.listSessionMessages({ sessionId, limit: Math.min(sessionMessageLimit, 8) });
    const experiences = this.experienceStore.recall(query, {
      scope: "project",
      limit: experienceLimit,
    });
    const graph = runId ? this.taskStore.getTimeline({ runId }) : { tasks: [], events: [] };
    const graphEvents = graph.events.slice(-graphEventLimit);
    const bundle: ContextBundle = {
      query,
      sessionId,
      runId,
      role,
      mode,
      tokenBudget,
      memory,
      experiences,
      sessionMessages,
      graph: {
        tasks: graph.tasks,
        events: graphEvents,
      },
      budget: {
        memoryRecords: memory.shortTerm.length + memory.files.length + memory.semantic.length,
        experienceRecords: experiences.length,
        sessionMessages: sessionMessages.length,
        graphTasks: graph.tasks.length,
        graphEvents: graphEvents.length,
        estimatedChars: estimateChars({ memory, experiences, sessionMessages, tasks: graph.tasks, events: graphEvents }),
      },
      sections: buildSections({
        memory,
        experiences,
        sessionMessages,
        tasks: graph.tasks,
        events: graphEvents,
        mode,
      }),
      metadata: {
        shortMemoryAlwaysOn: true,
        longMemoryOnDemand: mode === "deep",
        graphIncluded: Boolean(runId),
      },
    };

    this.taskStore.addEvent({
      type: "context.built",
      payload: {
        sessionId,
        runId: runId || "",
        role,
        mode,
        memoryRecords: bundle.budget.memoryRecords,
        experienceRecords: bundle.budget.experienceRecords,
        sessionMessages: bundle.budget.sessionMessages,
        estimatedChars: bundle.budget.estimatedChars,
      },
    });
    await this.hooks?.emit("afterContextBuild", {
      payload: {
        sessionId,
        runId: runId || "",
        role,
        mode,
        estimatedChars: bundle.budget.estimatedChars,
      },
    });
    return bundle;
  }
}

function buildSections({
  memory,
  experiences,
  sessionMessages,
  tasks,
  events,
  mode,
}: {
  memory: MemoryRecallResult;
  experiences: ExperienceRecallResult[];
  sessionMessages: SessionMessage[];
  tasks: Task[];
  events: TaskEvent[];
  mode: ContextMode;
}): string[] {
  return [
    "# Context",
    `Mode: ${mode}`,
    "",
    "## Always-On Memory",
    ...formatMemoryRecords("short", memory.shortTerm),
    ...formatMemoryRecords("semantic", memory.semantic),
    "",
    "## On-Demand Session Memory",
    ...(memory.files.length ? formatMemoryRecords("file", memory.files) : ["- (not requested)"]),
    "",
    "## Experiences",
    ...(experiences.length ? experiences.map((item) => `- ${item.topicKey} r${item.revision}: ${item.summary}`) : ["- (none)"]),
    "",
    "## Session Messages",
    ...(sessionMessages.length ? sessionMessages.map((message) => `- ${message.role}: ${truncate(message.content, 240)}`) : ["- (none)"]),
    "",
    "## Graph State",
    ...(tasks.length ? tasks.map((task) => `- ${task.status} ${task.role} ${task.title}`) : ["- (none)"]),
    ...(events.length ? events.slice(-10).map((event) => `- event#${event.id} ${event.type}`) : []),
  ];
}

function formatMemoryRecords(prefix: string, records: Array<MemoryRecord & { score: number }>): string[] {
  return records.length
    ? records.map((record) => `- [${prefix}:${record.score.toFixed(3)}] ${truncate(record.content, 260)}`)
    : [`- [${prefix}] (none)`];
}

function estimateChars({
  memory,
  experiences,
  sessionMessages,
  tasks,
  events,
}: {
  memory: MemoryRecallResult;
  experiences: ExperienceRecallResult[];
  sessionMessages: SessionMessage[];
  tasks: Task[];
  events: TaskEvent[];
}): number {
  return [
    ...memory.shortTerm,
    ...memory.files,
    ...memory.semantic,
    ...experiences,
    ...sessionMessages,
    ...tasks,
    ...events,
  ].reduce((sum, item) => sum + JSON.stringify(item).length, 0);
}

function searchMessages(messages: SessionMessage[], query: string): SessionMessage[] {
  const tokens = tokenize(query);
  return messages
    .map((message) => ({ message, score: lexicalScore(tokens, tokenize(message.content)) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.message);
}

function lexicalScore(queryTokens: string[], recordTokens: string[]): number {
  if (!queryTokens.length || !recordTokens.length) return 0;
  const recordSet = new Set(recordTokens);
  return queryTokens.filter((token) => recordSet.has(token)).length / queryTokens.length;
}

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}
