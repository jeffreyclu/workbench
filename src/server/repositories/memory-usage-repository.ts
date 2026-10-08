import { randomUUID } from 'node:crypto';

import type { UnitOfWork } from '../unit-of-work.js';

export type MemoryRetrievalChannel = 'recall_context' | 'prefetch';

export interface MemoryRetrievalEntry {
  entryId: string;
  source: string;
}

export interface MemoryUsageContext {
  runId?: string | null;
  messageId?: string | null;
  conversationId?: string | null;
  workItemId?: string | null;
}

export interface MemoryEntryUsage {
  entryId: string;
  retrievals: number;
  citations: number;
  lastRetrievedAt: string | null;
  lastCitedAt: string | null;
}

/** One cited memory entry, written by an agent as `[<file>.md#<N>]`. */
export interface MemoryCitation {
  entryId: string;
  file: string;
  entryNumber: number;
}

// The citation token is a fixed format, not a heuristic: a bracketed markdown
// file name (optionally path-qualified) and a numeric entry anchor.
const MEMORY_CITATION = /\[([A-Za-z0-9_][\w./-]*\.md)#(\d+)\]/g;

/** Stable across re-indexing: memory_documents keeps one row per (source, source_id). */
export function memoryEntryId(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/** Distinct `[<file>.md#<N>]` citations in first-seen order. */
export function extractMemoryCitations(text: string): MemoryCitation[] {
  const citations = new Map<string, MemoryCitation>();
  for (const match of text.matchAll(MEMORY_CITATION)) {
    const entryNumber = Number(match[2]);
    if (!Number.isSafeInteger(entryNumber)) continue;
    const entryId = `${match[1]}#${entryNumber}`;
    if (!citations.has(entryId)) citations.set(entryId, { entryId, file: match[1], entryNumber });
  }
  return [...citations.values()];
}

/**
 * Append-only memory usage: which entries recall and prefetch returned, and
 * which ones an agent cited. These rows feed ranking and gap detection only.
 * This repository deliberately exposes no delete, prune, or archive path.
 */
export class MemoryUsageRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  recordRetrievals(channel: MemoryRetrievalChannel, entries: MemoryRetrievalEntry[], context: MemoryUsageContext = {}): number {
    if (!entries.length) return 0;
    const now = new Date().toISOString();
    const insert = this.database.prepare(`
      INSERT INTO memory_retrievals (id, entry_id, source, channel, rank, run_id, message_id, conversation_id, work_item_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.unitOfWork.transaction(() => {
      entries.forEach((entry, index) => insert.run(
        randomUUID(), entry.entryId, entry.source, channel, index + 1,
        context.runId ?? null, context.messageId ?? null, context.conversationId ?? null, context.workItemId ?? null, now,
      ));
    });
    return entries.length;
  }

  /**
   * Records each distinct citation once per reply. A run that also completes
   * a room reply shares the reply's key, so writing both never double counts.
   */
  recordCitations(text: string, context: MemoryUsageContext): number {
    const replyKey = context.messageId ?? context.runId;
    if (!replyKey) return 0;
    const citations = extractMemoryCitations(text);
    if (!citations.length) return 0;
    const now = new Date().toISOString();
    const insert = this.database.prepare(`
      INSERT INTO memory_citations (id, entry_id, file, entry_number, reply_key, run_id, message_id, conversation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(reply_key, entry_id) DO NOTHING
    `);
    return this.unitOfWork.transaction(() => {
      let inserted = 0;
      for (const citation of citations) {
        inserted += Number(insert.run(
          randomUUID(), citation.entryId, citation.file, citation.entryNumber, replyKey,
          context.runId ?? null, context.messageId ?? null, context.conversationId ?? null, now,
        ).changes);
      }
      return inserted;
    });
  }

  /** Retrieval and citation counts per entry, most used first. */
  listEntryUsage(limit = 200): MemoryEntryUsage[] {
    const safeLimit = Math.max(1, Math.min(1_000, limit));
    const rows = this.database.prepare(`
      SELECT entry_id, SUM(retrievals) AS retrievals, SUM(citations) AS citations,
        MAX(last_retrieved_at) AS last_retrieved_at, MAX(last_cited_at) AS last_cited_at
      FROM (
        SELECT entry_id, COUNT(*) AS retrievals, 0 AS citations, MAX(created_at) AS last_retrieved_at, NULL AS last_cited_at
        FROM memory_retrievals GROUP BY entry_id
        UNION ALL
        SELECT entry_id, 0, COUNT(*), NULL, MAX(created_at)
        FROM memory_citations GROUP BY entry_id
      )
      GROUP BY entry_id
      ORDER BY citations + retrievals DESC, entry_id
      LIMIT ?
    `).all(safeLimit) as Array<{ entry_id: string; retrievals: number; citations: number; last_retrieved_at: string | null; last_cited_at: string | null }>;
    return rows.map((row) => ({
      entryId: row.entry_id,
      retrievals: Number(row.retrievals),
      citations: Number(row.citations),
      lastRetrievedAt: row.last_retrieved_at,
      lastCitedAt: row.last_cited_at,
    }));
  }
}
