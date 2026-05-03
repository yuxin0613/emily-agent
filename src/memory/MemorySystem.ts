import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryRecord, MemoryRecallResult, Metadata } from "../types.ts";
import { MemoryCurator } from "./MemoryCurator.ts";

export class MemorySystem {
  shortTerm: InMemoryLayer;
  fileLayer: FileMemoryLayer;
  vectorLayer: VectorMemoryLayer;
  curator: MemoryCurator;

  static async create({ dataDir }: { dataDir: string }): Promise<MemorySystem> {
    const memoryDir = path.join(dataDir, "memory");
    await mkdir(memoryDir, { recursive: true });

    const system = new MemorySystem({
      shortTerm: new InMemoryLayer({ maxRecords: 100 }),
      fileLayer: new FileMemoryLayer({
        filePath: path.join(memoryDir, "events.jsonl"),
      }),
      vectorLayer: new VectorMemoryLayer({
        filePath: path.join(memoryDir, "vector-index.json"),
      }),
      curator: new MemoryCurator(),
    });

    await system.vectorLayer.load();
    return system;
  }

  constructor({
    shortTerm,
    fileLayer,
    vectorLayer,
    curator,
  }: {
    shortTerm: InMemoryLayer;
    fileLayer: FileMemoryLayer;
    vectorLayer: VectorMemoryLayer;
    curator: MemoryCurator;
  }) {
    this.shortTerm = shortTerm;
    this.fileLayer = fileLayer;
    this.vectorLayer = vectorLayer;
    this.curator = curator;
  }

  async remember(record: Partial<MemoryRecord> & { content: string }): Promise<MemoryRecord> {
    const normalized = normalizeRecord(record);
    const curated = this.curator.curate(normalized);
    this.shortTerm.add(normalized);
    await this.fileLayer.add(normalized);
    if (this.curator.shouldStoreLongTerm(curated)) {
      await this.vectorLayer.add(curated);
    }
    return normalized;
  }

  async recall(query: string, options: { scope?: string; limit?: number } = {}): Promise<MemoryRecallResult> {
    const scope = options.scope || "default";
    const limit = options.limit || 5;

    const [files, semantic] = await Promise.all([
      this.fileLayer.search(query, { scope, limit }),
      this.vectorLayer.search(query, { scope, limit }),
    ]);

    return {
      shortTerm: this.shortTerm.search(query, { scope, limit }),
      files,
      semantic,
    };
  }
}

class InMemoryLayer {
  maxRecords: number;
  records: MemoryRecord[];

  constructor({ maxRecords }: { maxRecords: number }) {
    this.maxRecords = maxRecords;
    this.records = [];
  }

  add(record: MemoryRecord): void {
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  search(query: string, { scope, limit }: { scope: string; limit: number }): Array<MemoryRecord & { score: number }> {
    return scoreTextRecords(this.records, query, scope).slice(0, limit);
  }
}

class FileMemoryLayer {
  filePath: string;

  constructor({ filePath }: { filePath: string }) {
    this.filePath = filePath;
  }

  async add(record: MemoryRecord): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async search(query: string, { scope, limit }: { scope: string; limit: number }): Promise<Array<MemoryRecord & { score: number }>> {
    const content = await readTextIfExists(this.filePath);
    const records = content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return scoreTextRecords(records, query, scope).slice(0, limit);
  }
}

class VectorMemoryLayer {
  filePath: string;
  items: Array<{ record: MemoryRecord; embedding: number[] }>;

  constructor({ filePath }: { filePath: string }) {
    this.filePath = filePath;
    this.items = [];
  }

  async load(): Promise<void> {
    const content = await readTextIfExists(this.filePath);
    this.items = content ? JSON.parse(content) : [];
  }

  async add(record: MemoryRecord): Promise<void> {
    this.items.push({
      record,
      embedding: embedText(record.content),
    });
    await writeFile(this.filePath, JSON.stringify(this.items, null, 2), "utf8");
  }

  async search(query: string, { scope, limit }: { scope: string; limit: number }): Promise<Array<MemoryRecord & { score: number }>> {
    const queryEmbedding = embedText(query);
    return this.items
      .filter((item) => item.record.scope === scope)
      .map((item) => ({
        ...item.record,
        score: cosineSimilarity(queryEmbedding, item.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

function normalizeRecord(record: Partial<MemoryRecord> & { content: string }): MemoryRecord {
  return {
    id: record.id || randomUUID(),
    scope: record.scope || "default",
    kind: record.kind || "note",
    content: String(record.content || ""),
    metadata: record.metadata || {} as Metadata,
    createdAt: record.createdAt || new Date().toISOString(),
  };
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function scoreTextRecords(records: MemoryRecord[], query: string, scope: string): Array<MemoryRecord & { score: number }> {
  const queryTokens = tokenize(query);
  return records
    .filter((record) => record.scope === scope)
    .map((record) => ({
      ...record,
      score: lexicalScore(queryTokens, tokenize(record.content)),
    }))
    .sort((a, b) => b.score - a.score);
}

function lexicalScore(queryTokens: string[], recordTokens: string[]): number {
  if (!queryTokens.length || !recordTokens.length) return 0;
  const recordSet = new Set(recordTokens);
  const hits = queryTokens.filter((token) => recordSet.has(token)).length;
  return hits / queryTokens.length;
}

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
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

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}
