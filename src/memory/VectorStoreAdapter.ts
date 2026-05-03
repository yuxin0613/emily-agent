import type { MemoryRecord } from "../types.ts";
import type { CompressedVector } from "../experience/VectorCompressor.ts";

export type VectorStoreKind = "file" | "chroma" | "qdrant" | "milvus" | "pgvector";

export interface VectorStoreConfig {
  kind?: VectorStoreKind;
  baseUrl?: string;
  collection?: string;
  connectionStringEnv?: string;
  timeoutMs?: number;
  fallbackToFile?: boolean;
}

export interface VectorStoreItem {
  id: string;
  record: MemoryRecord;
  vector: CompressedVector;
  embedding: number[];
  contentHash: string;
  updatedAt: string;
  hits: number;
}

export interface VectorStoreSearchInput {
  query: string;
  queryEmbedding: number[];
  scope: string;
  limit: number;
}

export interface VectorStoreSearchResult extends MemoryRecord {
  score: number;
}

export interface VectorStoreHealth {
  kind: VectorStoreKind;
  ok: boolean;
  collection: string;
  fallbackToFile: boolean;
  message?: string;
}

export interface VectorStoreAdapter {
  kind: VectorStoreKind;
  collection: string;
  fallbackToFile: boolean;
  upsert(items: VectorStoreItem[]): Promise<void>;
  search(input: VectorStoreSearchInput): Promise<VectorStoreSearchResult[]>;
  compact(options: { maxItems: number }): Promise<{ before: number; after: number; removed: number; algorithm: string }>;
  health(): Promise<VectorStoreHealth>;
}

export function vectorStoreConfigFromEnv(env: NodeJS.ProcessEnv = process.env): VectorStoreConfig {
  return {
    kind: parseVectorStoreKind(env.EMILY_VECTOR_STORE),
    baseUrl: env.EMILY_VECTOR_URL,
    collection: env.EMILY_VECTOR_COLLECTION || "agentos_memory",
    connectionStringEnv: env.EMILY_PGVECTOR_CONNECTION_ENV || "DATABASE_URL",
    timeoutMs: numberFromEnv(env.EMILY_VECTOR_TIMEOUT_MS, 5000),
    fallbackToFile: env.EMILY_VECTOR_FALLBACK !== "false",
  };
}

export function createVectorStoreAdapter(config: VectorStoreConfig = {}): VectorStoreAdapter | null {
  const kind = config.kind || "file";
  if (kind === "file") return null;
  const collection = config.collection || "agentos_memory";
  const timeoutMs = config.timeoutMs || 5000;
  const fallbackToFile = config.fallbackToFile !== false;
  if (kind === "chroma") return new ChromaVectorStoreAdapter({ ...config, collection, timeoutMs, fallbackToFile });
  if (kind === "qdrant") return new QdrantVectorStoreAdapter({ ...config, collection, timeoutMs, fallbackToFile });
  if (kind === "milvus") return new MilvusVectorStoreAdapter({ ...config, collection, timeoutMs, fallbackToFile });
  return new PgVectorStoreAdapter({ ...config, collection, timeoutMs, fallbackToFile });
}

class HttpVectorStoreAdapter implements VectorStoreAdapter {
  kind: VectorStoreKind;
  collection: string;
  fallbackToFile: boolean;
  protected baseUrl: string;
  protected timeoutMs: number;

  constructor({ kind, baseUrl, collection, timeoutMs, fallbackToFile }: VectorStoreConfig & {
    kind: VectorStoreKind;
    collection: string;
    timeoutMs: number;
    fallbackToFile: boolean;
  }) {
    this.kind = kind;
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.collection = collection;
    this.timeoutMs = timeoutMs;
    this.fallbackToFile = fallbackToFile;
  }

  async upsert(_items: VectorStoreItem[]): Promise<void> {
    throw new Error(`${this.kind} adapter must implement upsert.`);
  }

  async search(_input: VectorStoreSearchInput): Promise<VectorStoreSearchResult[]> {
    throw new Error(`${this.kind} adapter must implement search.`);
  }

  async compact(_options: { maxItems: number }): Promise<{ before: number; after: number; removed: number; algorithm: string }> {
    return { before: 0, after: 0, removed: 0, algorithm: `${this.kind}:external` };
  }

  async health(): Promise<VectorStoreHealth> {
    if (!this.baseUrl) {
      return {
        kind: this.kind,
        ok: false,
        collection: this.collection,
        fallbackToFile: this.fallbackToFile,
        message: "baseUrl is not configured.",
      };
    }
    try {
      const response = await this.request("GET", this.healthPath(), undefined, { allow404: true });
      return {
        kind: this.kind,
        ok: response.ok,
        collection: this.collection,
        fallbackToFile: this.fallbackToFile,
        message: response.ok ? "reachable" : `health returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        kind: this.kind,
        ok: false,
        collection: this.collection,
        fallbackToFile: this.fallbackToFile,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  protected healthPath(): string {
    return "/";
  }

  protected async request(method: string, urlPath: string, body?: unknown, options: { allow404?: boolean } = {}): Promise<Response> {
    if (!this.baseUrl) throw new Error(`${this.kind} vector store baseUrl is not configured.`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${urlPath}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok && !(options.allow404 && response.status === 404)) {
        const text = await response.text().catch(() => "");
        throw new Error(`${this.kind} vector store HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class QdrantVectorStoreAdapter extends HttpVectorStoreAdapter {
  constructor(config: VectorStoreConfig & { collection: string; timeoutMs: number; fallbackToFile: boolean }) {
    super({ ...config, kind: "qdrant" });
  }

  protected override healthPath(): string {
    return `/collections/${encodeURIComponent(this.collection)}`;
  }

  override async upsert(items: VectorStoreItem[]): Promise<void> {
    if (!items.length) return;
    await this.request("PUT", `/collections/${encodeURIComponent(this.collection)}/points?wait=true`, {
      points: items.map((item) => ({
        id: stableNumericId(item.id),
        vector: item.embedding,
        payload: payloadFromItem(item),
      })),
    });
  }

  override async search(input: VectorStoreSearchInput): Promise<VectorStoreSearchResult[]> {
    const response = await this.request("POST", `/collections/${encodeURIComponent(this.collection)}/points/search`, {
      vector: input.queryEmbedding,
      limit: input.limit,
      with_payload: true,
      filter: {
        must: [{ key: "scope", match: { value: input.scope } }],
      },
    });
    const json = await response.json().catch(() => ({})) as { result?: Array<{ score?: number; payload?: Record<string, unknown> }> };
    return (json.result || []).map((item) => recordFromPayload(item.payload || {}, item.score || 0)).filter(isSearchResult);
  }
}

export class ChromaVectorStoreAdapter extends HttpVectorStoreAdapter {
  constructor(config: VectorStoreConfig & { collection: string; timeoutMs: number; fallbackToFile: boolean }) {
    super({ ...config, kind: "chroma" });
  }

  protected override healthPath(): string {
    return "/api/v1/heartbeat";
  }

  override async upsert(items: VectorStoreItem[]): Promise<void> {
    if (!items.length) return;
    await this.request("POST", `/api/v1/collections/${encodeURIComponent(this.collection)}/upsert`, {
      ids: items.map((item) => item.id),
      embeddings: items.map((item) => item.embedding),
      documents: items.map((item) => item.record.content),
      metadatas: items.map((item) => payloadFromItem(item)),
    });
  }

  override async search(input: VectorStoreSearchInput): Promise<VectorStoreSearchResult[]> {
    const response = await this.request("POST", `/api/v1/collections/${encodeURIComponent(this.collection)}/query`, {
      query_embeddings: [input.queryEmbedding],
      n_results: input.limit,
      where: { scope: input.scope },
    });
    const json = await response.json().catch(() => ({})) as { metadatas?: Record<string, unknown>[][]; distances?: number[][] };
    const metadata = json.metadatas?.[0] || [];
    const distances = json.distances?.[0] || [];
    return metadata.map((item, index) => recordFromPayload(item, distanceToScore(distances[index]))).filter(isSearchResult);
  }
}

export class MilvusVectorStoreAdapter extends HttpVectorStoreAdapter {
  constructor(config: VectorStoreConfig & { collection: string; timeoutMs: number; fallbackToFile: boolean }) {
    super({ ...config, kind: "milvus" });
  }

  protected override healthPath(): string {
    return "/v2/vectordb/collections/list";
  }

  override async upsert(items: VectorStoreItem[]): Promise<void> {
    if (!items.length) return;
    await this.request("POST", "/v2/vectordb/entities/upsert", {
      collectionName: this.collection,
      data: items.map((item) => ({
        id: item.id,
        vector: item.embedding,
        ...payloadFromItem(item),
      })),
    });
  }

  override async search(input: VectorStoreSearchInput): Promise<VectorStoreSearchResult[]> {
    const response = await this.request("POST", "/v2/vectordb/entities/search", {
      collectionName: this.collection,
      data: [input.queryEmbedding],
      limit: input.limit,
      filter: `scope == "${escapeFilterValue(input.scope)}"`,
      outputFields: ["record"],
    });
    const json = await response.json().catch(() => ({})) as { data?: Array<{ distance?: number; record?: unknown }> };
    return (json.data || []).map((item) => recordFromPayload({ record: item.record }, distanceToScore(item.distance))).filter(isSearchResult);
  }
}

export class PgVectorStoreAdapter implements VectorStoreAdapter {
  kind: VectorStoreKind = "pgvector";
  collection: string;
  fallbackToFile: boolean;
  private readonly connectionStringEnv: string;

  constructor(config: VectorStoreConfig & { collection: string; fallbackToFile: boolean }) {
    this.collection = config.collection;
    this.fallbackToFile = config.fallbackToFile;
    this.connectionStringEnv = config.connectionStringEnv || "DATABASE_URL";
  }

  async upsert(): Promise<void> {
    throw new Error(`pgvector adapter requires a database driver bound by the host app via ${this.connectionStringEnv}.`);
  }

  async search(): Promise<VectorStoreSearchResult[]> {
    throw new Error(`pgvector adapter requires a database driver bound by the host app via ${this.connectionStringEnv}.`);
  }

  async compact(): Promise<{ before: number; after: number; removed: number; algorithm: string }> {
    return { before: 0, after: 0, removed: 0, algorithm: "pgvector:external" };
  }

  async health(): Promise<VectorStoreHealth> {
    return {
      kind: "pgvector",
      ok: false,
      collection: this.collection,
      fallbackToFile: this.fallbackToFile,
      message: `No built-in pg driver is bundled; inject a host adapter or configure ${this.connectionStringEnv}.`,
    };
  }
}

function payloadFromItem(item: VectorStoreItem): Record<string, unknown> {
  return {
    id: item.id,
    scope: item.record.scope,
    kind: item.record.kind,
    content: item.record.content,
    record: item.record,
    contentHash: item.contentHash,
    updatedAt: item.updatedAt,
    hits: item.hits,
  };
}

function recordFromPayload(payload: Record<string, unknown>, score: number): VectorStoreSearchResult | null {
  const record = payload.record && typeof payload.record === "object"
    ? payload.record as MemoryRecord
    : {
      id: String(payload.id || ""),
      scope: String(payload.scope || ""),
      kind: String(payload.kind || "note"),
      content: String(payload.content || ""),
      metadata: {},
      createdAt: String(payload.createdAt || new Date().toISOString()),
    };
  if (!record.id || !record.scope || !record.content) return null;
  return { ...record, score };
}

function isSearchResult(value: VectorStoreSearchResult | null): value is VectorStoreSearchResult {
  return Boolean(value);
}

function stableNumericId(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function distanceToScore(distance: unknown): number {
  const number = typeof distance === "number" && Number.isFinite(distance) ? distance : 1;
  return 1 / (1 + Math.max(0, number));
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function parseVectorStoreKind(value: unknown): VectorStoreKind {
  if (value === "chroma" || value === "qdrant" || value === "milvus" || value === "pgvector" || value === "file") return value;
  return "file";
}

function numberFromEnv(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
