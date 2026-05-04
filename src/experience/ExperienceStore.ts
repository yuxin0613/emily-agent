import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  Experience,
  ExperienceCandidate,
  ExperienceFeedback,
  ExperienceFeedbackRating,
  ExperienceRecallResult,
  ExperienceRevision,
  ExperienceUpdateAction,
} from "../types.ts";
import { ExperienceMatcher } from "./ExperienceMatcher.ts";
import { ScalarQuantCompressor, type CompressedVector, type VectorCompressor } from "./VectorCompressor.ts";
import { SchemaMigrator } from "../storage/SchemaMigrator.ts";

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
  applicability: string;
  contraindications: string;
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
  applicability: string;
  contraindications: string;
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

interface ExperienceFeedbackRow {
  id: string;
  experience_id: string;
  rating: ExperienceFeedbackRating;
  comment: string;
  created_at: string;
}

export class ExperienceStore {
  db: DatabaseSync;
  compressor: VectorCompressor;
  matcher: ExperienceMatcher;

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
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.compressor = compressor;
    this.matcher = new ExperienceMatcher({ compressor });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }

  migrate(): void {
    new SchemaMigrator({ db: this.db, namespace: "experience" }).apply([
      {
        version: 1,
        name: "create_experience_tables",
        up: () => {
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
        },
      },
      {
        version: 2,
        name: "create_experience_feedback",
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS experience_feedback (
              id TEXT PRIMARY KEY,
              experience_id TEXT NOT NULL,
              rating TEXT NOT NULL,
              comment TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_experience_feedback_exp ON experience_feedback(experience_id, rating);
          `);
        },
      },
      {
        version: 3,
        name: "add_experience_applicability",
        up: () => {
          this.ensureColumn("experiences", "applicability", "TEXT NOT NULL DEFAULT ''");
          this.ensureColumn("experiences", "contraindications", "TEXT NOT NULL DEFAULT '[]'");
          this.ensureColumn("experience_revisions", "applicability", "TEXT NOT NULL DEFAULT ''");
          this.ensureColumn("experience_revisions", "contraindications", "TEXT NOT NULL DEFAULT '[]'");
        },
      },
      {
        version: 4,
        name: "add_experience_index_maintenance",
        up: () => {
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_experience_vectors_exp_status ON experience_vectors(experience_id, status, revision);
            CREATE INDEX IF NOT EXISTS idx_experiences_scope_status ON experiences(scope, status, updated_at DESC);
          `);
        },
      },
    ]);
  }

  upsertExperience(candidate: ExperienceCandidate): { action: ExperienceUpdateAction; experience: Experience } {
    const normalized = this.matcher.normalizeCandidate(candidate);
    const existing = this.matcher.findMatch(normalized, this.listActive());
    if (!existing) {
      return {
        action: "create",
        experience: this.createExperience(normalized),
      };
    }

    const action = this.chooseUpdateAction(existing, normalized);
    if (action === "skip") {
      return { action, experience: existing };
    }

    if (action === "conflict" || action === "split") {
      return {
        action,
        experience: this.createExperience({
          ...normalized,
          topicKey: `${normalized.topicKey}_${action}_${Date.now()}`.slice(0, 128),
          changeReason: `${action} from ${existing.id}: ${normalized.changeReason}`,
        }),
      };
    }
    if (action !== "replace" && action !== "merge") {
      throw new Error(`Unsupported automatic experience update action: ${action}`);
    }

    return {
      action,
      experience: this.updateExperience(existing, normalized, action),
    };
  }

  recall(query: string, {
    scope,
    limit = 5,
    minScore = 0.08,
    includeContraindicated = false,
  }: {
    scope?: Experience["scope"];
    limit?: number;
    minScore?: number;
    includeContraindicated?: boolean;
  } = {}): ExperienceRecallResult[] {
    const queryVector = this.compressor.embed(query);
    const queryTokens = tokenize(query);
    const rows = this.db
      .prepare(`
        SELECT e.*, v.algorithm, v.dimensions, v.payload
        FROM experiences e
        JOIN experience_vectors v ON v.experience_id = e.id AND v.revision = e.revision
        WHERE e.status = 'active'
          AND v.status = 'active'
          AND (? IS NULL OR e.scope = ?)
      `)
      .all(scope ?? null, scope ?? null) as unknown as Array<ExperienceRow & ExperienceVectorRow>;

    return rows
      .map((row) => {
        const experience = parseExperience(row);
        const vectorScore = this.compressor.similarity(queryVector, JSON.parse(row.payload) as CompressedVector);
        const lexical = tokenOverlap(queryTokens, tokenize(formatExperienceForEmbedding(experience)));
        const applicability = applicabilityScore(queryTokens, experience);
        const contraindication = contraindicationScore(queryTokens, experience.contraindications);
        const feedback = this.feedbackScore(experience.id);
        const score = scoreRecall({
          ...experience,
          score: vectorScore,
          vectorScore,
          lexicalScore: lexical,
          applicabilityScore: applicability,
          feedbackScore: feedback,
          recallReason: recallReason({ vectorScore, lexical, applicability, contraindication }),
        }, feedback, {
          lexical,
          applicability,
          contraindication: includeContraindicated ? 0 : contraindication,
        });
        return {
          ...experience,
          score,
          vectorScore,
          lexicalScore: lexical,
          applicabilityScore: applicability,
          feedbackScore: feedback,
          recallReason: recallReason({ vectorScore, lexical, applicability, contraindication }),
        };
      })
      .filter((experience) => experience.score >= minScore)
      .filter((experience) => includeContraindicated || contraindicationScore(queryTokens, experience.contraindications) < 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  maintenance({ rebuildVectors = true, pruneArchivedVectorDays = 90 }: { rebuildVectors?: boolean; pruneArchivedVectorDays?: number } = {}): {
    rebuiltVectors: number;
    archivedStaleVectors: number;
    prunedArchivedVectors: number;
    stats: Array<{ status: string; algorithm: string; count: number }>;
  } {
    const archivedStaleVectors = this.archiveStaleVectors();
    let rebuiltVectors = 0;
    if (rebuildVectors) {
      for (const experience of this.listActive()) {
        if (this.needsVectorRebuild(experience)) {
          this.writeActiveVector(experience);
          rebuiltVectors += 1;
        }
      }
    }
    const prunedArchivedVectors = this.pruneArchivedVectors(pruneArchivedVectorDays);
    return {
      rebuiltVectors,
      archivedStaleVectors,
      prunedArchivedVectors,
      stats: this.vectorStats(),
    };
  }

  vectorStats(): Array<{ status: string; algorithm: string; count: number }> {
    const rows = this.db
      .prepare("SELECT status, algorithm, COUNT(*) AS count FROM experience_vectors GROUP BY status, algorithm ORDER BY status, algorithm")
      .all() as Array<{ status: string; algorithm: string; count: number }>;
    return rows;
  }

  recordUse(experienceId: string): void {
    this.db
      .prepare("UPDATE experiences SET reuse_count = reuse_count + 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), experienceId);
  }

  addFeedback({
    experienceId,
    rating,
    comment = "",
  }: {
    experienceId: string;
    rating: ExperienceFeedbackRating;
    comment?: string;
  }): ExperienceFeedback {
    const feedback: ExperienceFeedback = {
      id: randomUUID(),
      experienceId,
      rating,
      comment,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO experience_feedback (id, experience_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(feedback.id, feedback.experienceId, feedback.rating, feedback.comment, feedback.createdAt);
    return feedback;
  }

  deprecateExperience(experienceId: string, reason: string): Experience {
    const existing = this.listActive().find((experience) => experience.id === experienceId);
    if (!existing) throw new Error(`Experience not found: ${experienceId}`);
    this.archiveRevision(existing, reason);
    this.archiveVector(existing.id, existing.revision);
    this.db
      .prepare("UPDATE experiences SET status = 'deprecated', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), experienceId);
    return {
      ...existing,
      status: "deprecated",
      updatedAt: new Date().toISOString(),
    };
  }

  getFeedback(experienceId: string): ExperienceFeedback[] {
    const rows = this.db
      .prepare("SELECT * FROM experience_feedback WHERE experience_id = ? ORDER BY created_at DESC")
      .all(experienceId) as unknown as ExperienceFeedbackRow[];
    return rows.map(parseFeedback);
  }

  getActiveByTopicKey(topicKey: string): Experience | null {
    const row = this.db
      .prepare("SELECT * FROM experiences WHERE topic_key = ? AND status = 'active'")
      .get(topicKey) as unknown as ExperienceRow | undefined;
    return row ? parseExperience(row) : null;
  }

  getRevisions(experienceId: string): ExperienceRevision[] {
    const rows = this.db
      .prepare("SELECT * FROM experience_revisions WHERE experience_id = ? ORDER BY revision DESC")
      .all(experienceId) as unknown as ExperienceRevisionRow[];
    return rows.map(parseRevision);
  }

  listActive(): Experience[] {
    const rows = this.db
      .prepare("SELECT * FROM experiences WHERE status = 'active' ORDER BY importance DESC, updated_at DESC")
      .all() as unknown as ExperienceRow[];
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
      applicability: candidate.applicability || defaultApplicability(candidate),
      contraindications: candidate.contraindications || [],
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
          problem_pattern, solution_pattern, applicability, contraindications, evidence_task_ids, evidence_event_ids,
          confidence, importance, reuse_count, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        experience.applicability,
        JSON.stringify(experience.contraindications),
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
      applicability: action === "replace"
        ? (candidate.applicability || defaultApplicability(candidate))
        : mergeText(existing.applicability, candidate.applicability || defaultApplicability(candidate)),
      contraindications: action === "replace"
        ? (candidate.contraindications || [])
        : unique([...existing.contraindications, ...(candidate.contraindications || [])]),
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
            applicability = ?, contraindications = ?, evidence_task_ids = ?, evidence_event_ids = ?,
            confidence = ?, importance = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.revision,
        next.title,
        next.summary,
        next.problemPattern,
        next.solutionPattern,
        next.applicability,
        JSON.stringify(next.contraindications),
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
    if (/conflict|冲突|不同场景/.test(candidate.changeReason)) return "conflict";
    if (/split|拆分/.test(candidate.changeReason)) return "split";
    const feedbackPenalty = Math.min(0.16, Math.abs(Math.min(0, this.feedbackScore(existing.id))) * 0.1);
    const stronger = candidate.importance > existing.importance + 0.05 || candidate.confidence > existing.confidence + 0.08;
    const sameEvidence = candidate.evidenceTaskIds.every((id) => existing.evidenceTaskIds.includes(id));
    if (sameEvidence && !stronger) return "skip";
    if (stronger || feedbackPenalty > 0 || candidate.solutionPattern.length > existing.solutionPattern.length * 1.15) return "replace";
    return "merge";
  }

  private feedbackScore(experienceId: string): number {
    const feedback = this.getFeedback(experienceId);
    return feedback.reduce((score, item) => {
      if (item.rating === "useful") return score + 1;
      if (item.rating === "wrong") return score - 2;
      if (item.rating === "outdated") return score - 1.5;
      if (item.rating === "duplicate") return score - 1;
      return score;
    }, 0);
  }

  private archiveRevision(existing: Experience, changeReason: string): void {
    this.db
      .prepare(`
        INSERT INTO experience_revisions (
          id, experience_id, revision, title, summary, problem_pattern, solution_pattern,
          applicability, contraindications, confidence, importance, evidence_task_ids, evidence_event_ids,
          change_reason, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        existing.id,
        existing.revision,
        existing.title,
        existing.summary,
        existing.problemPattern,
        existing.solutionPattern,
        existing.applicability,
        JSON.stringify(existing.contraindications),
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
        ON CONFLICT(experience_id, revision) DO UPDATE SET
          status = 'active',
          algorithm = excluded.algorithm,
          dimensions = excluded.dimensions,
          payload = excluded.payload,
          created_at = excluded.created_at
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

  private needsVectorRebuild(experience: Experience): boolean {
    const row = this.db
      .prepare("SELECT algorithm, status FROM experience_vectors WHERE experience_id = ? AND revision = ?")
      .get(experience.id, experience.revision) as { algorithm: string; status: string } | undefined;
    return !row || row.status !== "active" || row.algorithm !== this.compressor.name;
  }

  private archiveStaleVectors(): number {
    const result = this.db
      .prepare(`
        UPDATE experience_vectors
        SET status = 'archived'
        WHERE status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM experiences e
            WHERE e.id = experience_vectors.experience_id
              AND e.revision = experience_vectors.revision
              AND e.status = 'active'
          )
      `)
      .run();
    return Number(result.changes);
  }

  private pruneArchivedVectors(olderThanDays: number): number {
    if (olderThanDays <= 0) return 0;
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db
      .prepare("DELETE FROM experience_vectors WHERE status = 'archived' AND created_at < ?")
      .run(cutoff);
    return Number(result.changes);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
    experience.applicability,
    ...experience.contraindications,
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
    applicability: row.applicability || "",
    contraindications: parseStringArray(row.contraindications),
    evidenceTaskIds: JSON.parse(row.evidence_task_ids || "[]") as unknown as string[],
    evidenceEventIds: JSON.parse(row.evidence_event_ids || "[]") as unknown as number[],
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
    applicability: row.applicability || "",
    contraindications: parseStringArray(row.contraindications),
    confidence: row.confidence,
    importance: row.importance,
    evidenceTaskIds: JSON.parse(row.evidence_task_ids || "[]") as unknown as string[],
    evidenceEventIds: JSON.parse(row.evidence_event_ids || "[]") as unknown as number[],
    changeReason: row.change_reason,
    createdAt: row.created_at,
  };
}

function parseFeedback(row: ExperienceFeedbackRow): ExperienceFeedback {
  return {
    id: row.id,
    experienceId: row.experience_id,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at,
  };
}

function scoreRecall(
  experience: ExperienceRecallResult,
  feedbackScore: number,
  { lexical = 0, applicability = 0, contraindication = 0 }: { lexical?: number; applicability?: number; contraindication?: number } = {},
): number {
  return experience.score * 0.62
    + lexical * 0.16
    + applicability * 0.12
    + experience.importance * 0.2
    + experience.confidence * 0.1
    + Math.min(0.15, experience.reuseCount * 0.02)
    + Math.max(-0.4, Math.min(0.25, feedbackScore * 0.08))
    - contraindication * 0.75;
}

function mergeText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  return `${left}\n${right}`;
}

function defaultApplicability(candidate: ExperienceCandidate): string {
  return `Use when ${candidate.problemPattern}`;
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function tokenOverlap(leftTokens: string[], rightTokens: string[]): number {
  const left = new Set(leftTokens);
  const right = new Set(rightTokens);
  if (!left.size || !right.size) return 0;
  const hits = [...left].filter((token) => right.has(token)).length;
  return hits / Math.min(left.size, right.size);
}

function applicabilityScore(queryTokens: string[], experience: Experience): number {
  return Math.max(
    tokenOverlap(queryTokens, tokenize(experience.applicability)),
    tokenOverlap(queryTokens, tokenize(experience.problemPattern)),
  );
}

function contraindicationScore(queryTokens: string[], contraindications: string[]): number {
  if (!contraindications.length) return 0;
  return Math.max(...contraindications.map((item) => tokenOverlap(queryTokens, tokenize(item))));
}

function recallReason({
  vectorScore,
  lexical,
  applicability,
  contraindication,
}: {
  vectorScore: number;
  lexical: number;
  applicability: number;
  contraindication: number;
}): string {
  if (contraindication >= 0.5) return "contraindicated";
  if (applicability >= 0.35) return "applicability";
  if (lexical >= 0.35) return "lexical";
  if (vectorScore >= 0.45) return "semantic";
  return "low-confidence";
}
