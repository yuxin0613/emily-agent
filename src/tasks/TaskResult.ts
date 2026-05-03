import type { TaskResult } from "../types.ts";

export function createTaskResult(input: Partial<TaskResult> & { summary: string }): TaskResult {
  return {
    status: input.status || "success",
    summary: input.summary,
    artifacts: input.artifacts || [],
    memoryCandidates: input.memoryCandidates || [],
    nextActions: input.nextActions || [],
  };
}

export function serializeTaskResult(result: TaskResult): string {
  return JSON.stringify(result, null, 2);
}

export function parseTaskResult(raw: string | null): TaskResult | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TaskResult>;
    if (!value || typeof value.summary !== "string") return null;
    return {
      status: isTaskResultStatus(value.status) ? value.status : "success",
      summary: value.summary,
      artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
      memoryCandidates: Array.isArray(value.memoryCandidates) ? value.memoryCandidates.filter((item) => item && typeof item.content === "string") : [],
      nextActions: Array.isArray(value.nextActions) ? value.nextActions.map(String) : [],
    };
  } catch {
    return null;
  }
}

export function taskResultSummary(raw: string | null, fallback = "(no result)"): string {
  const parsed = parseTaskResult(raw);
  return parsed?.summary || raw || fallback;
}

function isTaskResultStatus(value: unknown): value is TaskResult["status"] {
  return value === "success" || value === "failed" || value === "needs_user_input" || value === "cancelled";
}
