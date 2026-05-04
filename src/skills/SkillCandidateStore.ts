import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { SchemaMigrator } from "../storage/SchemaMigrator.ts";
import type { SkillCandidate, SkillCandidateProposal, SkillCandidateStatus } from "../types.ts";
import { parseSkillMarkdown, SkillRegistry } from "./SkillRegistry.ts";

interface SkillCandidateRow {
  id: string;
  status: SkillCandidateStatus;
  proposal_type: SkillCandidate["proposalType"];
  workflow_key: string;
  name: string;
  title: string;
  description: string;
  trigger: string;
  anti_trigger: string;
  tool_hints: string;
  body: string;
  target_skill_name: string | null;
  evidence_task_ids: string;
  evidence_event_ids: string;
  frequency: number;
  success_rate: number;
  workflow_similarity: number;
  verification_quality: number;
  volatility: number;
  overlap_with_existing: number;
  project_specificity: number;
  score: number;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decision_reason: string | null;
}

export class SkillCandidateStore {
  db: DatabaseSync;
  skillDir: string;

  static create({ dataDir, skillDir = path.join(process.cwd(), "skills") }: { dataDir: string; skillDir?: string }): SkillCandidateStore {
    const store = new SkillCandidateStore({
      dbPath: path.join(dataDir, "emily.sqlite"),
      skillDir,
    });
    store.migrate();
    return store;
  }

  constructor({ dbPath, skillDir }: { dbPath: string; skillDir: string }) {
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.skillDir = skillDir;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }

  migrate(): void {
    new SchemaMigrator({ db: this.db, namespace: "skill" }).apply([
      {
        version: 1,
        name: "create_skill_candidate_tables",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS skill_candidates (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              proposal_type TEXT NOT NULL,
              workflow_key TEXT NOT NULL,
              name TEXT NOT NULL,
              title TEXT NOT NULL,
              description TEXT NOT NULL,
              trigger TEXT NOT NULL,
              anti_trigger TEXT NOT NULL,
              tool_hints TEXT NOT NULL,
              body TEXT NOT NULL,
              target_skill_name TEXT,
              evidence_task_ids TEXT NOT NULL,
              evidence_event_ids TEXT NOT NULL,
              frequency INTEGER NOT NULL,
              success_rate REAL NOT NULL,
              workflow_similarity REAL NOT NULL,
              verification_quality REAL NOT NULL,
              volatility REAL NOT NULL,
              overlap_with_existing REAL NOT NULL,
              project_specificity REAL NOT NULL,
              score REAL NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              decided_at TEXT,
              decision_reason TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_skill_candidates_status_score ON skill_candidates(status, score DESC, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_skill_candidates_workflow ON skill_candidates(workflow_key, status);
          `);
        },
      },
    ]);
  }

  proposeCandidate(proposal: SkillCandidateProposal): { action: "create" | "update"; candidate: SkillCandidate } {
    const existing = this.getOpenCandidateByWorkflowKey(proposal.workflowKey);
    const now = new Date().toISOString();
    if (!existing) {
      const candidate = normalizeProposal({
        ...proposal,
        id: randomUUID(),
        status: "proposed",
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
        decisionReason: null,
      });
      this.insertCandidate(candidate);
      return { action: "create", candidate };
    }

    const merged = normalizeProposal({
      ...proposal,
      id: existing.id,
      status: existing.status,
      createdAt: existing.createdAt,
      updatedAt: now,
      decidedAt: existing.decidedAt,
      decisionReason: existing.decisionReason,
      evidenceTaskIds: unique([...existing.evidenceTaskIds, ...proposal.evidenceTaskIds]),
      evidenceEventIds: uniqueNumbers([...existing.evidenceEventIds, ...(proposal.evidenceEventIds || [])]),
    });
    this.updateOpenCandidate(merged);
    return { action: "update", candidate: this.getCandidateOrThrow(existing.id) };
  }

  listCandidates({ status, limit = 50 }: { status?: SkillCandidateStatus; limit?: number } = {}): SkillCandidate[] {
    const rows = status
      ? this.db
        .prepare("SELECT * FROM skill_candidates WHERE status = ? ORDER BY score DESC, updated_at DESC LIMIT ?")
        .all(status, limit) as unknown as SkillCandidateRow[]
      : this.db
        .prepare("SELECT * FROM skill_candidates ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as unknown as SkillCandidateRow[];
    return rows.map(parseCandidate);
  }

  getCandidate(candidateId: string): SkillCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM skill_candidates WHERE id = ?")
      .get(candidateId) as unknown as SkillCandidateRow | undefined;
    return row ? parseCandidate(row) : null;
  }

  getCandidateOrThrow(candidateId: string): SkillCandidate {
    const candidate = this.getCandidate(candidateId);
    if (!candidate) throw new Error(`Skill candidate not found: ${candidateId}`);
    return candidate;
  }

  async approveCandidate(candidateId: string, {
    reason = "approved",
    registry = null,
  }: {
    reason?: string;
    registry?: SkillRegistry | null;
  } = {}): Promise<{ status: "approved" | "merged"; skillPath: string; candidate: SkillCandidate }> {
    const candidate = this.getCandidateOrThrow(candidateId);
    if (candidate.status !== "proposed") {
      throw new Error(`Skill candidate is not proposed: ${candidate.status}`);
    }
    const status = candidate.proposalType === "update" ? "merged" : "approved";
    const skillPath = await this.writeSkill(candidate);
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE skill_candidates SET status = ?, decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .run(status, now, reason, now, candidate.id);
    if (registry) {
      const skillName = candidate.targetSkillName || candidate.name;
      registry.add(parseSkillMarkdown(renderSkillMarkdown({
        ...candidate,
        name: skillName,
      }), skillName));
    }
    return {
      status,
      skillPath,
      candidate: this.getCandidateOrThrow(candidate.id),
    };
  }

  rejectCandidate(candidateId: string, reason = "rejected"): SkillCandidate {
    const candidate = this.getCandidateOrThrow(candidateId);
    if (candidate.status !== "proposed") {
      throw new Error(`Skill candidate is not proposed: ${candidate.status}`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE skill_candidates SET status = 'rejected', decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
      .run(now, reason, now, candidate.id);
    return this.getCandidateOrThrow(candidate.id);
  }

  countByStatus(status: SkillCandidateStatus): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM skill_candidates WHERE status = ?")
      .get(status) as { count: number } | undefined;
    return row?.count || 0;
  }

  close(): void {
    this.db.close();
  }

  private getOpenCandidateByWorkflowKey(workflowKey: string): SkillCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM skill_candidates WHERE workflow_key = ? AND status = 'proposed' ORDER BY score DESC, updated_at DESC LIMIT 1")
      .get(workflowKey) as unknown as SkillCandidateRow | undefined;
    return row ? parseCandidate(row) : null;
  }

  private insertCandidate(candidate: SkillCandidate): void {
    this.db
      .prepare(`
        INSERT INTO skill_candidates (
          id, status, proposal_type, workflow_key, name, title, description, trigger, anti_trigger, tool_hints,
          body, target_skill_name, evidence_task_ids, evidence_event_ids, frequency, success_rate, workflow_similarity,
          verification_quality, volatility, overlap_with_existing, project_specificity, score,
          created_at, updated_at, decided_at, decision_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(...candidateToParams(candidate));
  }

  private updateOpenCandidate(candidate: SkillCandidate): void {
    this.db
      .prepare(`
        UPDATE skill_candidates
        SET proposal_type = ?, name = ?, title = ?, description = ?, trigger = ?, anti_trigger = ?,
            tool_hints = ?, body = ?, target_skill_name = ?, evidence_task_ids = ?, evidence_event_ids = ?,
            frequency = ?, success_rate = ?, workflow_similarity = ?, verification_quality = ?,
            volatility = ?, overlap_with_existing = ?, project_specificity = ?, score = ?, updated_at = ?
        WHERE id = ? AND status = 'proposed'
      `)
      .run(
        candidate.proposalType,
        candidate.name,
        candidate.title,
        candidate.description,
        JSON.stringify(candidate.trigger),
        JSON.stringify(candidate.antiTrigger),
        JSON.stringify(candidate.toolHints),
        candidate.body,
        candidate.targetSkillName,
        JSON.stringify(candidate.evidenceTaskIds),
        JSON.stringify(candidate.evidenceEventIds),
        candidate.frequency,
        candidate.successRate,
        candidate.workflowSimilarity,
        candidate.verificationQuality,
        candidate.volatility,
        candidate.overlapWithExisting,
        candidate.projectSpecificity,
        candidate.score,
        candidate.updatedAt,
        candidate.id,
      );
  }

  private async writeSkill(candidate: SkillCandidate): Promise<string> {
    const skillName = candidate.targetSkillName || candidate.name;
    const targetDir = path.join(this.skillDir, skillName);
    await mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, "skill.md");
    await writeFile(filePath, renderSkillMarkdown({
      ...candidate,
      name: skillName,
    }), "utf8");
    return filePath;
  }
}

function normalizeProposal(input: SkillCandidateProposal & {
  id: string;
  status: SkillCandidateStatus;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
}): SkillCandidate {
  return {
    id: input.id,
    status: input.status,
    proposalType: input.proposalType,
    workflowKey: input.workflowKey,
    name: normalizeSkillName(input.name),
    title: input.title.trim() || titleCase(input.name),
    description: input.description.trim(),
    trigger: unique(input.trigger.map(String).map((item) => item.trim()).filter(Boolean)).slice(0, 8),
    antiTrigger: unique(input.antiTrigger.map(String).map((item) => item.trim()).filter(Boolean)).slice(0, 8),
    toolHints: unique(input.toolHints.map((tool) => tool.trim()).filter(Boolean)) as SkillCandidate["toolHints"],
    body: input.body.trim(),
    targetSkillName: input.targetSkillName ? normalizeSkillName(input.targetSkillName) : null,
    evidenceTaskIds: unique(input.evidenceTaskIds.map(String)),
    evidenceEventIds: uniqueNumbers(input.evidenceEventIds || []),
    frequency: Math.max(0, Math.floor(input.frequency)),
    successRate: clamp01(input.successRate),
    workflowSimilarity: clamp01(input.workflowSimilarity),
    verificationQuality: clamp01(input.verificationQuality),
    volatility: clamp01(input.volatility),
    overlapWithExisting: clamp01(input.overlapWithExisting),
    projectSpecificity: clamp01(input.projectSpecificity),
    score: clamp01(input.score),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    decidedAt: input.decidedAt,
    decisionReason: input.decisionReason,
  };
}

function candidateToParams(candidate: SkillCandidate): unknown[] {
  return [
    candidate.id,
    candidate.status,
    candidate.proposalType,
    candidate.workflowKey,
    candidate.name,
    candidate.title,
    candidate.description,
    JSON.stringify(candidate.trigger),
    JSON.stringify(candidate.antiTrigger),
    JSON.stringify(candidate.toolHints),
    candidate.body,
    candidate.targetSkillName,
    JSON.stringify(candidate.evidenceTaskIds),
    JSON.stringify(candidate.evidenceEventIds),
    candidate.frequency,
    candidate.successRate,
    candidate.workflowSimilarity,
    candidate.verificationQuality,
    candidate.volatility,
    candidate.overlapWithExisting,
    candidate.projectSpecificity,
    candidate.score,
    candidate.createdAt,
    candidate.updatedAt,
    candidate.decidedAt,
    candidate.decisionReason,
  ];
}

function parseCandidate(row: SkillCandidateRow): SkillCandidate {
  return {
    id: row.id,
    status: row.status,
    proposalType: row.proposal_type,
    workflowKey: row.workflow_key,
    name: row.name,
    title: row.title,
    description: row.description,
    trigger: parseJsonArray(row.trigger).map(String),
    antiTrigger: parseJsonArray(row.anti_trigger).map(String),
    toolHints: parseJsonArray(row.tool_hints).map(String) as SkillCandidate["toolHints"],
    body: row.body,
    targetSkillName: row.target_skill_name,
    evidenceTaskIds: parseJsonArray(row.evidence_task_ids).map(String),
    evidenceEventIds: parseJsonArray(row.evidence_event_ids).map(Number),
    frequency: row.frequency,
    successRate: row.success_rate,
    workflowSimilarity: row.workflow_similarity,
    verificationQuality: row.verification_quality,
    volatility: row.volatility,
    overlapWithExisting: row.overlap_with_existing,
    projectSpecificity: row.project_specificity,
    score: row.score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
  };
}

function renderSkillMarkdown(candidate: Pick<SkillCandidate, "name" | "title" | "description" | "trigger" | "antiTrigger" | "toolHints" | "body">): string {
  const frontmatter = [
    "---",
    `name: "${escapeYaml(candidate.name)}"`,
    `title: "${escapeYaml(candidate.title)}"`,
    `description: "${escapeYaml(candidate.description)}"`,
    "capabilities:",
    ...candidate.trigger.slice(0, 4).map((item) => `  - ${escapeYaml(item)}`),
    "tool_hints:",
    ...candidate.toolHints.map((tool) => `  - ${tool}`),
    "aliases:",
    ...candidate.trigger.slice(0, 3).map((item) => `  - ${escapeYaml(normalizeSkillName(item).slice(0, 60))}`),
    "---",
    "",
    "## Trigger",
    "",
    ...candidate.trigger.map((item) => `- ${item}`),
    "",
    "## Anti-trigger",
    "",
    ...(candidate.antiTrigger.length ? candidate.antiTrigger.map((item) => `- ${item}`) : ["- Do not use when the task shape or validation path differs materially."]),
    "",
    "## Workflow",
    "",
    candidate.body,
    "",
  ];
  return frontmatter.join("\n");
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "generated-skill";
}

function titleCase(value: string): string {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.map(Number).filter((value) => Number.isFinite(value)))];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
