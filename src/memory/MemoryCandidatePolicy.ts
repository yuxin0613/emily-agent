import type { MemoryCandidate } from "../types.ts";

export type MemoryCandidateDecision = "approved" | "rejected";

export class MemoryCandidatePolicy {
  decide(candidate: MemoryCandidate): MemoryCandidateDecision {
    const content = candidate.content.trim();
    if (content.length < 80) return "rejected";
    if (/EchoModelProvider|当前运行的是本地|下一步可以接入真实模型/.test(content)) return "rejected";
    if (/(偏好|决定|约定|架构|失败|恢复|bug|procedure|workflow|sqlite|ipc|agent|memory|经验)/i.test(content)) {
      return "approved";
    }
    if (candidate.kind === "subagent:result" && content.length > 160) return "approved";
    return "rejected";
  }
}
