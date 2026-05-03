import { mkdir, readFile, writeFile, appendFile, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { MemoryRecord, MemoryRecallResult, Metadata } from "../types.ts";
import { ScalarQuantCompressor, type CompressedVector, type VectorCompressor } from "../experience/VectorCompressor.ts";
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
        compressor: new ScalarQuantCompressor(),
        maxItems: 500,
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

  async compact(options: { maxFileRecords?: number; maxVectorRecords?: number } = {}): Promise<{
    file: { before: number; after: number; removed: number };
    vector: { before: number; after: number; removed: number; algorithm: string };
  }> {
    const file = await this.fileLayer.compact({ maxRecords: options.maxFileRecords ?? 1000 });
    const vector = await this.vectorLayer.compact({ maxItems: options.maxVectorRecords ?? 500 });
    return { file, vector };
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
  lockPath: string;

  constructor({ filePath }: { filePath: string }) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  async add(record: MemoryRecord): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    });
  }

  async search(query: string, { scope, limit }: { scope: string; limit: number }): Promise<Array<MemoryRecord & { score: number }>> {
    return withFileLock(this.lockPath, async () => {
      const records = await this.readRecordsUnlocked({ quarantine: true });
      return scoreTextRecords(records, query, scope).slice(0, limit);
    });
  }

  async compact({ maxRecords }: { maxRecords: number }): Promise<{ before: number; after: number; removed: number }> {
    return withFileLock(this.lockPath, async () => {
      const records = await this.readRecordsUnlocked({ quarantine: true });
      const before = records.length;
      const deduped = dedupeRecords(records)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, maxRecords)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      await this.saveUnlocked(deduped);
      return {
        before,
        after: deduped.length,
        removed: before - deduped.length,
      };
    });
  }

  private async readRecordsUnlocked({ quarantine }: { quarantine: boolean }): Promise<MemoryRecord[]> {
    const content = await readTextIfExists(this.filePath);
    const records: MemoryRecord[] = [];
    const corrupt: Array<{ line: string; lineNumber: number; error: string; quarantinedAt: string }> = [];
    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as MemoryRecord);
      } catch (error) {
        corrupt.push({
          line,
          lineNumber: index + 1,
          error: error instanceof Error ? error.message : String(error),
          quarantinedAt: new Date().toISOString(),
        });
      }
    }
    if (quarantine && corrupt.length) {
      await this.quarantineUnlocked(corrupt);
      await this.saveUnlocked(records);
    }
    return records;
  }

  private async quarantineUnlocked(corrupt: Array<{ line: string; lineNumber: number; error: string; quarantinedAt: string }>): Promise<void> {
    const quarantinePath = `${this.filePath}.corrupt.jsonl`;
    await appendFile(quarantinePath, corrupt.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  }

  private async saveUnlocked(records: MemoryRecord[]): Promise<void> {
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }
}

class VectorMemoryLayer {
  filePath: string;
  compressor: VectorCompressor;
  maxItems: number;
  lockPath: string;
  items: Array<{ record: MemoryRecord; vector: CompressedVector; contentHash: string; updatedAt: string; hits: number }>;

  constructor({ filePath, compressor, maxItems }: { filePath: string; compressor: VectorCompressor; maxItems: number }) {
    this.filePath = filePath;
    this.compressor = compressor;
    this.maxItems = maxItems;
    this.lockPath = `${filePath}.lock`;
    this.items = [];
  }

  async load(): Promise<void> {
    const content = await readTextIfExists(this.filePath);
    const parsed = content ? JSON.parse(content) as unknown : [];
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown[] }).items)
        ? (parsed as { items: unknown[] }).items
        : [];
    this.items = items.map((item) => normalizeVectorItem(item, this.compressor)).filter((item): item is VectorMemoryLayer["items"][number] => Boolean(item));
  }

  async add(record: MemoryRecord): Promise<void> {
    await withFileLock(this.lockPath, async () => {
      await this.load();
      const contentHash = memoryHash(record);
      const existing = this.items.find((item) => item.contentHash === contentHash);
      if (existing) {
        existing.record = mergeMemoryRecord(existing.record, record);
        existing.updatedAt = new Date().toISOString();
        await this.saveUnlocked();
        return;
      }
      this.items.push({
        record,
        vector: this.compressor.compress(this.compressor.embed(record.content)),
        contentHash,
        updatedAt: new Date().toISOString(),
        hits: 0,
      });
      await this.compactUnlocked({ maxItems: this.maxItems });
    });
  }

  async search(query: string, { scope, limit }: { scope: string; limit: number }): Promise<Array<MemoryRecord & { score: number }>> {
    return withFileLock(this.lockPath, async () => {
      await this.load();
      const queryEmbedding = this.compressor.embed(query);
      const scored = this.items
        .filter((item) => item.record.scope === scope)
        .map((item) => ({
          item,
          ...item.record,
          score: blendedMemoryScore({
            semantic: this.compressor.similarity(queryEmbedding, item.vector),
            lexical: lexicalScore(tokenize(query), tokenize(item.record.content)),
            record: item.record,
            hits: item.hits,
          }),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      for (const result of scored) {
        result.item.hits += 1;
        result.item.updatedAt = new Date().toISOString();
      }
      if (scored.length) await this.saveUnlocked();
      return scored.map(({ item: _item, ...record }) => record);
    });
  }

  async compact({ maxItems }: { maxItems: number }): Promise<{ before: number; after: number; removed: number; algorithm: string }> {
    return withFileLock(this.lockPath, async () => {
      await this.load();
      return this.compactUnlocked({ maxItems });
    });
  }

  private async compactUnlocked({ maxItems }: { maxItems: number }): Promise<{ before: number; after: number; removed: number; algorithm: string }> {
    const before = this.items.length;
    const byHash = new Map<string, VectorMemoryLayer["items"][number]>();
    for (const item of this.items) {
      const existing = byHash.get(item.contentHash);
      byHash.set(item.contentHash, existing ? mergeVectorItem(existing, item) : item);
    }
    this.items = [...byHash.values()]
      .sort((a, b) => memoryRetentionScore(b) - memoryRetentionScore(a))
      .slice(0, maxItems);
    await this.saveUnlocked();
    return {
      before,
      after: this.items.length,
      removed: before - this.items.length,
      algorithm: this.compressor.name,
    };
  }

  private async saveUnlocked(): Promise<void> {
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify({
        version: 2,
        algorithm: this.compressor.name,
        items: this.items,
      }, null, 2), "utf8");
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
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

function normalizeVectorItem(item: unknown, compressor: VectorCompressor): VectorMemoryLayer["items"][number] | null {
  if (!item || typeof item !== "object") return null;
  const value = item as {
    record?: MemoryRecord;
    vector?: CompressedVector;
    embedding?: number[];
    contentHash?: string;
    updatedAt?: string;
    hits?: number;
    items?: unknown[];
  };
  if (Array.isArray(value.items)) return null;
  if (!value.record) return null;
  return {
    record: value.record,
    vector: value.vector || compressor.compress(value.embedding || compressor.embed(value.record.content)),
    contentHash: value.contentHash || memoryHash(value.record),
    updatedAt: value.updatedAt || value.record.createdAt || new Date().toISOString(),
    hits: typeof value.hits === "number" ? value.hits : 0,
  };
}

function memoryHash(record: MemoryRecord): string {
  return createHash("sha256").update([record.scope, record.kind, normalizeText(record.content)].join("\n")).digest("hex");
}

function dedupeRecords(records: MemoryRecord[]): MemoryRecord[] {
  const byHash = new Map<string, MemoryRecord>();
  for (const record of records) {
    const hash = memoryHash(record);
    const existing = byHash.get(hash);
    byHash.set(hash, existing ? mergeMemoryRecord(existing, record) : record);
  }
  return [...byHash.values()];
}

function mergeMemoryRecord(left: MemoryRecord, right: MemoryRecord): MemoryRecord {
  return {
    ...left,
    metadata: {
      ...left.metadata,
      ...right.metadata,
      duplicateCount: Number(left.metadata.duplicateCount || 1) + 1,
      lastSeenAt: right.createdAt,
    },
  };
}

function mergeVectorItem(left: VectorMemoryLayer["items"][number], right: VectorMemoryLayer["items"][number]): VectorMemoryLayer["items"][number] {
  return {
    ...left,
    record: mergeMemoryRecord(left.record, right.record),
    updatedAt: Date.parse(left.updatedAt) > Date.parse(right.updatedAt) ? left.updatedAt : right.updatedAt,
    hits: left.hits + right.hits,
  };
}

function blendedMemoryScore({ semantic, lexical, record, hits }: { semantic: number; lexical: number; record: MemoryRecord; hits: number }): number {
  const importance = typeof record.metadata.importance === "number" ? record.metadata.importance : 0;
  const confidence = typeof record.metadata.confidence === "number" ? record.metadata.confidence : 0;
  const reuse = Math.min(0.08, hits * 0.01);
  return semantic * 0.72 + lexical * 0.18 + importance * 0.06 + confidence * 0.04 + reuse;
}

function memoryRetentionScore(item: VectorMemoryLayer["items"][number]): number {
  const ageDays = Math.max(0, (Date.now() - Date.parse(item.updatedAt || item.record.createdAt)) / (24 * 60 * 60 * 1000));
  const recency = Math.max(0, 1 - ageDays / 30);
  const importance = typeof item.record.metadata.importance === "number" ? item.record.metadata.importance : 0.5;
  const confidence = typeof item.record.metadata.confidence === "number" ? item.record.metadata.confidence : 0.5;
  return importance * 0.35 + confidence * 0.2 + recency * 0.25 + Math.min(0.2, item.hits * 0.02);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const staleLockMs = 10000;
  const deadline = Date.now() + staleLockMs;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  while (!handle) {
    try {
      const acquired = await open(lockPath, "wx");
      try {
        await acquired.writeFile(JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }));
        handle = acquired;
      } catch (error) {
        await acquired.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const current = await stat(lockPath).catch(() => null);
      if (current && Date.now() - current.mtimeMs > staleLockMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for memory vector lock: ${lockPath}`);
      }
      await sleep(25);
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
