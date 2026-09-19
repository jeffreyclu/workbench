import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from '@huggingface/transformers';
import type { WorkbenchDatabase } from './database.js';
import { buildFtsMatchQuery } from './fts-query.js';
import { expandKnowledgeGraph } from './knowledge-graph.js';
import { scoreSemanticDocuments, searchSemanticChunks, searchSemanticTexts } from './memory-semantic-worker.js';

/**
 * Vectorized, hybrid retrieval over the complete durable Workbench record
 * (migration 031_memory_index in database.ts). Three stages:
 *
 *  1. `collectMemoryDocuments` upserts one row per durable record (a message,
 *     an activity entry, an agent-run prompt/response/error, a work item, a
 *     published artifact, or a doc page) into
 *     `memory_documents`, keyed by
 *     (source, source_id) with a content hash so unchanged rows are a no-op.
 *  2. `indexPendingMemory` chunks and embeds whatever has never been embedded
 *     or just changed (`indexed_at IS NULL`), writing `memory_chunks` (+ the
 *     FTS5 mirror kept in sync by triggers, same convention as
 *     conversations_fts/messages_fts).
 *  3. `searchMemory` combines FTS5 BM25 rank, lexical coverage, and calibrated
 *     cosine similarity while keeping task-title context weaker than the
 *     user's exact request.
 */

export const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBED_BATCH_SIZE = 32;
// Keep a wider pre-dedup pool than the API response cap. Long conversations can
// occupy many high-ranking chunks; document-level dedup needs enough candidates
// to still surface distinct conversations, activities, and docs.
export const MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE = 400;

export type MemorySearchOptions = {
  limit?: number;
  sources?: string[];
  projectKey?: string;
  conversationId?: string;
  workItemId?: string;
  excludeConversationId?: string;
  excludeGeneratedConversationId?: string;
  excludeExactBody?: string;
  importanceProfile?: 'default' | 'personal';
};

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

function memoryScopeClause(options: MemorySearchOptions, alias: string): { sql: string; parameters: string[] } {
  // Operational audit rows may still exist during compatibility cleanup, but
  // they are never memory candidates. Apply this before lexical and exhaustive
  // semantic ranking rather than filtering returned results afterward.
  const clauses: string[] = [`${alias}.source <> 'audit'`];
  const parameters: string[] = [];
  const projectKey = options.projectKey?.trim();
  const conversationId = options.conversationId?.trim();
  const workItemId = options.workItemId?.trim();
  const sources = [...new Set(options.sources?.filter(nonEmpty) ?? [])];
  if (projectKey) {
    clauses.push(`${alias}.work_item_id IN (SELECT id FROM work_items WHERE project_key = ? AND deleted_at IS NULL)`);
    parameters.push(projectKey);
  }
  if (conversationId) {
    clauses.push(`${alias}.conversation_id = ?`);
    parameters.push(conversationId);
  }
  if (workItemId) {
    clauses.push(`${alias}.work_item_id = ?`);
    parameters.push(workItemId);
  }
  if (sources.length) {
    clauses.push(`${alias}.source IN (${sources.map(() => '?').join(',')})`);
    parameters.push(...sources);
  }
  return { sql: clauses.length ? `AND ${clauses.join(' AND ')}` : '', parameters };
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
 * documents so a prompt is retrievable without its response), work items,
 * repo markdown under docs/, and the shared cross-tool knowledge
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

  const artifactRows = database.prepare(`
    SELECT id, title, source_path, public_url, published_at, work_item_id, conversation_id
    FROM published_artifacts WHERE revoked_at IS NULL
  `).all() as Array<{ id: string; title: string; source_path: string; public_url: string; published_at: string; work_item_id: string | null; conversation_id: string | null }>;
  for (const row of artifactRows) {
    candidates.push({
      source: 'artifact', sourceId: row.id, conversationId: row.conversation_id, workItemId: row.work_item_id, actor: null,
      title: row.title, body: [row.title, row.source_path, row.public_url].filter(Boolean).join('\n'), createdAt: row.published_at,
    });
  }

  const roots = options.docRoots ?? [
    { label: 'workbench-docs', path: options.docsRoot ?? resolve(process.cwd(), 'docs') },
    { label: 'notes', path: resolve(homedir(), 'notes') },
  ];
  for (const root of roots) candidates.push(...collectDocCandidates(root.label, root.path));

  return upsertMemoryDocuments(database, candidates, new Set(['artifact']));
}

function upsertMemoryDocuments(
  database: WorkbenchDatabase,
  candidates: CandidateDocument[],
  pruneSources: ReadonlySet<string> = new Set(),
): { upserted: number } {
  const existing = database.prepare("SELECT source, source_id, content_hash, conversation_id, work_item_id, actor, created_at FROM memory_documents WHERE source <> 'audit'").all() as Array<{
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
  const deleteDocument = database.prepare('DELETE FROM memory_documents WHERE source = ? AND source_id = ?');
  const updateMetadata = database.prepare(`
    UPDATE memory_documents SET conversation_id = ?, work_item_id = ?, actor = ?, created_at = ?
    WHERE source = ? AND source_id = ?
  `);

  let upserted = 0;
  database.exec('BEGIN IMMEDIATE;');
  try {
    const candidateKeys = new Set(candidates.map((candidate) => `${candidate.source}::${candidate.sourceId}`));
    for (const row of existing) {
      if (pruneSources.has(row.source) && !candidateKeys.has(`${row.source}::${row.source_id}`)) {
        deleteDocument.run(row.source, row.source_id);
      }
    }
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
  const pending = database.prepare("SELECT id, body FROM memory_documents WHERE indexed_at IS NULL AND source <> 'audit' ORDER BY created_at DESC LIMIT ?").all(limit) as Array<{ id: string; body: string }>;
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

/** One bounded compatibility-cleanup slice. Small transactions keep startup
 * and conversation requests responsive while the old audit-derived memory
 * projection is removed from an upgraded database. */
export function pruneLegacyAuditMemoryBatch(database: WorkbenchDatabase, batchSize = 200): { documents: number; graphNodes: number } {
  const safeBatchSize = Math.max(1, Math.min(1_000, batchSize));
  const documents = Number(database.prepare(`DELETE FROM memory_documents WHERE id IN (
    SELECT id FROM memory_documents WHERE source = 'audit' LIMIT ?
  )`).run(safeBatchSize).changes);
  const graphNodes = Number(database.prepare(`DELETE FROM knowledge_graph_nodes WHERE id IN (
    SELECT id FROM knowledge_graph_nodes WHERE entity_type = 'audit' LIMIT ?
  )`).run(safeBatchSize).changes);
  return { documents, graphNodes };
}

export async function pruneLegacyAuditMemory(database: WorkbenchDatabase, batchSize = 200): Promise<{ documents: number; graphNodes: number }> {
  void batchSize;
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
  if (!database.isOpen) return { documents: 0, graphNodes: 0 };
  const documents = Number((database.prepare("SELECT COUNT(*) AS count FROM memory_documents WHERE source = 'audit'").get() as { count: number }).count);
  const graphNodes = Number((database.prepare("SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE entity_type = 'audit'").get() as { count: number }).count);
  if (!documents && !graphNodes) return { documents, graphNodes };

  // Deleting audit chunks through the normal FTS trigger performs one FTS
  // lookup per chunk and takes tens of minutes at the current corpus size.
  // Rebuild the standalone FTS mirror once inside one WAL transaction instead:
  // readers keep seeing the prior committed index until the replacement is
  // complete, and no request thread performs this work.
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS memory_chunks_fts_ai;
      DROP TRIGGER IF EXISTS memory_chunks_fts_au;
      DROP TRIGGER IF EXISTS memory_chunks_fts_ad;
      DELETE FROM memory_chunks_fts;
      DELETE FROM memory_chunks WHERE document_id IN (SELECT id FROM memory_documents WHERE source = 'audit');
      DELETE FROM memory_documents WHERE source = 'audit';
      DELETE FROM knowledge_graph_nodes WHERE entity_type = 'audit';
      INSERT INTO memory_chunks_fts(chunk_id, text) SELECT id, text FROM memory_chunks;
      CREATE TRIGGER memory_chunks_fts_ai AFTER INSERT ON memory_chunks BEGIN
        INSERT INTO memory_chunks_fts(chunk_id, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER memory_chunks_fts_au AFTER UPDATE ON memory_chunks BEGIN
        DELETE FROM memory_chunks_fts WHERE chunk_id = old.id;
        INSERT INTO memory_chunks_fts(chunk_id, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER memory_chunks_fts_ad AFTER DELETE ON memory_chunks BEGIN
        DELETE FROM memory_chunks_fts WHERE chunk_id = old.id;
      END;
    `);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  return { documents, graphNodes };
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
  retrievalPath: string[];
};

type MemoryDocumentRow = {
  id: string; source: string; source_id: string; conversation_id: string | null; work_item_id: string | null;
  actor: string | null; title: string; body: string; created_at: string;
};

const SOURCE_AUTHORITY: Readonly<Record<string, number>> = {
  artifact: 1.12,
  doc: 1.1,
  activity: 1.08,
  work_item: 1.08,
  message: 1.04,
  conversation: 1,
  run_output: 0.98,
  run_instructions: 0.95,
  run_error: 0.92,
};

const QUERY_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before', 'but', 'can', 'context',
  'did', 'does', 'for', 'from', 'has', 'have', 'into', 'its', 'more', 'most', 'not', 'our', 'prior',
  'relevant', 'should', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'through', 'use', 'was',
  'were', 'what', 'when', 'where', 'which', 'with', 'work', 'would', 'your',
]);

const MIN_SEMANTIC_SIMILARITY = 0.35;
const MIN_DIRECT_RELEVANCE = 0.12;
const RELATIVE_RELEVANCE_FLOOR = 0.42;
const SHORTHAND_REQUEST = /^(?:continue|do it|go ahead|proceed|yes|yep|okay|ok|build|fix it|ship it|run it|promote)[.!\s]*$/i;
const CONTEXT_REFERENTIAL_REQUEST = /\b(?:this|that|these|those|it|the (?:purpose|prototype|plan|approach|solution|fix|design|implementation|work|task|issue|problem))\b/i;

function significantTerms(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length >= 3 && !QUERY_STOP_WORDS.has(term)));
}

function memoryQueryParts(query: string): { primary: string; context: string } {
  const lines = query.split('\n').map((line) => line.trim()).filter(nonEmpty);
  const primary = lines[0] ?? '';
  const seen = new Set([primary.replace(/\s+/g, ' ').toLocaleLowerCase()]);
  const context = lines.slice(1).filter((line) => {
    const key = line.replace(/\s+/g, ' ').toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join('\n');
  return { primary, context };
}

function normalizedMemoryBody(value: string): string {
  return value
    .replace(/^(?:execute|to (?:codex|claude|palmyra)(?: and (?:codex|claude|palmyra))?(?: · [^:]+)?):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function lexicalCoverage(text: string, query: string): number {
  const queryTerms = significantTerms(query);
  if (!queryTerms.size) return 0;
  const textTerms = significantTerms(text);
  let matches = 0;
  for (const term of queryTerms) if (textTerms.has(term)) matches += 1;
  return matches / queryTerms.size;
}

function rankStrength(rank: number | undefined): number {
  return rank === undefined ? 0 : 61 / (61 + rank);
}

function semanticStrength(similarity: number | undefined): number {
  if (similarity === undefined || similarity < MIN_SEMANTIC_SIMILARITY) return 0;
  return Math.min(1, (similarity - MIN_SEMANTIC_SIMILARITY) / (1 - MIN_SEMANTIC_SIMILARITY));
}

function combinedChannelScore(lexicalRank: number | undefined, semanticSimilarity: number | undefined, coverage: number): number {
  const lexical = rankStrength(lexicalRank) * Math.pow(coverage, 0.65);
  const semantic = semanticStrength(semanticSimilarity);
  return (0.58 * lexical) + (0.42 * semantic) + (0.12 * Math.min(lexical, semantic));
}

/**
 * Durable-memory queries include the user's words plus task/project context
 * and a short recall hint. Requiring every word would make FTS nearly empty;
 * OR lets BM25 reward chunks that match several significant terms while the
 * database scope remains an independent hard boundary.
 */
export function buildMemoryFtsMatchQuery(query: string): string | null {
  const terms = [...significantTerms(query)].slice(0, 32);
  if (!terms.length) return buildFtsMatchQuery(query);
  return terms.map((term) => buildFtsMatchQuery(term)).filter(nonEmpty).join(' OR ') || null;
}

function lexicalImportanceMultiplier(document: MemoryDocumentRow, query: string): number {
  const primaryQuery = query.split('\n', 1)[0]?.trim().toLocaleLowerCase() ?? '';
  if (!primaryQuery) return 1;
  const searchable = `${document.title}\n${document.body}`.toLocaleLowerCase();
  const queryTerms = significantTerms(primaryQuery);
  const documentTerms = significantTerms(searchable);
  let overlap = 0;
  for (const term of queryTerms) if (documentTerms.has(term)) overlap += 1;
  const coverageBoost = queryTerms.size ? Math.min(0.12, (overlap / queryTerms.size) * 0.12) : 0;
  const phraseBoost = primaryQuery.length >= 8 && searchable.includes(primaryQuery) ? 0.08 : 0;
  return 1 + coverageBoost + phraseBoost;
}

function recencyMultiplier(createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return 0.96;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return 0.92 + (0.08 * Math.exp(-ageDays / 365));
}

function personalImportanceMultiplier(document: MemoryDocumentRow, profile: MemorySearchOptions['importanceProfile']): number {
  if (profile !== 'personal') return 1;
  if (document.actor?.toLocaleLowerCase() === 'jeffrey') return 1.2;
  if (document.source === 'doc') return 1.15;
  if (document.source === 'artifact' || document.source === 'activity' || document.source === 'work_item') return 1.1;
  if (document.source === 'run_output' || document.source === 'run_error') return 0.94;
  return 1;
}

function corroborationMultipliers(documents: MemoryDocumentRow[]): Map<string, number> {
  const sourcesByScope = new Map<string, Set<string>>();
  for (const document of documents) {
    const scopes = [
      document.work_item_id ? `work_item:${document.work_item_id}` : null,
      document.conversation_id ? `conversation:${document.conversation_id}` : null,
    ].filter(nonEmpty);
    for (const scope of scopes) {
      const sources = sourcesByScope.get(scope) ?? new Set<string>();
      sources.add(document.source);
      sourcesByScope.set(scope, sources);
    }
  }
  const multipliers = new Map<string, number>();
  for (const document of documents) {
    const counts = [
      document.work_item_id ? sourcesByScope.get(`work_item:${document.work_item_id}`)?.size ?? 1 : 1,
      document.conversation_id ? sourcesByScope.get(`conversation:${document.conversation_id}`)?.size ?? 1 : 1,
    ];
    multipliers.set(document.id, 1 + Math.min(0.12, (Math.max(...counts) - 1) * 0.04));
  }
  return multipliers;
}

function timeBucket(createdAt: string): string | null {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

/**
 * Preserve the strongest direct matches, then reduce repetition by task,
 * conversation, source, and quarter. Scores stay visible and comparable; the
 * diversity pass changes only selection order.
 */
export function diversifyMemoryResults(results: MemorySearchResult[], limit: number): MemorySearchResult[] {
  const safeLimit = Math.max(0, Math.min(limit, results.length));
  if (!safeLimit) return [];
  const ranked = [...results].sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt));
  const direct = ranked.filter((result) => result.retrievalPath.length === 1);
  const protectedCount = Math.min(direct.length, Math.max(1, Math.ceil(safeLimit * 0.5)));
  const selected = direct.slice(0, protectedCount);
  const selectedKeys = new Set(selected.map((result) => `${result.source}:${result.sourceId}`));
  const remaining = ranked.filter((result) => !selectedKeys.has(`${result.source}:${result.sourceId}`));
  const workItemCounts = new Map<string, number>();
  const conversationCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const timeCounts = new Map<string, number>();
  const recordSelection = (result: MemorySearchResult) => {
    if (result.workItemId) workItemCounts.set(result.workItemId, (workItemCounts.get(result.workItemId) ?? 0) + 1);
    if (result.conversationId) conversationCounts.set(result.conversationId, (conversationCounts.get(result.conversationId) ?? 0) + 1);
    sourceCounts.set(result.source, (sourceCounts.get(result.source) ?? 0) + 1);
    const bucket = timeBucket(result.createdAt);
    if (bucket) timeCounts.set(bucket, (timeCounts.get(bucket) ?? 0) + 1);
  };
  selected.forEach(recordSelection);

  while (selected.length < safeLimit && remaining.length) {
    let bestIndex = 0;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const bucket = timeBucket(candidate.createdAt);
      const adjustedScore = candidate.score
        * Math.pow(0.82, candidate.workItemId ? workItemCounts.get(candidate.workItemId) ?? 0 : 0)
        * Math.pow(0.86, candidate.conversationId ? conversationCounts.get(candidate.conversationId) ?? 0 : 0)
        * Math.pow(0.96, sourceCounts.get(candidate.source) ?? 0)
        * Math.pow(0.92, bucket ? timeCounts.get(bucket) ?? 0 : 0);
      if (adjustedScore > bestAdjustedScore
        || (adjustedScore === bestAdjustedScore && candidate.createdAt > remaining[bestIndex].createdAt)) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    selected.push(next);
    recordSelection(next);
  }
  return selected;
}

type RankedChunk = { chunk_id: number; document_id: string; text: string };
type ChunkSignals = {
  primaryLexicalRank?: number;
  contextLexicalRank?: number;
  primarySemanticSimilarity?: number;
  contextSemanticSimilarity?: number;
};

/**
 * Relevance-first hybrid retrieval. The exact user request and its task context
 * are independent channels: context can resolve a shorthand request, but it
 * cannot overpower a specific request. Weak cosine matches are discarded,
 * raw similarity strength survives ranking, and graph neighbors are admitted
 * only when their own content also matches the request.
 */
export async function searchMemory(database: WorkbenchDatabase, query: string, options: MemorySearchOptions = {}): Promise<MemorySearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  const limit = Math.max(1, Math.min(101, options.limit ?? 20));
  const scope = memoryScopeClause(options, 'md');
  const { primary, context } = memoryQueryParts(trimmed);
  const contextDependent = Boolean(context) && (SHORTHAND_REQUEST.test(primary)
    || CONTEXT_REFERENTIAL_REQUEST.test(primary));
  const contextWeight = contextDependent ? 0.72 : 0.14;
  const fileBacked = Boolean(database.location());

  const lexicalRows = (text: string): RankedChunk[] => {
    const matchQuery = buildMemoryFtsMatchQuery(text);
    if (!matchQuery) return [];
    return database.prepare(`
      SELECT memory_chunks.id AS chunk_id, memory_chunks.document_id AS document_id, memory_chunks.text AS text
      FROM memory_chunks_fts
      JOIN memory_chunks ON memory_chunks.id = memory_chunks_fts.chunk_id
      JOIN memory_documents md ON md.id = memory_chunks.document_id
      WHERE memory_chunks_fts MATCH ?
        ${scope.sql}
      ORDER BY bm25(memory_chunks_fts)
      LIMIT ${MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE}
    `).all(matchQuery, ...scope.parameters) as RankedChunk[];
  };

  const primaryLexicalRows = fileBacked ? [] : lexicalRows(primary);
  const contextLexicalRows = fileBacked || !context ? [] : lexicalRows(context);
  const chunks = new Map<string, { documentId: string; text: string }>();
  const signals = new Map<string, ChunkSignals>();
  const addRankedRows = (rows: RankedChunk[], key: 'primaryLexicalRank' | 'contextLexicalRank') => {
    rows.forEach((row, rank) => {
      const chunkId = String(row.chunk_id);
      chunks.set(chunkId, { documentId: row.document_id, text: row.text });
      signals.set(chunkId, { ...signals.get(chunkId), [key]: rank });
    });
  };
  addRankedRows(primaryLexicalRows, 'primaryLexicalRank');
  addRankedRows(contextLexicalRows, 'contextLexicalRank');

  const bestPrimarySemanticByDocument = new Map<string, number>();
  let primaryQueryVector: Float32Array | null = null;
  try {
    const semanticQueries = context ? [primary, context] : [primary];
    const semantic = fileBacked
      ? await searchSemanticTexts(
          database,
          semanticQueries,
          scope.sql,
          scope.parameters,
          MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE,
          MIN_SEMANTIC_SIMILARITY,
          buildMemoryFtsMatchQuery(primary),
          context ? buildMemoryFtsMatchQuery(context) : null,
        )
      : await embedTexts(semanticQueries).then((queryVectors) => searchSemanticChunks(
          database,
          queryVectors,
          scope.sql,
          scope.parameters,
          MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE,
          MIN_SEMANTIC_SIMILARITY,
        ));
    if (semantic.primaryVector) {
      primaryQueryVector = semantic.primaryVector;
      addRankedRows(semantic.primaryLexical.map((row) => ({ chunk_id: row.id, document_id: row.documentId, text: row.text })), 'primaryLexicalRank');
      addRankedRows(semantic.contextLexical.map((row) => ({ chunk_id: row.id, document_id: row.documentId, text: row.text })), 'contextLexicalRank');
      const addSemanticRows = (rows: typeof semantic.primary, key: 'primarySemanticSimilarity' | 'contextSemanticSimilarity') => {
        rows.forEach((row) => {
          const chunkId = String(row.id);
          chunks.set(chunkId, { documentId: row.documentId, text: row.text });
          signals.set(chunkId, { ...signals.get(chunkId), [key]: row.similarity });
          if (key === 'primarySemanticSimilarity') {
            bestPrimarySemanticByDocument.set(row.documentId, Math.max(bestPrimarySemanticByDocument.get(row.documentId) ?? -1, row.similarity));
          }
        });
      };
      addSemanticRows(semantic.primary, 'primarySemanticSimilarity');
      if (semanticQueries.length > 1) addSemanticRows(semantic.context, 'contextSemanticSimilarity');
    }
  } catch (error) {
    console.error('[memory-index] embedding query failed; falling back to full-text results only', error);
  }

  if (!chunks.size) return [];
  const documentIds = [...new Set([...chunks.values()].map(({ documentId }) => documentId))];
  const placeholders = documentIds.map(() => '?').join(',');
  const documents = database.prepare(`SELECT * FROM memory_documents WHERE id IN (${placeholders})`)
    .all(...documentIds) as MemoryDocumentRow[];
  const documentById = new Map(documents.map((document) => [document.id, document]));
  const bestByDocument = new Map<string, { chunkId: string; relevance: number }>();
  for (const [chunkId, chunk] of chunks) {
    const document = documentById.get(chunk.documentId);
    if (!document) continue;
    const searchable = `${document.title}\n${chunk.text}`;
    const signal = signals.get(chunkId) ?? {};
    const primaryCoverage = lexicalCoverage(searchable, primary);
    const contextCoverage = context ? lexicalCoverage(searchable, context) : 0;
    if (contextDependent && contextCoverage < 0.2 && (signal.contextSemanticSimilarity ?? -1) < 0.5) continue;
    const primaryScore = combinedChannelScore(
      signal.primaryLexicalRank,
      signal.primarySemanticSimilarity,
      primaryCoverage,
    );
    const contextScore = context ? combinedChannelScore(
      signal.contextLexicalRank,
      signal.contextSemanticSimilarity,
      contextCoverage,
    ) : 0;
    const phraseBoost = primary.length >= 8 && searchable.toLocaleLowerCase().includes(primary.toLocaleLowerCase()) ? 0.08 : 0;
    const relevance = primaryScore + (contextWeight * contextScore) + phraseBoost;
    const current = bestByDocument.get(chunk.documentId);
    if (!current || relevance > current.relevance) bestByDocument.set(chunk.documentId, { chunkId, relevance });
  }

  const corroboration = corroborationMultipliers(documents);
  const directResults: MemorySearchResult[] = [];
  const excludedBody = options.excludeExactBody ? normalizedMemoryBody(options.excludeExactBody) : '';
  for (const [documentId, best] of bestByDocument) {
    if (best.relevance < MIN_DIRECT_RELEVANCE) continue;
    const document = documentById.get(documentId);
    const chunk = chunks.get(best.chunkId);
    if (!document || !chunk) continue;
    if (options.excludeConversationId && document.conversation_id === options.excludeConversationId) continue;
    if (options.excludeGeneratedConversationId && document.conversation_id === options.excludeGeneratedConversationId
      && (document.actor === 'codex' || document.actor === 'claude' || document.actor === 'palmyra' || document.actor === 'system')) continue;
    if (excludedBody && normalizedMemoryBody(document.body) === excludedBody) continue;
    const score = best.relevance
      * (SOURCE_AUTHORITY[document.source] ?? 1)
      * lexicalImportanceMultiplier(document, primary)
      * recencyMultiplier(document.created_at)
      * (corroboration.get(document.id) ?? 1)
      * personalImportanceMultiplier(document, options.importanceProfile);
    directResults.push({
      source: document.source, sourceId: document.source_id, title: document.title, snippet: chunk.text,
      createdAt: document.created_at, conversationId: document.conversation_id, workItemId: document.work_item_id,
      actor: document.actor, score, retrievalPath: ['Matched request'],
    });
  }
  directResults.sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt));
  if (!directResults.length) return [];
  const strongestScore = directResults[0].score;
  const relevantDirect = directResults.filter(({ score }) => score >= strongestScore * RELATIVE_RELEVANCE_FLOOR);

  const graphResults = expandKnowledgeGraph(database, relevantDirect, {
    limit: Math.min(20, Math.ceil(limit / 3)),
    sources: options.sources,
    projectKey: options.projectKey,
    conversationId: options.conversationId,
    workItemId: options.workItemId,
  });
  const graphDocumentRows = graphResults.length ? database.prepare(`
    SELECT id, source, source_id FROM memory_documents
    WHERE ${graphResults.map(() => '(source = ? AND source_id = ?)').join(' OR ')}
  `).all(...graphResults.flatMap(({ source, sourceId }) => [source, sourceId])) as Array<{ id: string; source: string; source_id: string }> : [];
  const graphDocumentIds = new Map(graphDocumentRows.map((row) => [`${row.source}:${row.source_id}`, row.id]));
  if (primaryQueryVector && graphDocumentRows.length) {
    try {
      const graphSimilarities = await scoreSemanticDocuments(database, primaryQueryVector, graphDocumentRows.map((row) => row.id));
      for (const [documentId, similarity] of graphSimilarities) bestPrimarySemanticByDocument.set(documentId, similarity);
    } catch (error) {
      console.error('[memory-index] graph semantic scoring failed; using lexical graph affinity only', error);
    }
  }
  const relevantGraph = graphResults.flatMap((result) => {
    if (options.excludeConversationId && result.conversationId === options.excludeConversationId) return [];
    if (options.excludeGeneratedConversationId && result.conversationId === options.excludeGeneratedConversationId
      && (result.actor === 'codex' || result.actor === 'claude' || result.actor === 'palmyra' || result.actor === 'system')) return [];
    if (excludedBody && normalizedMemoryBody(result.snippet) === excludedBody) return [];
    const documentId = graphDocumentIds.get(`${result.source}:${result.sourceId}`);
    const lexical = lexicalCoverage(`${result.title}\n${result.snippet}`, primary);
    const semantic = semanticStrength(documentId ? bestPrimarySemanticByDocument.get(documentId) : undefined);
    const queryAffinity = Math.max(lexical, semantic);
    if (queryAffinity <= 0) return [];
    return [{ ...result, score: result.score * queryAffinity * 0.55 }];
  });

  const merged = new Map(relevantDirect.map((result) => [`${result.source}:${result.sourceId}`, result]));
  for (const result of relevantGraph) {
    const key = `${result.source}:${result.sourceId}`;
    if (!merged.has(key)) merged.set(key, result);
  }
  return diversifyMemoryResults([...merged.values()], limit);
}
