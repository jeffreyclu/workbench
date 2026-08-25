import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from '@huggingface/transformers';
import type { WorkbenchDatabase } from './database.js';
import { buildFtsMatchQuery } from './fts-query.js';

/**
 * Vectorized, hybrid retrieval over the complete durable Workbench record
 * (migration 031_memory_index in database.ts). Three stages:
 *
 *  1. `collectMemoryDocuments` upserts one row per durable record (a message,
 *     an activity entry, an agent-run prompt/response/error, an audit entry,
 *     a work item, a doc page) into `memory_documents`, keyed by
 *     (source, source_id) with a content hash so unchanged rows are a no-op.
 *  2. `indexPendingMemory` chunks and embeds whatever has never been embedded
 *     or just changed (`indexed_at IS NULL`), writing `memory_chunks` (+ the
 *     FTS5 mirror kept in sync by triggers, same convention as
 *     conversations_fts/messages_fts).
 *  3. `searchMemory` fuses an FTS5 BM25 ranking with a brute-force cosine
 *     ranking over the embedded chunks via Reciprocal Rank Fusion.
 */

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBED_BATCH_SIZE = 32;
// Keep a wider pre-dedup pool than the API response cap. Long conversations can
// occupy many high-ranking chunks; document-level dedup needs enough candidates
// to still surface distinct conversations, activities, and docs.
export const MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE = 400;

export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

let embedderOverride: Embedder | null = null;

/**
 * Tests must never download or run the real model. Call this with a
 * deterministic stub before exercising anything that embeds text, and reset
 * it to `null` afterward so the override does not leak across test files.
 */
export function setEmbedder(embedder: Embedder | null): void {
  embedderOverride = embedder;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelinePromise: Promise<any> | null = null;

async function loadPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' });
  }
  return pipelinePromise;
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (embedderOverride) return embedderOverride(texts);

  const extractor = await loadPipeline();
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    const rows = output.tolist() as number[][];
    for (const row of rows) vectors.push(Float32Array.from(row));
  }
  return vectors;
}

/** BLOB round-trip for a chunk's embedding column. */
export function embeddingToBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * Copies into a fresh, aligned buffer rather than viewing the driver's bytes
 * directly: a BLOB read back from node:sqlite is not guaranteed to start at a
 * 4-byte-aligned offset, and Float32Array requires that alignment.
 */
export function blobToEmbedding(blob: Uint8Array): Float32Array {
  const aligned = new Uint8Array(blob.byteLength);
  aligned.set(blob);
  return new Float32Array(aligned.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reciprocal Rank Fusion: score(id) = sum over lists of 1 / (k + rank), rank
 * 1-based. Standard way to combine independently-ranked retrieval lists
 * (here: FTS5 BM25 order and cosine-similarity order) without having to
 * reconcile their incomparable raw scores.
 */
export function reciprocalRankFusion(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      const contribution = 1 / (k + index + 1);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
    });
  }
  return scores;
}

const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 150;
// How far back from the target chunk end a paragraph/line break is still
// preferred over a hard cut at exactly CHUNK_SIZE characters.
const BOUNDARY_WINDOW = 200;

/** Splits text into ~1200-char chunks with 150-char overlap, preferring to
 * break on a paragraph or line boundary near the target length. Never emits
 * an empty chunk. */
export function chunkText(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= CHUNK_SIZE) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + CHUNK_SIZE, normalized.length);
    if (end < normalized.length) {
      const windowStart = Math.max(start + CHUNK_SIZE - BOUNDARY_WINDOW, start);
      const paragraphBreak = normalized.lastIndexOf('\n\n', end);
      const lineBreak = normalized.lastIndexOf('\n', end);
      if (paragraphBreak > windowStart) end = paragraphBreak;
      else if (lineBreak > windowStart) end = lineBreak;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    // Guarantees start strictly advances even if the boundary search above
    // picked an `end` no further than the overlap window, so the loop always
    // terminates.
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

type CandidateDocument = {
  source: string;
  sourceId: string;
  conversationId: string | null;
  workItemId: string | null;
  actor: string | null;
  title: string;
  body: string;
  createdAt: string;
};

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && extname(entry.name) === '.md') found.push(full);
    }
  };
  walk(root);
  return found;
}

function collectDocCandidates(label: string, docsRoot: string): CandidateDocument[] {
  const candidates: CandidateDocument[] = [];
  for (const file of listMarkdownFiles(docsRoot)) {
    const body = readFileSync(file, 'utf8');
    if (!nonEmpty(body)) continue;
    // Namespaced by root label: two roots (e.g. this repo's docs/ and the
    // shared ~/notes knowledge base) can otherwise share a relative path and
    // collide on the same (source, source_id) key.
    const sourceId = `${label}:${relative(docsRoot, file)}`;
    const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
    candidates.push({
      source: 'doc', sourceId, conversationId: null, workItemId: null, actor: null,
      title: heading || sourceId, body, createdAt: statSync(file).mtime.toISOString(),
    });
  }
  return candidates;
}

/**
 * Upserts one memory_documents row per durable record from every source
 * Jeffrey wants captured: shared messages, shared conversations, task
 * activity, agent-run prompts/responses/errors (as three independent
 * documents so a prompt is retrievable without its response), the audit log,
 * work items, repo markdown under docs/, and the shared cross-tool knowledge
 * base under ~/notes (durable facts recorded outside Workbench's own tables,
 * e.g. by Codex). Skips null/empty bodies.
 *
 * Existing (source, source_id) hashes are fetched once up front so this is a
 * handful of full-table scans plus writes only for rows that are new or whose
 * content actually changed -- not a write per row on every call.
 */
export function collectMemoryDocuments(
  database: WorkbenchDatabase,
  options: { docsRoot?: string; docRoots?: Array<{ label: string; path: string }> } = {},
): { upserted: number } {
  const candidates: CandidateDocument[] = [];

  const messageRows = database.prepare(`
    SELECT m.id AS id, m.conversation_id AS conversation_id, m.author AS author, m.body AS body, m.created_at AS created_at,
           COALESCE(c.title, 'Conversation') AS conversation_title, c.work_item_id AS work_item_id
    FROM shared_messages m LEFT JOIN shared_conversations c ON c.id = m.conversation_id
    WHERE (c.deleted_at IS NULL OR c.id IS NULL)
  `).all() as Array<{ id: string; conversation_id: string | null; author: string; body: string; created_at: string; conversation_title: string; work_item_id: string | null }>;
  for (const row of messageRows) {
    if (!nonEmpty(row.body)) continue;
    candidates.push({
      source: 'message', sourceId: row.id, conversationId: row.conversation_id, workItemId: row.work_item_id,
      actor: row.author, title: row.conversation_title, body: row.body, createdAt: row.created_at,
    });
  }

  const conversationRows = database.prepare(`
    SELECT id, title, created_at, work_item_id FROM shared_conversations WHERE deleted_at IS NULL
  `).all() as Array<{ id: string; title: string; created_at: string; work_item_id: string | null }>;
  for (const row of conversationRows) {
    if (!nonEmpty(row.title)) continue;
    candidates.push({
      source: 'conversation', sourceId: row.id, conversationId: row.id, workItemId: row.work_item_id,
      actor: null, title: row.title, body: row.title, createdAt: row.created_at,
    });
  }

  const activityRows = database.prepare(`
    SELECT a.id AS id, a.work_item_id AS work_item_id, a.actor AS actor, a.body AS body, a.created_at AS created_at, w.title AS work_item_title
    FROM activities a JOIN work_items w ON w.id = a.work_item_id
    WHERE w.deleted_at IS NULL
  `).all() as Array<{ id: string; work_item_id: string; actor: string; body: string; created_at: string; work_item_title: string }>;
  for (const row of activityRows) {
    if (!nonEmpty(row.body)) continue;
    candidates.push({
      source: 'activity', sourceId: row.id, conversationId: null, workItemId: row.work_item_id,
      actor: row.actor, title: row.work_item_title, body: row.body, createdAt: row.created_at,
    });
  }

  const runRows = database.prepare(`
    SELECT r.id AS id, r.work_item_id AS work_item_id, r.conversation_id AS conversation_id,
           COALESCE(r.requested_agent, r.agent) AS actor, r.instructions AS instructions, r.output AS output, r.error AS error,
           r.created_at AS created_at, w.title AS work_item_title
    FROM agent_runs r JOIN work_items w ON w.id = r.work_item_id
    WHERE w.deleted_at IS NULL
  `).all() as Array<{ id: string; work_item_id: string; conversation_id: string | null; actor: string; instructions: string; output: string; error: string; created_at: string; work_item_title: string }>;
  for (const row of runRows) {
    const base = { conversationId: row.conversation_id, workItemId: row.work_item_id, actor: row.actor, title: row.work_item_title, createdAt: row.created_at };
    if (nonEmpty(row.instructions)) candidates.push({ ...base, source: 'run_instructions', sourceId: `${row.id}:instructions`, body: row.instructions });
    if (nonEmpty(row.output)) candidates.push({ ...base, source: 'run_output', sourceId: `${row.id}:output`, body: row.output });
    if (nonEmpty(row.error)) candidates.push({ ...base, source: 'run_error', sourceId: `${row.id}:error`, body: row.error });
  }

  const auditRows = database.prepare(`
    SELECT a.id AS id, a.work_item_id AS work_item_id, a.source AS actor, a.category AS category, a.detail AS detail, a.created_at AS created_at,
           COALESCE(w.title, 'Workbench API') AS title
    FROM audit_log a LEFT JOIN work_items w ON w.id = a.work_item_id
  `).all() as Array<{ id: string; work_item_id: string | null; actor: string; category: string; detail: string; created_at: string; title: string }>;
  for (const row of auditRows) {
    if (!nonEmpty(row.detail)) continue;
    candidates.push({
      source: 'audit', sourceId: row.id, conversationId: null, workItemId: row.work_item_id,
      actor: row.actor, title: row.title, body: `${row.category}: ${row.detail}`, createdAt: row.created_at,
    });
  }

  const workItemRows = database.prepare(`
    SELECT id, title, description, created_at FROM work_items WHERE deleted_at IS NULL
  `).all() as Array<{ id: string; title: string; description: string; created_at: string }>;
  for (const row of workItemRows) {
    if (!nonEmpty(row.title)) continue;
    candidates.push({
      source: 'work_item', sourceId: row.id, conversationId: null, workItemId: row.id, actor: null,
      title: row.title, body: nonEmpty(row.description) ? `${row.title}\n\n${row.description}` : row.title, createdAt: row.created_at,
    });
  }

  const roots = options.docRoots ?? [
    { label: 'workbench-docs', path: options.docsRoot ?? resolve(process.cwd(), 'docs') },
    { label: 'notes', path: resolve(homedir(), 'notes') },
  ];
  for (const root of roots) candidates.push(...collectDocCandidates(root.label, root.path));

  return upsertMemoryDocuments(database, candidates);
}

function upsertMemoryDocuments(database: WorkbenchDatabase, candidates: CandidateDocument[]): { upserted: number } {
  if (!candidates.length) return { upserted: 0 };

  const existing = database.prepare('SELECT source, source_id, content_hash, conversation_id, work_item_id, actor, created_at FROM memory_documents').all() as Array<{
    source: string; source_id: string; content_hash: string; conversation_id: string | null; work_item_id: string | null; actor: string | null; created_at: string;
  }>;
  const existingDocuments = new Map(existing.map((row) => [`${row.source}::${row.source_id}`, row]));

  const insert = database.prepare(`
    INSERT INTO memory_documents (id, source, source_id, conversation_id, work_item_id, actor, title, body, created_at, content_hash, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(source, source_id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      work_item_id = excluded.work_item_id,
      actor = excluded.actor,
      title = excluded.title,
      body = excluded.body,
      created_at = excluded.created_at,
      content_hash = excluded.content_hash,
      indexed_at = NULL
  `);
  // On a hash change the old chunks describe stale text; the new insert
  // above resets indexed_at to NULL so indexPendingMemory re-chunks and
  // re-embeds it, but the previous chunk rows have to be cleared explicitly
  // first since the document row itself is not being deleted (ON DELETE
  // CASCADE does not fire on an UPDATE).
  const clearChunks = database.prepare('DELETE FROM memory_chunks WHERE document_id = (SELECT id FROM memory_documents WHERE source = ? AND source_id = ?)');
  const updateMetadata = database.prepare(`
    UPDATE memory_documents SET conversation_id = ?, work_item_id = ?, actor = ?, created_at = ?
    WHERE source = ? AND source_id = ?
  `);

  let upserted = 0;
  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const candidate of candidates) {
      const hash = createHash('sha256').update(`${candidate.title}::${candidate.body}`).digest('hex');
      const key = `${candidate.source}::${candidate.sourceId}`;
      const previous = existingDocuments.get(key);
      if (previous?.content_hash === hash) {
        if (previous.conversation_id !== candidate.conversationId
          || previous.work_item_id !== candidate.workItemId
          || previous.actor !== candidate.actor
          || previous.created_at !== candidate.createdAt) {
          updateMetadata.run(candidate.conversationId, candidate.workItemId, candidate.actor, candidate.createdAt, candidate.source, candidate.sourceId);
          upserted += 1;
        }
        continue;
      }
      if (previous !== undefined) clearChunks.run(candidate.source, candidate.sourceId);
      insert.run(
        randomUUID(), candidate.source, candidate.sourceId, candidate.conversationId, candidate.workItemId,
        candidate.actor, candidate.title, candidate.body, candidate.createdAt, hash,
      );
      upserted += 1;
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  return { upserted };
}

/**
 * Chunks and embeds every memory_documents row that is new or changed
 * (indexed_at IS NULL), writing memory_chunks (the FTS mirror follows via
 * trigger) and stamping indexed_at. Idempotent and safe to call repeatedly:
 * a document already indexed is not touched again until collectMemoryDocuments
 * next detects its content changed.
 */
export async function indexPendingMemory(database: WorkbenchDatabase, options: { limit?: number } = {}): Promise<{ documents: number; chunks: number }> {
  const limit = Math.max(1, Math.min(5_000, options.limit ?? 500));
  const pending = database.prepare('SELECT id, body FROM memory_documents WHERE indexed_at IS NULL ORDER BY created_at DESC LIMIT ?').all(limit) as Array<{ id: string; body: string }>;
  if (!pending.length) return { documents: 0, chunks: 0 };

  const documentChunks = pending.map((doc) => ({ documentId: doc.id, chunks: chunkText(doc.body) }));
  const allChunkTexts = documentChunks.flatMap((entry) => entry.chunks);

  let embeddings: Array<Float32Array | null> = allChunkTexts.map(() => null);
  if (allChunkTexts.length) {
    try {
      embeddings = await embedTexts(allChunkTexts);
    } catch (error) {
      // Embedding is a best-effort enrichment on top of full-text search: a
      // model failure must not stop the text itself from becoming
      // retrievable, so the chunks are still written below, just without a
      // vector (FTS-only until the next successful pass re-embeds them).
      console.error('[memory-index] embedding failed; indexing text without vectors', error);
    }
  }

  const deleteChunks = database.prepare('DELETE FROM memory_chunks WHERE document_id = ?');
  const insertChunk = database.prepare('INSERT INTO memory_chunks (document_id, ordinal, text, embedding, model, dims) VALUES (?, ?, ?, ?, ?, ?)');
  const markIndexed = database.prepare('UPDATE memory_documents SET indexed_at = ? WHERE id = ?');
  const indexedAt = new Date().toISOString();

  let cursor = 0;
  let chunkCount = 0;
  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const entry of documentChunks) {
      deleteChunks.run(entry.documentId);
      entry.chunks.forEach((text, ordinal) => {
        const vector = embeddings[cursor];
        cursor += 1;
        insertChunk.run(entry.documentId, ordinal, text, vector ? embeddingToBlob(vector) : null, vector ? EMBEDDING_MODEL : null, vector ? vector.length : null);
        chunkCount += 1;
      });
      markIndexed.run(indexedAt, entry.documentId);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  return { documents: pending.length, chunks: chunkCount };
}

export type MemorySearchResult = {
  source: string;
  sourceId: string;
  title: string;
  snippet: string;
  createdAt: string;
  conversationId: string | null;
  workItemId: string | null;
  actor: string | null;
  score: number;
};

type MemoryDocumentRow = {
  id: string; source: string; source_id: string; conversation_id: string | null; work_item_id: string | null;
  actor: string | null; title: string; body: string; created_at: string;
};

/**
 * Hybrid retrieval: FTS5 BM25 (top 400) fused with brute-force cosine
 * similarity over embedded chunks (top 400) via Reciprocal Rank Fusion,
 * grouped to document level keeping the best-scoring chunk as the snippet.
 * Never throws on the embedding side -- a model failure or an empty
 * embeddings table just falls back to the FTS ranking alone.
 */
export async function searchMemory(database: WorkbenchDatabase, query: string, options: { limit?: number; sources?: string[]; projectKey?: string } = {}): Promise<MemorySearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const limit = Math.max(1, Math.min(100, options.limit ?? 20));
  const sourceFilter = options.sources && options.sources.length ? new Set(options.sources) : null;

  const matchQuery = buildFtsMatchQuery(trimmed);
  const ftsRows = matchQuery
    ? database.prepare(`
        SELECT memory_chunks.id AS chunk_id, memory_chunks.document_id AS document_id, memory_chunks.text AS text
        FROM memory_chunks_fts
        JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.chunk_id
        WHERE memory_chunks_fts MATCH ?
        ORDER BY bm25(memory_chunks_fts)
        LIMIT ${MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE}
      `).all(matchQuery) as Array<{ chunk_id: number; document_id: string; text: string }>
    : [];

  let vectorRows: Array<{ chunk_id: number; document_id: string; text: string; score: number }> = [];
  try {
    const [queryVector] = await embedTexts([trimmed]);
    if (queryVector) {
      const embedded = database.prepare('SELECT id, document_id, text, embedding FROM memory_chunks WHERE embedding IS NOT NULL').all() as Array<{ id: number; document_id: string; text: string; embedding: Uint8Array }>;
      vectorRows = embedded
        .map((row) => ({ chunk_id: row.id, document_id: row.document_id, text: row.text, score: cosineSimilarity(queryVector, blobToEmbedding(row.embedding)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE);
    }
  } catch (error) {
    console.error('[memory-index] embedding query failed; falling back to full-text results only', error);
  }

  const chunkById = new Map<string, { documentId: string; text: string }>();
  for (const row of ftsRows) chunkById.set(String(row.chunk_id), { documentId: row.document_id, text: row.text });
  for (const row of vectorRows) chunkById.set(String(row.chunk_id), { documentId: row.document_id, text: row.text });

  const fused = reciprocalRankFusion([ftsRows.map((row) => String(row.chunk_id)), vectorRows.map((row) => String(row.chunk_id))]);
  if (!fused.size) return [];

  const bestByDocument = new Map<string, { chunkId: string; score: number }>();
  for (const [chunkId, score] of fused) {
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue;
    const current = bestByDocument.get(chunk.documentId);
    if (!current || score > current.score) bestByDocument.set(chunk.documentId, { chunkId, score });
  }
  if (!bestByDocument.size) return [];

  const documentIds = [...bestByDocument.keys()];
  const placeholders = documentIds.map(() => '?').join(',');
  // Project scope belongs at retrieval, before score sorting and prompt
  // selection. Otherwise unrelated high-frequency transcripts can displace
  // the linked project's evidence before it has a chance to be deduplicated.
  const projectKey = options.projectKey?.trim() || null;
  const documents = database.prepare(`
    SELECT * FROM memory_documents
    WHERE id IN (${placeholders})
      AND (? IS NULL OR work_item_id IN (
        SELECT id FROM work_items WHERE project_key = ? AND deleted_at IS NULL
      ))
  `).all(...documentIds, projectKey, projectKey) as MemoryDocumentRow[];
  const documentById = new Map(documents.map((doc) => [doc.id, doc]));

  const results: MemorySearchResult[] = [];
  for (const [documentId, best] of bestByDocument) {
    const doc = documentById.get(documentId);
    if (!doc) continue;
    if (sourceFilter && !sourceFilter.has(doc.source)) continue;
    const chunk = chunkById.get(best.chunkId);
    results.push({
      source: doc.source, sourceId: doc.source_id, title: doc.title, snippet: chunk?.text ?? doc.body.slice(0, 1_200),
      createdAt: doc.created_at, conversationId: doc.conversation_id, workItemId: doc.work_item_id, actor: doc.actor, score: best.score,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
