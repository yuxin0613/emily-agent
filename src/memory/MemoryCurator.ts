import type { MemoryRecord } from "../types.ts";

const LONG_TERM_KINDS = new Set([
  "memory:curated",
  "decision",
  "user_preference",
  "project_fact",
  "subagent:result",
]);

export class MemoryCurator {
  shouldStoreLongTerm(record: MemoryRecord): boolean {
    if (LONG_TERM_KINDS.has(record.kind)) return true;
    if (record.content.length > 80) return true;
    return /(架构|偏好|决定|约定|设计|实现|bug|api|node|agent)/i.test(record.content);
  }

  curate(record: MemoryRecord): MemoryRecord {
    if (record.kind !== "message:user") return record;

    return {
      ...record,
      kind: this.detectKind(record.content),
      metadata: {
        ...record.metadata,
        curatedFrom: record.kind,
        confidence: 0.72,
      },
    };
  }

  private detectKind(content: string): string {
    if (/(喜欢|偏好|希望|我想|我同意)/.test(content)) return "user_preference";
    if (/(决定|采用|约定|限制)/.test(content)) return "decision";
    return "project_fact";
  }
}
