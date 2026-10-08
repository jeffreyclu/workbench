import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConsolidationProposalItem } from '../shared/contracts.js';
import { createConsolidationProposal, resolveConsolidationProposal } from './consolidation-apply.js';
import { saveConsolidationProposal } from './consolidation-proposal.js';
import { getConsolidationProposal } from './consolidation-store.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';

const PROMOTE_TEXT = 'Always re-read a file after writing it before trusting the write.';

describe('consolidation accept / reject / guard', () => {
  let root: string;
  let directories: { shared: string; knowledge: string };
  let repository: WorkItemRepository;
  const read = (name: string) => readFileSync(join(directories.shared, name), 'utf8');
  const activities = () => (repository.database.prepare('SELECT kind FROM activities').all() as Array<{ kind: string }>).map((row) => row.kind);

  const promote = (id = 'short_term_memory:conv-1'): ConsolidationProposalItem => ({
    provenanceId: id, provenance: { source: 'short_term_memory', id: 'conv-1' }, verdict: 'promote', targetFile: 'topic.md', title: 'Re-read writes', text: PROMOTE_TEXT,
  });
  const archiveEntry = (): ConsolidationProposalItem => ({
    provenanceId: 'memory_entry:topic.md#2', provenance: { source: 'memory_entry', id: 'topic.md#2' }, verdict: 'archive_then_remove', reason: 'stale',
  });
  const archivePinned = (id: string): ConsolidationProposalItem => ({
    provenanceId: `pinned_message:${id}`, provenance: { source: 'pinned_message', id }, verdict: 'archive_then_remove', reason: 'duplicate reminder',
  });
  const pinnedMessage = (body: string) => {
    const message = repository.createSharedMessage('jeffrey', body, 'completed');
    repository.database.prepare('UPDATE shared_messages SET pinned = 1 WHERE id = ?').run(message.id);
    return message.id;
  };
  const isPinned = (id: string) => (repository.database.prepare('SELECT pinned FROM shared_messages WHERE id = ?').get(id) as { pinned: number }).pinned === 1;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'consolidation-apply-'));
    directories = { shared: join(root, 'docs/shared-memory'), knowledge: join(root, 'knowledge') };
    mkdirSync(directories.shared, { recursive: true });
    mkdirSync(directories.knowledge);
    writeFileSync(join(directories.shared, 'topic.md'),
      'tier: workbench\n### <a id="1"></a>1. First\n\nKeep.\n\n### <a id="2"></a>2. Second\n\nDrop me.\n');
    writeFileSync(join(directories.shared, 'discard-log.md'), 'tier: workbench\n');
    writeFileSync(join(root, 'docs/shared-memory.md'),
      '| Path | Entries |\n| --- | ---: |\n| `topic.md` | 2 | workbench | core | k | — |\n| `discard-log.md` | 0 | workbench | archive | d | — |\n');
    writeFileSync(join(directories.knowledge, 'index.md'), '| Path | Entries |\n');
    repository = new WorkItemRepository(openDatabase(':memory:'), 'America/New_York', null);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accept: promote is re-read before applied; archive-then-remove logs, confirms, then tombstones', () => {
    const pinned = pinnedMessage('Remember the duplicate reminder.');
    const proposal = saveConsolidationProposal(repository.database, [archiveEntry(), archivePinned(pinned), promote()]);

    const resolved = resolveConsolidationProposal(repository, proposal.id, 'accepted', directories)!;

    expect(resolved.status).toBe('accepted');
    expect(resolved.applyResults?.map((result) => [result.verdict, result.status])).toEqual([
      ['promote', 'applied'], ['archive_then_remove', 'applied'], ['archive_then_remove', 'applied'],
    ]);
    expect(resolved.applyResults?.[0].detail).toBe('Promoted to [topic.md#3].');
    expect(read('topic.md')).toContain(`### <a id="3"></a>3. Re-read writes`);
    expect(read('topic.md')).toContain(PROMOTE_TEXT);
    // The numbered entry went to the discard log first, then was tombstoned.
    expect(read('discard-log.md')).toContain('> Drop me.');
    expect(read('discard-log.md')).toContain('- Reason: stale');
    expect(read('topic.md')).toContain('2. REMOVED -> discard-log.md');
    expect(read('topic.md')).not.toContain('Drop me.');
    // A pinned message is archived verbatim, then unpinned (message kept).
    expect(read('discard-log.md')).toContain('> Remember the duplicate reminder.');
    expect(read('discard-log.md')).toContain(`- Proposal: ${proposal.id}`);
    expect(isPinned(pinned)).toBe(false);
    expect(activities()).toEqual(expect.arrayContaining(['consolidation_applied', 'consolidation_resolved']));
  });

  it('reject: changes only the proposal status', () => {
    const pinned = pinnedMessage('Keep me pinned.');
    const proposal = saveConsolidationProposal(repository.database, [promote(), archiveEntry(), archivePinned(pinned)]);
    const files = ['topic.md', 'discard-log.md'].map(read);
    const catalogue = readFileSync(join(root, 'docs/shared-memory.md'), 'utf8');

    const resolved = resolveConsolidationProposal(repository, proposal.id, 'rejected', directories)!;

    expect(resolved.status).toBe('rejected');
    expect(resolved.applyResults).toBeNull();
    expect(['topic.md', 'discard-log.md'].map(read)).toEqual(files);
    expect(readFileSync(join(root, 'docs/shared-memory.md'), 'utf8')).toBe(catalogue);
    expect(isPinned(pinned)).toBe(true);
    expect(activities()).not.toContain('consolidation_applied');
    expect(resolveConsolidationProposal(repository, proposal.id, 'accepted', directories)).toBeNull();
  });

  it('partial failure: stops at the first failure, keeps the promotion, removes nothing unconfirmed', () => {
    const secretPin = pinnedMessage('password = hunter2hunter2');
    const proposal = saveConsolidationProposal(repository.database, [archivePinned(secretPin), archiveEntry(), promote()]);

    const resolved = resolveConsolidationProposal(repository, proposal.id, 'accepted', directories)!;

    expect(resolved.status).toBe('partially_applied');
    expect(resolved.applyResults?.map((result) => result.status)).toEqual(['applied', 'failed', 'not_attempted']);
    expect(resolved.applyResults?.[1]).toMatchObject({ provenanceId: `pinned_message:${secretPin}`, verdict: 'archive_then_remove' });
    // The promotion stays; it is not rolled back.
    expect(read('topic.md')).toContain(PROMOTE_TEXT);
    // The failed source was not unpinned and nothing reached the log or tombstone.
    expect(isPinned(secretPin)).toBe(true);
    expect(read('discard-log.md')).toBe('tier: workbench\n');
    expect(read('topic.md')).toContain('Drop me.');
    expect(read('topic.md')).not.toContain('REMOVED');
    expect(getConsolidationProposal(repository.database, proposal.id)?.status).toBe('partially_applied');
    expect(activities()).toContain('consolidation_apply_failed');
  });

  it('pending guard: no new proposal while one is pending', async () => {
    const build = vi.fn(async () => ({ items: [promote()], dropped: [] }));

    const first = await createConsolidationProposal(repository, { build, directories });
    const second = await createConsolidationProposal(repository, { build, directories });

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('pending');
    expect(second.proposal?.id).toBe(first.proposal?.id);
    expect(build).toHaveBeenCalledTimes(1);
    expect(repository.database.prepare('SELECT COUNT(*) AS n FROM consolidation_proposals').get()).toEqual({ n: 1 });

    resolveConsolidationProposal(repository, first.proposal!.id, 'rejected', directories);
    expect((await createConsolidationProposal(repository, { build, directories })).outcome).toBe('created');
  });
});
