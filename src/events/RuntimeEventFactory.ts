import type { Metadata, Run, TaskStatus } from "../types.ts";

export const RuntimeEventFactory = {
  runStarted(run: Run): { type: "run.started"; payload: Metadata } {
    return {
      type: "run.started",
      payload: { runId: run.id, sessionId: run.sessionId, source: run.source },
    };
  },

  runCompleted(runId: string, status: Run["status"]): { type: "run.completed"; payload: Metadata } {
    return {
      type: "run.completed",
      payload: { runId, status },
    };
  },

  taskTransition(from: TaskStatus, to: TaskStatus, reason: string | null): Metadata {
    return { from, to, reason };
  },

  memoryCandidate(candidateId: string, runId: string | null, scope: string, kind: string, createdBy?: string): Metadata {
    return { candidateId, runId, scope, kind, createdBy: createdBy || "" };
  },

  candidateLifecycle(candidateId: string, runId: string | null, status: string): Metadata {
    return { candidateId, runId, status };
  },
};
