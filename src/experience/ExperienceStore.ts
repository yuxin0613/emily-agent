import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  Experience,
  ExperienceCandidate,
  ExperienceRecallResult,
  ExperienceRevision,
  ExperienceUpdateAction,
} from "../types.ts";
import { ScalarQuantCompressor, type CompressedVector, type VectorCompressor } from "./VectorCompressor.ts";

interface ExperienceRow {
  id: string;
  revision: number;
  status: Experience["status"];
  scope: Experience["scope"];
  type: Experience["type"];
  topic_key: string;
  title: string;
  summary: string;
  problem_pattern: string;
  solution_pattern: string;
  evidence_task_ids: string;
  evidence_event_ids: string;
  confidence: number;
  importance: number;
  reuse_count: number;
  created_at: string;
  updated_at: string;
}

interface ExperienceRevisionRow {
  id: string;
  experience_id: string;
  revision: number;
  title: string;
  summary: string;
  problem_pattern: string;
  solution_pattern: string;
  confidence: number;
  importance: number;
  evidence_task_ids: string;
  evidence_event_ids: string;
  change_reason: string;
  created_at: string;
}

interface ExperienceVectorRow {
  experience_id: string;
  revision: number;
  status: string;
  algorithm: string;
  dimensions: number;
  payload: string;
  created_at: string;
}

export class ExperienceStore {
  db: DatabaseSync;
  compressor: VectorCompressor;

  static create({
    dataDir,
    compressor = new ScalarQuantCompressor(),
  }: {
    dataDir: string;
    compressor?: VectorCompressor;
  }): ExperienceStore {
    const store = new ExperienceStore({
      dbPath: path.join(dataDir, "emily.sqlite"),
      compressor,
    });
    store.migrate();
    return store;
  }

  constructor({ dbPath, compressor }: { dbPath: string; compressor: VectorCompressor }) {
    this.db = new DatabaseSync(dbPath);
    this.compressor = compressor;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiences (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        topic_key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        problem_pattern TEXT NOT NULL,
        solution_pattern TEXT NOT NULL,
        evidence_task_ids TEXT NOT NULL,
        evidence_event_ids TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        reuse_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_experiences_active ON experiences(status, scope, type, importance DESC);

      CREATE TABLE IF NOT EXISTS experience_revisions (
        id TEXT PRIMARY KEY,
        experience_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        problem_pattern TEXT NOT NULL,
        solution_pattern TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        evidence_task_ids TEXT NOT NULL,
        evidence_event_ids TEXT NOT NULL,
        change_reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_experience_revisions_exp ON experience_revisions(experience_id, revision DESC);

      CREATE TABLE IF NOT EXISTS experience_vectors (
        experience_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (experience_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_experience_vectors_active ON experience_vectors(status, algorithm);
    `);
  }

  upsertExperience(candidate: ExperienceCandidate): { action: ExperienceUpdateAction; experience: Experience } {
    const existing = this.getActiveByTopicKey(candidate.topicKey);
    if (!existing) {
      return {
        action: "create",
        experience: this.createExperience(candidate),
      };
    }

    const action = this.chooseUpdateAction(existing, candidate);
    if (action === "skip") {
      return { action, experience: existing };
    }

    return {
      action,
      experience: this.updateExperience(existing, candidate, action),
    };
  }

  recall(query: string, {
    scope,
    limit = 5,
  }: {
    scope?: Experience["scope"];
    limit?: number;
  } = {}): ExperienceRecallResult[] {
    const queryVector = this.compressor.embed(query);
    const rows = this.db
      .prepare(`
        SELECT e.*, v.algorithm, v.dimensions, v.payload
        FROM experiences e
        JOIN experience_vectors v ON v.experience_id = e.id AND v.revision = e.revision
        WHERE e.status = 'active'
          AND v.status = 'active'
          AND (? IS NULL OR e.scope = ?)
      `)
      .all(scope ?? null, scope ?? null) as Array<ExperienceRow & ExperienceVectorRow>;

    return rows
      .map((row) => ({
        ...parseExperience(row),
        score: this.compressor.similarity(queryVector, JSON.parse(row.payload) as CompressedVector),
      }))
      .sort((a, b) => (b.score + b.importance * 0.2 + b.confidence * 0.1) - (a.score + a.importance * 0.2 + a.confidence * 0.1))
      .slice(0, limit);
  }

  getActiveByTopicKey(topicKey: string): Experience | null {
    const row = this.db
      .prepare("SELECT * FROM experiences WHERE topic_key = ? AND status = 'active'")
      .get(topicKey) as ExperienceRow | undefined;
    return row ? parseExperience(row) : null;
  }

  getRevisions(experienceId: string): ExperienceRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM experience_revisions WHERE experience_id = ? ORDER BY revision DESC")
      .all(experienceId) as ExperienceRevisionRow[];
    return rows.map(parseRevision);
  }

  listActive(): Experience[] {
    const rows = this.db
      .prepare("SELECT * FROM experiences WHERE status = 'active' ORDER BY importance DESC, updated_at DESC")
      .all() as ExperienceRow[];
    return rows.map(parseExperience);
  }

  private createExperience(candidate: ExperienceCandidate): Experience {
    const now = new Date().toISOString();
    const experience: Experience = {
      id: randomUUID(),
      revision: 1,
      status: "active",
      scope: candidate.scope,
      type: candidate.type,
      topicKey: candidate.topicKey,
      title: candidate.title,
      summary: candidate.summary,
      problemPattern: candidate.problemPattern,
      solutionPattern: candidate.solutionPattern,
      evidenceTaskIds: candidate.evidenceTaskIds,
      evidenceEventIds: candidate.evidenceEventIds || [],
      confidence: candidate.confidence,
      importance: candidate.importance,
      reuseCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(`
        INSERT INTO experiences (
          id, revision, status, scope, type, topic_key, title, summary,
          problem_pattern, solution_pattern, evidence_task_ids, evidence_event_ids,
          confidence, importance, reuse_count, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        experience.id,
        experience.revision,
        experience.status,
        experience.scope,
        experience.type,
        experience.topicKey,
        experience.title,
        experience.summary,
        experience.problemPattern,
        experience.solutionPattern,
        JSON.stringify(experience.evidenceTaskIds),
        JSON.stringify(experience.evidenceEventIds),
        experience.confidence,
        experience.importance,
        experience.reuseCount,
        experience.createdAt,
        experience.updatedAt,
      );
    this.writeActiveVector(experience);
    return experience;
  }

  private updateExperience(existing: Experience, candidate: ExperienceCandidate, action: "replace" | "merge"): Experience {
    this.archiveRevision(existing, candidate.changeReason);
    this.archiveVector(existing.id, existing.revision);

    const nextRevision = existing.revision + 1;
    const now = new Date().toISOString();
    const mergedTaskIds = unique([...existing.evidenceTaskIds, ...candidate.evidenceTaskIds]);
    const mergedEventIds = uniqueNumbers([...existing.evidenceEventIds, ...(candidate.evidenceEventIds || [])]);
    const next: Experience = {
      ...existing,
      revision: nextRevision,
      title: action === "replace" ? candidate.title : existing.title,
      summary: action === "replace" ? candidate.summary : mergeText(existing.summary, candidate.summary),
      problemPattern: action === "replace" ? candidate.problemPattern : mergeText(existing.problemPattern, candidate.problemPattern),
      solutionPattern: action === "replace" ? candidate.solutionPattern : mergeText(existing.solutionPattern, candidate.solutionPattern),
      confidence: Math.max(existing.confidence, candidate.confidence),
      importance: Math.max(existing.importance, candidate.importance),
      evidenceTaskIds: mergedTaskIds,
      evidenceEventIds: mergedEventIds,
      updatedAt: now,
    };

    this.db
      .prepare(`
        UPDATE experiences
        SET revision = ?, title = ?, summary = ?, problem_pattern = ?, solution_pattern = ?,
            evidence_task_ids = ?, evidence_event_ids = ?, confidence = ?, importance = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.revision,
        next.title,
        next.summary,
        next.problemPattern,
        next.solutionPattern,
        JSON.stringify(next.evidenceTaskIds),
        JSON.stringify(next.evidenceEventIds),
        next.confidence,
        next.importance,
        next.updatedAt,
        next.id,
      );
    this.writeActiveVector(next);
    return next;
  }

  private chooseUpdateAction(existing: Experience, candidate: ExperienceCandidate): ExperienceUpdateAction {
    const stronger = candidate.importance > existing.importance + 0.05 || candidate.confidence > existing.confidence + 0.08;
    const sameEvidence = candidate.evidenceTaskIds.every((id) => existing.evidenceTaskIds.includes(id));
    if (sameEvidence && !stronger) return "skip";
    if (stronger || candidate.solutionPattern.length > existing.solutionPattern.length * 1.15) return "replace";
    return "merge";
  }

  private archiveRevision(existing: Experience, changeReason: string): void {
    this.db
      .prepare(`
        INSERT INTO experience_revisions (
          id, experience_id, revision, title, summary, problem_pattern, solution_pattern,
          confidence, importance, evidence_task_ids, evidence_event_ids, change_reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        existing.id,
        existing.revision,
        existing.title,
        existing.summary,
        existing.problemPattern,
        existing.solutionPattern,
        existing.confidence,
        existing.importance,
        JSON.stringify(existing.evidenceTaskIds),
        JSON.stringify(existing.evidenceEventIds),
        changeReason,
        new Date().toISOString(),
      );
  }

  private writeActiveVector(experience: Experience): void {
    const vector = this.compressor.embed(formatExperienceForEmbedding(experience));
    const compressed = this.compressor.compress(vector);
    this.db
      .prepare(`
        INSERT INTO experience_vectors (experience_id, revision, status, algorithm, dimensions, payload, created_at)
        VALUES (?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(
        experience.id,
        experience.revision,
        compressed.algorithm,
        compressed.dimensions,
        JSON.stringify(compressed),
        new Date().toISOString(),
      );
  }

  private archiveVector(experienceId: string, revision: number): void {
    this.db
      .prepare("UPDATE experience_vectors SET status = 'archived' WHERE experience_id = ? AND revision = ?")
      .run(experienceId, revision);
  }

  close(): void {
    this.db.close();
  }
}

function formatExperienceForEmbedding(experience: Experience): string {
  return [
    experience.topicKey,
    experience.title,
    experience.summary,
    experience.problemPattern,
    experience.solutionPattern,
  ].join("\n");
}

function parseExperience(row: ExperienceRow): Experience {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    scope: row.scope,
    type: row.type,
    topicKey: row.topic_key,
    title: row.title,
    summary: row.summary,
    problemPattern: row.problem_pattern,
    solutionPattern: row.solution_pattern,
    evidenceTaskIds: JSON.parse(row.evidence_task_ids || "[]") as string[],
    evidenceEventIds: JSON.parse(row.evidence_event_ids || "[]") as number[],
    confidence: row.confidence,
    importance: row.importance,
    reuseCount: row.reuse_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRevision(row: ExperienceRevisionRow): ExperienceRevision {
  return {
    id: row.id,
    experienceId: row.experience_id,
    revision: row.revision,
    title: row.title,
    summary: row.summary,
    problemPattern: row.problem_pattern,
    solutionPattern: row.solution_pattern,
    confidence: row.confidence,
    importance: row.importance,
    evidenceTaskIds: JSON.parse(row.evidence_task_ids || "[]") as string[],
    evidenceEventIds: JSON.parse(row.evidence_event_ids || "[]") as number[],
    changeReason: row.change_reason,
    createdAt: row.created_at,
  };
}

function mergeText(left: string, right: string): string {
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  return `${left}\n${right}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}
