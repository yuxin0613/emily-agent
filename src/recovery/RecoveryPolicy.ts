import type { Task } from "../types.ts";

export type RecoveryDecision =
  | { action: "finish"; reason: string }
  | { action: "inspect"; reason: string }
  | { action: "retry"; reason: string }
  | { action: "dead_letter"; reason: string };

export class RecoveryPolicy {
  decideWorkerExit(task: Task, reason: string): RecoveryDecision {
    if (task.result && task.result.trim().length > 0) {
      return { action: "finish", reason: `${reason}; task already has result` };
    }

    if (task.metadata.retryable === true && task.retryCount < task.maxRetries) {
      return { action: "retry", reason };
    }

    if (task.retryCount >= task.maxRetries && task.maxRetries === 0) {
      return { action: "dead_letter", reason };
    }

    return { action: "inspect", reason };
  }
}
