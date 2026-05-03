import { createHash } from "node:crypto";

export interface CompressedVector {
  algorithm: string;
  dimensions: number;
  payload: number[];
  scale?: number;
}

export interface VectorCompressor {
  name: string;
  embed(text: string): number[];
  compress(vector: number[]): CompressedVector;
  decompress(compressed: CompressedVector): number[];
  similarity(query: number[], compressed: CompressedVector): number;
}

export class NoopCompressor implements VectorCompressor {
  name = "noop";

  embed(text: string): number[] {
    return embedText(text);
  }

  compress(vector: number[]): CompressedVector {
    return {
      algorithm: this.name,
      dimensions: vector.length,
      payload: vector,
    };
  }

  decompress(compressed: CompressedVector): number[] {
    return compressed.payload;
  }

  similarity(query: number[], compressed: CompressedVector): number {
    return cosineSimilarity(normalizeVector(query), normalizeVector(this.decompress(compressed)));
  }
}

export class ScalarQuantCompressor implements VectorCompressor {
  name = "scalar-int8";

  embed(text: string): number[] {
    return embedText(text);
  }

  compress(vector: number[]): CompressedVector {
    const maxAbs = Math.max(...vector.map((value) => Math.abs(value)), 1e-6);
    const scale = maxAbs / 127;
    return {
      algorithm: this.name,
      dimensions: vector.length,
      scale,
      payload: vector.map((value) => Math.max(-127, Math.min(127, Math.round(value / scale)))),
    };
  }

  decompress(compressed: CompressedVector): number[] {
    const scale = compressed.scale || 1;
    return compressed.payload.map((value) => value * scale);
  }

  similarity(query: number[], compressed: CompressedVector): number {
    return cosineSimilarity(normalizeVector(query), normalizeVector(this.decompress(compressed)));
  }
}

export class TurboQuantPlaceholderCompressor extends ScalarQuantCompressor {
  name = "turboquant-placeholder";
}

function embedText(text: string): number[] {
  const vector = new Array(64).fill(0);
  for (const token of tokenize(text)) {
    const hash = createHash("sha256").update(token).digest();
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] += (hash[index % hash.length] - 128) / 128;
    }
  }
  return normalizeVector(vector);
}

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] || 0), 0);
}
