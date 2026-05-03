import type { ExperienceCandidate, Task } from "../types.ts";
import type { ExperienceStore } from "./ExperienceStore.ts";
import type { TaskStore } from "../tasks/TaskStore.ts";
import { makeTopicKey } from "./ExperienceMatcher.ts";

interface BuildResult {
  candidates: ExperienceCandidate[];
  updates: Array<{
    action: string;
    topicKey: string;
    experienceId: string;
    revision: number;
  }>;
}

export class ExperienceBuilder {
  taskStore: TaskStore;
  experienceStore: ExperienceStore;
  dailyLimit: number;

  constructor({
    taskStore,
    experienceStore,
    dailyLimit = 3,
  }: {
    taskStore: TaskStore;
    experienceStore: ExperienceStore;
    dailyLimit?: number;
  }) {
    this.taskStore = taskStore;
    this.experienceStore = experienceStore;
    this.dailyLimit = dailyLimit;
  }

  buildDailyExperiences({
    day = new Date(),
  }: {
    day?: Date;
  } = {}): BuildResult {
    const { start, end } = dayRange(day);
    const tasks = this.taskStore.getTerminalTasksBetween({
      start,
      end,
      limit: 200,
    });

    const candidates = this.selectHighValueCandidates(tasks).slice(0, this.dailyLimit);
    const updates = candidates.map((candidate) => {
      const result = this.experienceStore.upsertExperience(candidate);
      return {
        action: result.action,
        topicKey: result.experience.topicKey,
        experienceId: result.experience.id,
        revision: result.experience.revision,
      };
    });

    return { candidates, updates };
  }

  selectHighValueCandidates(tasks: Task[]): ExperienceCandidate[] {
    return tasks
      .map((task) => this.taskToCandidate(task))
      .filter((candidate): candidate is ExperienceCandidate => Boolean(candidate))
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  }

  private taskToCandidate(task: Task): ExperienceCandidate | null {
    const text = [task.title, task.input, task.result, task.error].filter(Boolean).join("\n");
    const value = estimateValue(task, text);
    if (value.importance < 0.58) return null;

    if (task.status === "failed" || task.status === "dead_letter") {
      const candidate: ExperienceCandidate = {
        scope: "project",
        type: "failure",
        topicKey: "",
        title: `Failure pattern: ${task.title}`,
        summary: compact(task.error || task.result || task.input, 240),
        problemPattern: compact(task.input, 220),
        solutionPattern: task.result
          ? compact(task.result, 260)
          : "No reliable solution was produced; prefer inspection, smaller task slices, and explicit recovery checks.",
        applicability: "Use when a similar task fails or reaches dead-letter and the team needs a reusable recovery lesson.",
        contraindications: ["Do not use as a success pattern without checking the failure context."],
        evidenceTaskIds: [task.id],
        evidenceEventIds: [],
        confidence: value.confidence,
        importance: value.importance,
        changeReason: "Daily curator found a high-value failure or dead-letter task.",
      };
      return {
        ...candidate,
        topicKey: makeTopicKey(candidate),
      };
    }

    const candidate: ExperienceCandidate = {
      scope: "project",
      type: classifyExperienceType(text),
      topicKey: "",
      title: `Best practice: ${task.title}`,
      summary: compact(task.result || task.input, 260),
      problemPattern: compact(task.input, 220),
      solutionPattern: compact(task.result || "Repeat the successful approach captured by this task.", 320),
      applicability: "Use when the current request has the same problem shape, constraints, and runtime context.",
      contraindications: ["Avoid applying when the new task has different safety, storage, or deployment constraints."],
      evidenceTaskIds: [task.id],
      evidenceEventIds: [],
      confidence: value.confidence,
      importance: value.importance,
      changeReason: "Daily curator promoted useful task output into reusable experience.",
    };
    return {
      ...candidate,
      topicKey: makeTopicKey(candidate),
    };
  }
}

function dayRange(day: Date): { start: string; end: string } {
  const startDate = new Date(day);
  startDate.setUTCHours(0, 0, 0, 0);
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  return {
    start: startDate.toISOString(),
    end: endDate.toISOString(),
  };
}

function estimateValue(task: Task, text: string): { importance: number; confidence: number } {
  const hasResult = Boolean(task.result && task.result.length > 80);
  const hasFailure = task.status === "failed" || task.status === "dead_letter";
  const strongKeywords = /(架构|恢复|失败|bug|权限|memory|记忆|经验|sqlite|ipc|agent|最佳实践|决定|约定|实现|测试)/i.test(text);
  const importance = Math.min(0.95, 0.35 + (hasResult ? 0.22 : 0) + (hasFailure ? 0.25 : 0) + (strongKeywords ? 0.25 : 0));
  const confidence = Math.min(0.92, 0.55 + (task.status === "done" ? 0.25 : 0) + (hasResult ? 0.1 : 0));
  return { importance, confidence };
}

function classifyExperienceType(text: string): ExperienceCandidate["type"] {
  if (/(偏好|喜欢|希望|我同意)/.test(text)) return "preference";
  if (/(决定|采用|约定|限制)/.test(text)) return "decision";
  if (/(步骤|流程|workflow|procedure)/i.test(text)) return "procedure";
  return "solution";
}

function compact(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function scoreCandidate(candidate: ExperienceCandidate): number {
  return candidate.importance * 0.7 + candidate.confidence * 0.3;
}
