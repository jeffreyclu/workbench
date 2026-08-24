import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { chunkText, indexPendingMemory, reciprocalRankFusion, searchMemory, setEmbedder } from './memory-index.js';
import { deterministicTestEmbedder } from './memory-index.test-helpers.js';

describe('chunkText', () => {
  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  ')).toEqual([]);
  });

  it('returns the whole text as a single chunk when it is at or under the target size', () => {
    const text = 'a short document body';
    expect(chunkText(text)).toEqual([text]);
  });

  it('prefers breaking on a paragraph boundary near the target chunk size over a hard cut', () => {
    const first = 'A'.repeat(1100);
    const second = 'B'.repeat(1100);
    const chunks = chunkText(`${first}\n\n${second}`);
    expect(chunks[0]).toBe(first);
    // The overlap window pulled forward from the paragraph break means the
    // final chunk is a suffix of `second`, not the full 1100-char string.
    expect(/^B+$/.test(chunks[chunks.length - 1])).toBe(true);
  });

  it('hard-cuts at the target size with a fixed overlap when no natural boundary exists nearby', () => {
    const text = Array.from({ length: 3000 }, (_, index) => String(index % 10)).join('');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toHaveLength(1200);
    // The 150-char overlap window is copied verbatim into the start of the next chunk.
    expect(chunks[0].slice(-150)).toBe(chunks[1].slice(0, 150));
  });

  it('never emits an empty chunk and always terminates', () => {
    const text = `${'x'.repeat(1200)}\n\n\n\n${'y'.repeat(1200)}`;
    const chunks = chunkText(text);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards an id that ranks well across multiple lists over one that only tops a single list', () => {
    const ftsRanking = ['a', 'b', 'c'];
    const vectorRanking = ['b', 'c', 'a'];
    const scores = reciprocalRankFusion([ftsRanking, vectorRanking]);
    const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
    expect(ranked[0]).toBe('b');
  });

  it('is a no-op fold over a single ranking, preserving its order', () => {
    const scores = reciprocalRankFusion([['first', 'second', 'third']]);
    const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
    expect(ranked).toEqual(['first', 'second', 'third']);
  });

  it('returns an empty map for no rankings', () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
  });
});

describe('indexPendingMemory / searchMemory (stubbed embedder, no model download)', () => {
  let database: WorkbenchDatabase;

  beforeEach(() => {
    database = openDatabase(':memory:');
    setEmbedder(deterministicTestEmbedder);
  });

  afterEach(() => {
    database.close();
    setEmbedder(null);
  });

  function insertDocument(id: string, source: string, title: string, body: string): void {
    database.prepare(`
      INSERT INTO memory_documents (id, source, source_id, conversation_id, work_item_id, actor, title, body, created_at, content_hash, indexed_at)
      VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, NULL)
    `).run(id, source, id, title, body, new Date().toISOString(), `hash-${id}`);
  }

  it('chunks, embeds, and marks pending documents as indexed', async () => {
    insertDocument('doc-1', 'doc', 'Notes', 'Some content to embed.');
    const result = await indexPendingMemory(database);
    expect(result).toEqual({ documents: 1, chunks: 1 });

    const chunk = database.prepare('SELECT embedding, dims, model FROM memory_chunks').get() as { embedding: Uint8Array | null; dims: number | null; model: string | null };
    expect(chunk.embedding).not.toBeNull();
    expect(chunk.dims).toBeGreaterThan(0);

    const document = database.prepare('SELECT indexed_at FROM memory_documents WHERE id = ?').get('doc-1') as { indexed_at: string | null };
    expect(document.indexed_at).not.toBeNull();
  });

  it('is idempotent: a document already indexed is left alone on a repeat call', async () => {
    insertDocument('doc-1', 'doc', 'Notes', 'Some content to embed.');
    await indexPendingMemory(database);
    const second = await indexPendingMemory(database);
    expect(second).toEqual({ documents: 0, chunks: 0 });
  });

  it('finds the matching document by full-text search after indexing', async () => {
    insertDocument('doc-1', 'doc', 'Runbook', 'Restart the scheduler by running npm run runtime:start.');
    insertDocument('doc-2', 'doc', 'Unrelated', 'Coffee brewing instructions for the office kitchen.');
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'restart scheduler');
    expect(results[0]?.sourceId).toBe('doc-1');
  });

  it('filters results down to the requested sources', async () => {
    insertDocument('doc-1', 'doc', 'Runbook', 'Restart the scheduler by running npm run runtime:start.');
    insertDocument('msg-1', 'message', 'Chat', 'Please restart the scheduler now.');
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'restart scheduler', { sources: ['message'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.source === 'message')).toBe(true);
  });

  it('returns no results for a query shorter than the minimum length', async () => {
    insertDocument('doc-1', 'doc', 'Runbook', 'Restart the scheduler.');
    await indexPendingMemory(database);
    expect(await searchMemory(database, 'a')).toEqual([]);
  });

  it('never throws on FTS5 special characters or reserved keywords in the query', async () => {
    insertDocument('doc-1', 'doc', 'Notes', 'Some normal text content here.');
    await indexPendingMemory(database);

    await expect(searchMemory(database, 'AND OR NOT "unterminated * : - (paren'))
      .resolves.toBeInstanceOf(Array);
    await expect(searchMemory(database, '*** ::: ((( )))'))
      .resolves.toBeInstanceOf(Array);
  });
});
