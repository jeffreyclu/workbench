import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { buildMemoryFtsMatchQuery, chunkText, collectMemoryDocuments, diversifyMemoryResults, indexPendingMemory, MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE, reciprocalRankFusion, searchMemory, setEmbedder, type MemorySearchResult } from './memory-index.js';
import { deterministicTestEmbedder } from './memory-index.test-helpers.js';
import { WorkItemRepository } from './repository.js';

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

describe('memory retrieval candidate pool', () => {
  it('keeps enough chunk candidates to preserve broad document recall after deduplication', () => {
    expect(MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE).toBe(400);
  });
});

describe('buildMemoryFtsMatchQuery', () => {
  it('lets BM25 rank significant terms instead of requiring every context word', () => {
    expect(buildMemoryFtsMatchQuery('quartz rollout\nRelevant prior decisions constraints and preferences'))
      .toBe('"quartz" OR "rollout" OR "decisions" OR "constraints" OR "preferences"');
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

  function insertDocument(
    id: string,
    source: string,
    title: string,
    body: string,
    workItemId: string | null = null,
    options: { conversationId?: string | null; actor?: string | null; createdAt?: string } = {},
  ): void {
    database.prepare(`
      INSERT INTO memory_documents (id, source, source_id, conversation_id, work_item_id, actor, title, body, created_at, content_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(id, source, id, options.conversationId ?? null, workItemId, options.actor ?? null, title, body, options.createdAt ?? new Date().toISOString(), `hash-${id}`);
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

  it('retrieves lexically when an expanded durable query contains unmatched context words', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    setEmbedder(async () => { throw new Error('semantic retrieval unavailable'); });
    try {
      insertDocument('lexical-only', 'doc', 'Quartz rollout', 'The quartz rollout shipped safely.');
      await indexPendingMemory(database);

      const results = await searchMemory(database, 'quartz rollout\nRelevant prior decisions constraints preferences ownership');

      expect(results[0]?.sourceId).toBe('lexical-only');
    } finally {
      logged.mockRestore();
      setEmbedder(deterministicTestEmbedder);
    }
  });

  it('falls back to hybrid results when graph expansion is unavailable', async () => {
    insertDocument('doc-1', 'message', 'Runbook', 'Restart the scheduler safely.');
    await indexPendingMemory(database);
    database.exec('DROP TABLE knowledge_graph_edges; DROP TABLE knowledge_graph_nodes;');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const results = await searchMemory(database, 'restart scheduler');

    expect(results[0]?.sourceId).toBe('doc-1');
    expect(logged).toHaveBeenCalledWith('[knowledge-graph] expansion unavailable; using hybrid retrieval only', expect.anything());
    logged.mockRestore();
  });

  it('merges graph neighbors with hybrid matches while returning canonical memory content', async () => {
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Graph-assisted retrieval', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Graph-assisted retrieval', task.id);
    const seed = repository.createSharedMessage('jeffrey', 'Investigate nebulafalcon failures.', 'completed', conversation.id);
    const related = repository.createSharedMessage('claude', 'The nebulafalcon resolution is to use the cursor-pagination decision.', 'completed', conversation.id);
    collectMemoryDocuments(database, { docRoots: [] });
    await indexPendingMemory(database);
    database.prepare("DELETE FROM memory_chunks WHERE document_id = (SELECT id FROM memory_documents WHERE source = 'message' AND source_id = ?)").run(related.id);

    const results = await searchMemory(database, 'nebulafalcon', { sources: ['message'], limit: 10 });
    const graphResult = results.find((result) => result.sourceId === related.id);

    expect(results.find((result) => result.sourceId === seed.id)?.retrievalPath).toEqual(['Matched request']);
    expect(graphResult?.snippet).toContain('cursor-pagination');
    expect(graphResult?.retrievalPath).toEqual(['Matched request', 'Same conversation']);
  });

  it('removes revoked artifacts from the memory index on the next collection', async () => {
    const publishedAt = '2026-09-09T12:00:00.000Z';
    database.prepare(`
      INSERT INTO published_artifacts (id, source_path, title, public_url, published_at)
      VALUES ('artifact-1', '/tmp/review.md', 'Promotion evidence', 'https://example.test/review', ?)
    `).run(publishedAt);
    collectMemoryDocuments(database, { docRoots: [] });
    await indexPendingMemory(database);

    expect(database.prepare("SELECT source_id FROM memory_documents WHERE source = 'artifact'").get())
      .toMatchObject({ source_id: 'artifact-1' });

    database.prepare('UPDATE published_artifacts SET revoked_at = ? WHERE id = ?').run('2026-09-09T13:00:00.000Z', 'artifact-1');
    collectMemoryDocuments(database, { docRoots: [] });

    expect(database.prepare("SELECT source_id FROM memory_documents WHERE source = 'artifact'").get()).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_chunks WHERE document_id NOT IN (SELECT id FROM memory_documents)").get())
      .toEqual({ count: 0 });
  });

  it('filters results down to the requested sources', async () => {
    insertDocument('doc-1', 'doc', 'Runbook', 'Restart the scheduler by running npm run runtime:start.');
    insertDocument('msg-1', 'message', 'Chat', 'Please restart the scheduler now.');
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'restart scheduler', { sources: ['message'] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.source === 'message')).toBe(true);
  });

  it('filters retrieval to memories attached to the requested project before ranking', async () => {
    const timestamp = '2026-08-25T00:00:00.000Z';
    database.prepare(`INSERT INTO work_items (id, title, queue_position, project_name, project_key, created_at, updated_at, last_touched_at)
      VALUES ('connectors-task', 'Connectors task', 1, 'Connectors', 'connectors', ?, ?, ?),
             ('other-task', 'Other task', 2, 'Other', 'other', ?, ?, ?)`)
      .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp);
    insertDocument('connectors-memory', 'message', 'Connectors', 'Duplicate fetches in connector gateway.', 'connectors-task');
    insertDocument('other-memory', 'message', 'Other', 'Duplicate fetches in another system.', 'other-task');
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'duplicate fetches', { projectKey: 'connectors' });

    expect(results.map((result) => result.sourceId)).toEqual(['connectors-memory']);
  });

  it('applies project scope before the lexical and semantic top-400 candidate cutoffs', async () => {
    const timestamp = '2026-09-09T00:00:00.000Z';
    database.prepare(`INSERT INTO work_items (id, title, queue_position, project_name, project_key, created_at, updated_at, last_touched_at)
      VALUES ('target-task', 'Target task', 1, 'Target', 'target', ?, ?, ?),
             ('noise-task', 'Noise task', 2, 'Noise', 'noise', ?, ?, ?)`)
      .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp);
    for (let index = 0; index <= MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE; index += 1) {
      insertDocument(`noise-${index}`, 'message', 'Outside project', 'rare scoped needle', 'noise-task');
    }
    insertDocument('inside-project', 'message', 'Inside project', 'rare scoped needle', 'target-task');
    await indexPendingMemory(database, { limit: 5_000 });

    const results = await searchMemory(database, 'rare scoped needle', { projectKey: 'target', limit: 10 });

    expect(results.map((result) => result.sourceId)).toEqual(['inside-project']);
  });

  it('applies hard scope before semantic ranking when lexical search has no matches', async () => {
    setEmbedder(async (texts) => texts.map(() => Float32Array.from([1, 0])));
    try {
      const timestamp = '2026-09-09T00:00:00.000Z';
      database.prepare(`INSERT INTO work_items (id, title, queue_position, project_name, project_key, created_at, updated_at, last_touched_at)
        VALUES ('semantic-target-task', 'Semantic target', 1, 'Semantic Target', 'semantic-target', ?, ?, ?),
               ('semantic-noise-task', 'Semantic noise', 2, 'Semantic Noise', 'semantic-noise', ?, ?, ?)`)
        .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp);
      for (let index = 0; index <= MEMORY_RETRIEVAL_CANDIDATE_POOL_SIZE; index += 1) {
        insertDocument(`semantic-noise-${index}`, 'message', 'Outside project', `unrelated outside evidence ${index}`, 'semantic-noise-task');
      }
      insertDocument('semantic-inside-project', 'message', 'Inside project', 'the remembered material', 'semantic-target-task');
      await indexPendingMemory(database, { limit: 5_000 });

      const results = await searchMemory(database, 'find remembered outcome', { projectKey: 'semantic-target', limit: 10 });

      expect(results.map((result) => result.sourceId)).toEqual(['semantic-inside-project']);
    } finally {
      setEmbedder(deterministicTestEmbedder);
    }
  });

  it('keeps the primary request stronger than appended semantic context', async () => {
    setEmbedder(async (texts) => texts.map((text) => {
      if (text === 'first payload' || text === 'remember outcome') return Float32Array.from([1, 0]);
      return Float32Array.from([0, 1]);
    }));
    try {
      insertDocument('primary-evidence', 'message', 'Primary evidence', 'first payload');
      insertDocument('context-evidence', 'message', 'Context evidence', 'second payload');
      await indexPendingMemory(database);

      const results = await searchMemory(database, 'remember outcome\nsecondary context expansion', { limit: 10 });

      expect(results[0]?.sourceId).toBe('primary-evidence');
    } finally {
      setEmbedder(deterministicTestEmbedder);
    }
  });

  it('does not let generic task context outrank the exact request', async () => {
    setEmbedder(async (texts) => texts.map((text) => {
      if (text.startsWith('the purpose of the prototype')) return Float32Array.from([1, 0, 0]);
      if (text.startsWith('Analyze Connector Error Reports')) return Float32Array.from([0, 1, 0]);
      if (text.includes('narrow frontend prototype')) return Float32Array.from([0.95, 0.05, 0]);
      return Float32Array.from([0, 0, 1]);
    }));
    insertDocument('prototype-evidence', 'message', 'Connector error UX prototype', 'Build a narrow connector error UX prototype to get team buy-in before investing real engineering hours.');
    insertDocument('persona-cleanup', 'work_item', 'Cleanup overlapping personas and skills', 'Remove dead personas and consolidate duplicate testing skills.');
    insertDocument('first-week', 'message', 'First week at Writer', 'Onboarded to Connector Gateway and met the connectors team.');
    await indexPendingMemory(database);

    try {
      const results = await searchMemory(database, [
        'the purpose of the prototype is to get buy in from my team before investing real eng hours',
        'Analyze Connector Error Reports and Propose UX Improvement Plan',
        'Analyze Connector Error Reports and Propose UX Improvement Plan',
      ].join('\n'), { limit: 10 });

      expect(results[0]?.sourceId).toBe('prototype-evidence');
      expect(results.map(({ sourceId }) => sourceId)).not.toContain('persona-cleanup');
      expect(results.map(({ sourceId }) => sourceId)).not.toContain('first-week');
    } finally {
      setEmbedder(deterministicTestEmbedder);
    }
  });

  it('excludes active-conversation echoes before they set the relevance threshold', async () => {
    insertDocument('current-echo', 'message', 'Current task', 'Fix the connector prototype ranking.', null, { conversationId: 'current' });
    insertDocument('historical-decision', 'doc', 'Prototype decision', 'The connector prototype must demonstrate frontend recovery UX for team buy-in.');
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'Fix the connector prototype ranking.', {
      limit: 10,
      excludeConversationId: 'current',
      excludeExactBody: 'Fix the connector prototype ranking.',
    });

    expect(results.map(({ sourceId }) => sourceId)).toEqual(['historical-decision']);
  });

  it('rejects weak semantic matches instead of filling the result limit with noise', async () => {
    setEmbedder(async (texts) => texts.map((text) => {
      if (text === 'repair authentication outage') return Float32Array.from([1, 0]);
      if (text.includes('Re-enable identity provider')) return Float32Array.from([0.8, 0.6]);
      return Float32Array.from([0.05, 0.9987]);
    }));
    try {
      insertDocument('semantic-answer', 'message', 'Restore login service', 'Re-enable identity provider access.');
      insertDocument('semantic-noise', 'message', 'Lunch menu', 'The cafeteria serves noodles today.');
      await indexPendingMemory(database);

      const results = await searchMemory(database, 'repair authentication outage', { limit: 10 });

      expect(results.map(({ sourceId }) => sourceId)).toEqual(['semantic-answer']);
    } finally {
      setEmbedder(deterministicTestEmbedder);
    }
  });

  it('prioritizes Jeffrey-authored evidence for personal-memory questions', async () => {
    insertDocument('agent-claim', 'run_output', 'Career history', 'Led the connector reliability launch.', null, {
      actor: 'claude', createdAt: '2026-09-09T00:00:00.000Z',
    });
    insertDocument('jeffrey-claim', 'message', 'Career history', 'Led the connector reliability launch.', null, {
      actor: 'jeffrey', createdAt: '2024-09-09T00:00:00.000Z',
    });
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'connector reliability launch', { importanceProfile: 'personal', limit: 10 });

    expect(results[0]?.sourceId).toBe('jeffrey-claim');
    expect(results[0]!.score).toBeGreaterThan(results.find((result) => result.sourceId === 'agent-claim')!.score);
  });

  it('uses recency to break otherwise comparable evidence rankings', async () => {
    insertDocument('old-evidence', 'message', 'Rollout evidence', 'Shipped the atlas rollout.', null, { createdAt: '2019-01-01T00:00:00.000Z' });
    insertDocument('new-evidence', 'message', 'Rollout evidence', 'Shipped the atlas rollout.', null, { createdAt: new Date().toISOString() });
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'atlas rollout', { limit: 10 });

    expect(results[0]?.sourceId).toBe('new-evidence');
  });

  it('boosts evidence corroborated by another source on the same task', async () => {
    const timestamp = new Date().toISOString();
    database.prepare(`INSERT INTO work_items (id, title, queue_position, project_name, project_key, created_at, updated_at, last_touched_at)
      VALUES ('solo-task', 'Solo evidence', 1, 'Workbench', 'workbench', ?, ?, ?),
             ('corroborated-task', 'Corroborated evidence', 2, 'Workbench', 'workbench', ?, ?, ?)`)
      .run(timestamp, timestamp, timestamp, timestamp, timestamp, timestamp);
    insertDocument('solo-message', 'message', 'Launch evidence', 'Delivered the quartz launch.', 'solo-task');
    insertDocument('corroborated-message', 'message', 'Launch evidence', 'Delivered the quartz launch.', 'corroborated-task');
    insertDocument('corroborating-activity', 'activity', 'Launch evidence', 'Validated the quartz launch.', 'corroborated-task');
    await indexPendingMemory(database);

    const results = await searchMemory(database, 'quartz launch', { limit: 10 });
    const solo = results.find((result) => result.sourceId === 'solo-message');
    const corroborated = results.find((result) => result.sourceId === 'corroborated-message');

    expect(corroborated!.score).toBeGreaterThan(solo!.score);
  });

  it('protects the strongest direct matches before diversifying the remaining results', () => {
    const result = (sourceId: string, score: number, overrides: Partial<MemorySearchResult> = {}): MemorySearchResult => ({
      source: 'message', sourceId, title: sourceId, snippet: sourceId, createdAt: '2026-09-01T00:00:00.000Z',
      conversationId: 'conversation-a', workItemId: 'task-a', actor: 'jeffrey', score, retrievalPath: ['Matched request'],
      ...overrides,
    });
    const diversified = diversifyMemoryResults([
      result('graph-result', 2, { retrievalPath: ['Matched request', 'Same project'] }),
      result('strong-direct', 1),
      result('same-task', 0.99),
      result('different-period', 0.97, {
        source: 'artifact', conversationId: 'conversation-b', workItemId: 'task-b', createdAt: '2024-01-01T00:00:00.000Z',
      }),
    ], 3);

    expect(diversified.map(({ sourceId }) => sourceId)).toEqual(['strong-direct', 'same-task', 'different-period']);
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
