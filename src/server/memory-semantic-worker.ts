import { Worker } from 'node:worker_threads';
import type { WorkbenchDatabase } from './database.js';

export type SemanticChunk = {
  id: number;
  documentId: string;
  text: string;
  similarity: number;
};

type SearchResponse = {
  primary: SemanticChunk[];
  context: SemanticChunk[];
  primaryVector: Float32Array;
  primaryLexical: Array<{ id: number; documentId: string; text: string }>;
  contextLexical: Array<{ id: number; documentId: string; text: string }>;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const databases = new Map();
let embedderPromise = null;

function databaseFor(path) {
  let database = databases.get(path);
  if (!database) {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
    databases.set(path, database);
  }
  return database;
}

function cosine(vector, blob) {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  const embedding = new Float32Array(copy.buffer);
  const length = Math.min(vector.length, embedding.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += vector[index] * embedding[index];
    normA += vector[index] * vector[index];
    normB += embedding[index] * embedding[index];
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function top(rows, vector, limit, minimum) {
  if (!vector) return [];
  const scored = [];
  for (const row of rows) {
    const similarity = cosine(vector, row.embedding);
    if (similarity >= minimum) scored.push({ id: row.id, documentId: row.document_id, text: row.text, similarity });
  }
  scored.sort((left, right) => right.similarity - left.similarity);
  return scored.slice(0, limit);
}

function lexical(database, matchQuery, scopeSql, parameters, limit) {
  if (!matchQuery) return [];
  return database.prepare(
    'SELECT memory_chunks.id, memory_chunks.document_id, memory_chunks.text ' +
    'FROM memory_chunks_fts ' +
    'JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.chunk_id ' +
    'JOIN memory_documents md ON md.id = memory_chunks.document_id ' +
    'WHERE memory_chunks_fts MATCH ? ' + scopeSql +
    ' ORDER BY bm25(memory_chunks_fts) LIMIT ' + limit
  ).all(matchQuery, ...parameters).map((row) => ({ id: row.id, documentId: row.document_id, text: row.text }));
}

async function embed(texts) {
  if (!embedderPromise) {
    embedderPromise = import('@huggingface/transformers')
      .then(({ pipeline }) => pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' }));
  }
  const extractor = await embedderPromise;
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return output.tolist().map((row) => Float32Array.from(row));
}

parentPort.on('message', async (request) => {
  try {
    const database = databaseFor(request.databasePath);
    if (request.kind === 'search' || request.kind === 'searchText') {
      const vectors = request.kind === 'searchText' ? await embed(request.queries) : request.vectors;
      const rows = database.prepare(
        'SELECT memory_chunks.id, memory_chunks.document_id, memory_chunks.text, memory_chunks.embedding ' +
        'FROM memory_chunks JOIN memory_documents md ON md.id = memory_chunks.document_id ' +
        'WHERE memory_chunks.embedding IS NOT NULL ' + request.scopeSql
      ).all(...request.parameters);
      parentPort.postMessage({
        id: request.id,
        value: {
          primary: top(rows, vectors[0], request.limit, request.minimum),
          context: top(rows, vectors[1], request.limit, request.minimum),
          primaryVector: vectors[0],
          primaryLexical: lexical(database, request.primaryMatch, request.scopeSql, request.parameters, request.limit),
          contextLexical: lexical(database, request.contextMatch, request.scopeSql, request.parameters, request.limit),
        },
      });
      return;
    }

    const placeholders = request.documentIds.map(() => '?').join(',');
    const rows = request.documentIds.length
      ? database.prepare(
          'SELECT document_id, embedding FROM memory_chunks WHERE embedding IS NOT NULL AND document_id IN (' + placeholders + ')'
        ).all(...request.documentIds)
      : [];
    const best = new Map();
    for (const row of rows) {
      const similarity = cosine(request.vector, row.embedding);
      best.set(row.document_id, Math.max(best.get(row.document_id) ?? -1, similarity));
    }
    parentPort.postMessage({ id: request.id, value: [...best.entries()] });
  } catch (error) {
    parentPort.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, Pending>();

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const next = new Worker(WORKER_SOURCE, { eval: true });
  next.unref();
  next.on('message', (message: { id: number; value?: unknown; error?: string }) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  });
  next.on('error', (error) => {
    if (worker === next) worker = null;
    rejectPending(error);
  });
  next.on('exit', (code) => {
    if (worker === next) worker = null;
    if (code !== 0) rejectPending(new Error(`Memory semantic worker exited with code ${code}.`));
  });
  worker = next;
  return next;
}

function runWorker<T>(message: Record<string, unknown>): Promise<T> {
  const id = ++requestId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    ensureWorker().postMessage({ ...message, id });
  });
}

function databasePath(database: WorkbenchDatabase): string | null {
  return database.location();
}

export async function searchSemanticChunks(
  database: WorkbenchDatabase,
  vectors: Float32Array[],
  scopeSql: string,
  parameters: string[],
  limit: number,
  minimum: number,
): Promise<SearchResponse> {
  const path = databasePath(database);
  if (!path) return searchSemanticChunksInline(database, vectors, scopeSql, parameters, limit, minimum);
  return runWorker<SearchResponse>({ kind: 'search', databasePath: path, vectors, scopeSql, parameters, limit, minimum, primaryMatch: null, contextMatch: null });
}

export async function searchSemanticTexts(
  database: WorkbenchDatabase,
  queries: string[],
  scopeSql: string,
  parameters: string[],
  limit: number,
  minimum: number,
  primaryMatch: string | null,
  contextMatch: string | null,
): Promise<SearchResponse> {
  const path = databasePath(database);
  if (!path) throw new Error('Text embedding worker requires a file-backed database.');
  return runWorker<SearchResponse>({ kind: 'searchText', databasePath: path, queries, scopeSql, parameters, limit, minimum, primaryMatch, contextMatch });
}

export async function scoreSemanticDocuments(
  database: WorkbenchDatabase,
  vector: Float32Array,
  documentIds: string[],
): Promise<Map<string, number>> {
  if (!documentIds.length) return new Map();
  const path = databasePath(database);
  if (!path) return scoreSemanticDocumentsInline(database, vector, documentIds);
  const entries = await runWorker<Array<[string, number]>>({ kind: 'documents', databasePath: path, vector, documentIds });
  return new Map(entries);
}

function cosine(vector: Float32Array, blob: Uint8Array): number {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  const embedding = new Float32Array(copy.buffer);
  const length = Math.min(vector.length, embedding.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += vector[index] * embedding[index];
    normA += vector[index] * vector[index];
    normB += embedding[index] * embedding[index];
  }
  return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function searchSemanticChunksInline(
  database: WorkbenchDatabase,
  vectors: Float32Array[],
  scopeSql: string,
  parameters: string[],
  limit: number,
  minimum: number,
): SearchResponse {
  const rows = database.prepare(`
    SELECT memory_chunks.id, memory_chunks.document_id, memory_chunks.text, memory_chunks.embedding
    FROM memory_chunks JOIN memory_documents md ON md.id = memory_chunks.document_id
    WHERE memory_chunks.embedding IS NOT NULL ${scopeSql}
  `).all(...parameters) as Array<{ id: number; document_id: string; text: string; embedding: Uint8Array }>;
  const rank = (vector: Float32Array | undefined): SemanticChunk[] => vector
    ? rows.map((row) => ({ id: row.id, documentId: row.document_id, text: row.text, similarity: cosine(vector, row.embedding) }))
      .filter((row) => row.similarity >= minimum)
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, limit)
    : [];
  return { primary: rank(vectors[0]), context: rank(vectors[1]), primaryVector: vectors[0], primaryLexical: [], contextLexical: [] };
}

function scoreSemanticDocumentsInline(database: WorkbenchDatabase, vector: Float32Array, documentIds: string[]): Map<string, number> {
  const placeholders = documentIds.map(() => '?').join(',');
  const rows = database.prepare(`SELECT document_id, embedding FROM memory_chunks
    WHERE embedding IS NOT NULL AND document_id IN (${placeholders})`).all(...documentIds) as Array<{ document_id: string; embedding: Uint8Array }>;
  const best = new Map<string, number>();
  for (const row of rows) best.set(row.document_id, Math.max(best.get(row.document_id) ?? -1, cosine(vector, row.embedding)));
  return best;
}

export function shutdownMemorySemanticWorker(): void {
  const current = worker;
  worker = null;
  if (current) void current.terminate();
  rejectPending(new Error('Memory semantic worker stopped during runtime shutdown.'));
}
