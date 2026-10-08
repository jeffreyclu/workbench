import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { setEmbedder } from '../memory-index.js';
import { deterministicTestEmbedder } from '../memory-index.test-helpers.js';
import { WorkItemRepository } from '../repository.js';
import { extractMemoryCitations } from './memory-usage-repository.js';

describe('memory usage metrics', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

  const citations = () => database.prepare('SELECT entry_id, file, entry_number, reply_key, run_id, message_id FROM memory_citations').all();

  it('extracts distinct [<file>.md#<N>] citations and ignores near misses', () => {
    expect(extractMemoryCitations('Per [working-with-jeffrey.md#12] and [notes/a-b.md#3], again [working-with-jeffrey.md#12]. Not [x.md], [x.md#], (y.md#4) or [z.txt#5].'))
      .toEqual([
        { entryId: 'working-with-jeffrey.md#12', file: 'working-with-jeffrey.md', entryNumber: 12 },
        { entryId: 'notes/a-b.md#3', file: 'notes/a-b.md', entryNumber: 3 },
      ]);
  });

  it('records exactly one citation row for a reply that cites an entry', () => {
    const text = 'Jeffrey prefers worktrees [working-with-jeffrey.md#12].';
    // The run finish and its room reply both carry the same output; a retry
    // can write it again. All of them describe one reply.
    repository.recordMemoryCitations(text, { runId: 'run-1', messageId: 'reply-1', conversationId: 'conversation-1' });
    repository.recordMemoryCitations(text, { messageId: 'reply-1', conversationId: 'conversation-1' });
    repository.recordMemoryCitations(text, { runId: 'run-1', messageId: 'reply-1' });

    expect(citations()).toEqual([{ entry_id: 'working-with-jeffrey.md#12', file: 'working-with-jeffrey.md', entry_number: 12, reply_key: 'reply-1', run_id: 'run-1', message_id: 'reply-1' }]);
  });

  it('records citations from run output without a room reply', () => {
    expect(repository.recordMemoryCitations('Done [a.md#1] [b.md#2]', { runId: 'run-2' })).toBe(2);
    expect(repository.recordMemoryCitations('No citations here.', { runId: 'run-3' })).toBe(0);
    expect(repository.recordMemoryCitations('[a.md#1]', {})).toBe(0);
    expect(citations()).toHaveLength(2);
  });

  it('records one retrieval row per returned entry in rank order', () => {
    repository.recordMemoryRetrievals('prefetch', [
      { entryId: 'activity:a1', source: 'activity' },
      { entryId: 'doc:notes:x.md', source: 'doc' },
    ], { runId: 'run-1', workItemId: 'item-1' });

    expect(database.prepare('SELECT entry_id, source, channel, rank, run_id, work_item_id FROM memory_retrievals ORDER BY rank').all()).toEqual([
      { entry_id: 'activity:a1', source: 'activity', channel: 'prefetch', rank: 1, run_id: 'run-1', work_item_id: 'item-1' },
      { entry_id: 'doc:notes:x.md', source: 'doc', channel: 'prefetch', rank: 2, run_id: 'run-1', work_item_id: 'item-1' },
    ]);
    expect(repository.listMemoryEntryUsage()).toEqual([
      { entryId: 'activity:a1', retrievals: 1, citations: 0, lastRetrievedAt: expect.any(String), lastCitedAt: null },
      { entryId: 'doc:notes:x.md', retrievals: 1, citations: 0, lastRetrievedAt: expect.any(String), lastCitedAt: null },
    ]);
  });

  it('carries a stable entry id on searched memory evidence', async () => {
    setEmbedder(deterministicTestEmbedder);
    try {
      const item = repository.create({ title: 'Cache contract', description: 'Invalidate the profile cache before refetching.', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const results = await repository.searchActivityMemory('profile cache invalidation', 5);
      expect(results.length).toBeGreaterThan(0);
      expect(results.find((result) => result.workItemId === item.id)?.entryId).toMatch(/^(work_item|activity):/);
    } finally {
      setEmbedder(null);
    }
  });
});
