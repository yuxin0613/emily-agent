import type { Experience, ExperienceCandidate } from "../types.ts";
import { type VectorCompressor } from "./VectorCompressor.ts";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "use",
  "uses",
  "into",
  "only",
  "when",
  "then",
  "task",
  "agent",
  "runtime",
  "design",
  "实现",
  "任务",
  "这个",
  "我们",
  "一个",
  "需要",
  "可以",
]);

export class ExperienceMatcher {
  compressor: VectorCompressor;
  similarityThreshold: number;

  constructor({
    compressor,
    similarityThreshold = 0.78,
  }: {
    compressor: VectorCompressor;
    similarityThreshold?: number;
  }) {
    this.compressor = compressor;
    this.similarityThreshold = similarityThreshold;
  }

  normalizeCandidate(candidate: ExperienceCandidate): ExperienceCandidate {
    return {
      ...candidate,
      topicKey: candidate.topicKey || makeTopicKey(candidate),
    };
  }

  findMatch(candidate: ExperienceCandidate, activeExperiences: Experience[]): Experience | null {
    const exact = activeExperiences.find((experience) => experience.topicKey === candidate.topicKey);
    if (exact) return exact;

    const candidateVector = this.compressor.embed(formatCandidate(candidate));
    const scored = activeExperiences
      .filter((experience) => experience.scope === candidate.scope && experience.type === candidate.type)
      .map((experience) => ({
        experience,
        score: cosineSimilarity(candidateVector, this.compressor.embed(formatExperience(experience))),
        overlap: tokenOverlap(formatCandidate(candidate), formatExperience(experience)),
      }))
      .sort((a, b) => (b.score + b.overlap * 0.15) - (a.score + a.overlap * 0.15));

    const best = scored[0];
    if (!best) return null;
    return best.score >= this.similarityThreshold || best.overlap >= 0.34 ? best.experience : null;
  }
}

export function makeTopicKey(candidate: Pick<ExperienceCandidate, "scope" | "type" | "problemPattern" | "solutionPattern" | "title">): string {
  const tokens = tokenize(`${candidate.title} ${candidate.problemPattern} ${candidate.solutionPattern}`)
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 10)
    .sort();
  const signature = tokens.length ? tokens.join("_") : "general";
  return `${candidate.scope}_${candidate.type}_${signature}`.slice(0, 128);
}

function formatCandidate(candidate: ExperienceCandidate): string {
  return [
    candidate.scope,
    candidate.type,
    candidate.title,
    candidate.problemPattern,
    candidate.solutionPattern,
  ].join("\n");
}

function formatExperience(experience: Experience): string {
  return [
    experience.scope,
    experience.type,
    experience.title,
    experience.problemPattern,
    experience.solutionPattern,
  ].join("\n");
}

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left).filter((token) => !STOPWORDS.has(token)));
  const rightTokens = new Set(tokenize(right).filter((token) => !STOPWORDS.has(token)));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const hits = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return hits / Math.min(leftTokens.size, rightTokens.size);
}

function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] || 0), 0);
}
