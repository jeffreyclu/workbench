import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildConsolidationProposal, getConsolidationProposal, saveConsolidationProposal, sourceLevelClaim, type ConsolidationModel } from './consolidation-proposal.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { ShortTermMemoryStore } from './short-term-memory.js';

const fixtureRoot = join(import.meta.dirname, 'fixtures/consolidation');
const directories = { shared: join(fixtureRoot, 'shared'), knowledge: join(fixtureRoot, 'knowledge') };
const records = JSON.parse(readFileSync(join(fixtureRoot, 'records.json'), 'utf8')) as {
  duplicate: { author: 'jeffrey'; body: string };
  staleRun: { learning: string };
  reusableFinding: { title: string; facts: string };
};
const RUN_ID = '3f1c2b9e-0a4d-4c55-9d1e-6b7a8c9d0e1f';

interface Seeded {
  database: WorkbenchDatabase;
  shortTermMemory: ShortTermMemoryStore;
  ids: { duplicate: string; staleRun: string; reusableFinding: string };
}

function stubModel(items: unknown[], prompts: string[] = []): ConsolidationModel {
  return async (prompt) => {
    prompts.push(prompt);
    return `Here is the proposal:\n${JSON.stringify({ items })}`;
  };
}

describe('consolidation proposal', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function seed(): Seeded {
    const root = mkdtempSync(join(tmpdir(), 'workbench-consolidation-'));
    roots.push(root);
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database, 'America/New_York', null);

    const pins = repository.createConversation('Pinned reminders');
    const pinned = repository.createSharedMessage(records.duplicate.author, records.duplicate.body, 'completed', pins.id);
    database.prepare('UPDATE shared_messages SET pinned = 1 WHERE id = ?').run(pinned.id);

    const finding = repository.createConversation(records.reusableFinding.title);
    const message = repository.createSharedMessage('jeffrey', records.reusableFinding.facts, 'completed', finding.id);
    repository.recordSharedBriefEntry(finding.id, message.id, 'jeffrey', 'decision', records.reusableFinding.facts);

    const now = '2026-10-01T00:00:00.000Z';
    database.exec(`INSERT INTO work_items (id, title, queue_position, created_at, updated_at) VALUES ('item-1', 'Run fixture', 1, '${now}', '${now}');
      INSERT INTO agent_runs (id, work_item_id, kind, requested_target, agent, status, created_at) VALUES ('${RUN_ID}', 'item-1', 'execute', 'claude', 'claude', 'completed', '${now}');`);
    database.prepare(`INSERT INTO agent_run_review_handoffs (agent_run_id, summary, changes_json, acceptance_criteria_json, contract_changes_json,
      verification_json, uncertainties_json, tradeoffs_json, learnings_json, created_at) VALUES (?, 'Run fixture.', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?)`)
      .run(RUN_ID, JSON.stringify([records.staleRun.learning]), now);

    return {
      database,
      shortTermMemory: new ShortTermMemoryStore(database, root),
      ids: { duplicate: `pinned_message:${pinned.id}`, staleRun: `run_learning:${RUN_ID}#0`, reusableFinding: `short_term_memory:${finding.id}` },
    };
  }

  it('turns the fixture corpus into exactly covered, archive-then-remove, and promote', async () => {
    const { database, shortTermMemory, ids } = seed();
    const prompts: string[] = [];
    const logs: string[] = [];
    const result = await buildConsolidationProposal({ database, shortTermMemory, directories }, {
      log: (message) => logs.push(message),
      model: stubModel([
        { provenanceId: ids.duplicate, verdict: 'keep', coveredBy: '[engineering.md#1]' },
        { provenanceId: ids.staleRun, verdict: 'archive_then_remove', reason: 'One-off run state; already resolved.' },
        { provenanceId: ids.reusableFinding, verdict: 'promote', targetFile: 'engineering.md', title: 'Run learnings live in the handoff table', text: records.reusableFinding.facts },
      ], prompts),
    });

    expect(result.dropped).toEqual([]);
    expect(logs).toEqual([]);
    expect(result.items).toEqual([
      { provenanceId: ids.duplicate, provenance: { source: 'pinned_message', id: ids.duplicate.split(':')[1] }, verdict: 'keep', coveredBy: '[engineering.md#1]' },
      { provenanceId: ids.staleRun, provenance: { source: 'run_learning', id: RUN_ID, learningIndex: 0 }, verdict: 'archive_then_remove', reason: 'One-off run state; already resolved.' },
      { provenanceId: ids.reusableFinding, provenance: { source: 'short_term_memory', id: ids.reusableFinding.split(':')[1] }, verdict: 'promote', targetFile: 'engineering.md', title: 'Run learnings live in the handoff table', text: records.reusableFinding.facts },
    ]);
    // Every input reaches the cheap pass, including existing numbered entries from both catalogues.
    expect(prompts).toHaveLength(1);
    for (const id of [...Object.values(ids), 'memory_entry:engineering.md#1', 'memory_entry:writer.md#1']) expect(prompts[0]).toContain(`"provenanceId":"${id}"`);
    expect(prompts[0]).not.toContain('Pinned reminders');
  });

  it('rejects an unresolvable "already covered" citation before it can be stored or displayed', async () => {
    const { database, shortTermMemory, ids } = seed();
    const logs: string[] = [];
    const result = await buildConsolidationProposal({ database, shortTermMemory, directories }, {
      log: (message) => logs.push(message),
      model: stubModel([
        { provenanceId: ids.duplicate, verdict: 'keep', coveredBy: '[engineering.md#9]' },
        { provenanceId: ids.staleRun, verdict: 'keep', coveredBy: 'engineering.md#1' },
        { provenanceId: 'memory_entry:engineering.md#1', verdict: 'keep', coveredBy: '[engineering.md#1]' },
        { provenanceId: 'memory_entry:writer.md#1', verdict: 'keep', coveredBy: '[missing.md#1]' },
      ]),
    });

    expect(result.items).toEqual([]);
    expect(result.dropped.map((drop) => drop.provenanceId)).toEqual([ids.duplicate, ids.staleRun, 'memory_entry:engineering.md#1', 'memory_entry:writer.md#1']);
    expect(logs).toHaveLength(4);
    expect(logs[0]).toContain('[engineering.md#9] does not resolve');
    const stored = getConsolidationProposal(database, saveConsolidationProposal(database, result.items).id);
    expect(stored?.items).toEqual([]);
  });

  it('drops promotes to unindexed files, secret-like text, unresolved inline citations, and unknown provenance', async () => {
    const { database, shortTermMemory, ids } = seed();
    const result = await buildConsolidationProposal({ database, shortTermMemory, directories }, {
      log: () => undefined,
      model: stubModel([
        { provenanceId: ids.reusableFinding, verdict: 'promote', targetFile: 'index.md', title: 'Wrong target', text: 'Body.' },
        { provenanceId: ids.duplicate, verdict: 'promote', targetFile: 'engineering.md', title: 'Leaked', text: 'Set api_key = abcdefghijklmnop before running.' },
        { provenanceId: ids.staleRun, verdict: 'promote', targetFile: 'writer.md', title: 'Bad cite', text: 'See [writer.md#4].' },
        { provenanceId: 'pinned_message:not-a-candidate', verdict: 'archive_then_remove', reason: 'Invented.' },
        { provenanceId: ids.reusableFinding, verdict: 'unsure' },
      ]),
    });

    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([
      { provenanceId: ids.reusableFinding, reason: 'promote target index.md is not an indexed memory file' },
      { provenanceId: ids.duplicate, reason: 'promote text looks like it contains a secret (credential assignment)' },
      { provenanceId: ids.staleRun, reason: 'promote text cites [writer.md#4], which does not resolve to an existing entry' },
      { provenanceId: 'pinned_message:not-a-candidate', reason: 'unknown provenance id' },
      { provenanceId: ids.reusableFinding, reason: 'malformed verdict' },
    ]);
  });

  it('never archives a record that makes a source-level claim, whatever its source', async () => {
    const { database, shortTermMemory, ids } = seed();
    const result = await buildConsolidationProposal({ database, shortTermMemory, directories }, {
      log: () => undefined,
      model: stubModel([{ provenanceId: ids.reusableFinding, verdict: 'archive_then_remove', reason: 'Looks stale.' }]),
    });

    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([{ provenanceId: ids.reusableFinding, reason: 'archive-then-remove refused: the record makes a source-level claim (file:line)' }]);
  });

  it('recognises source-level claims by content', () => {
    expect(sourceLevelClaim(records.reusableFinding.facts)).toBe('file:line');
    expect(sourceLevelClaim('Mapped in `run-repository.ts#L52`.')).toBe('file:line');
    expect(sourceLevelClaim('Tracked upstream: https://github.com/vitest-dev/vitest/issues/1234')).toBe('upstream issue');
    expect(sourceLevelClaim('See [the bug](https://github.com/org/repo/pull/77).')).toBe('upstream issue');
    expect(sourceLevelClaim('Same as nodejs/node#51234.')).toBe('upstream issue');
    expect(sourceLevelClaim('Only broken in marked@18.0.10.')).toBe('version-specific behaviour');
    expect(sourceLevelClaim('Fixed in v22.5 of Node.')).toBe('version-specific behaviour');
    expect(sourceLevelClaim(records.staleRun.learning)).toBeNull();
    expect(sourceLevelClaim('Rated 4.5 out of 5 at 10:30; see the README.')).toBeNull();
  });

  it('stores a pending proposal and supersedes the previous pending one', () => {
    const database = openDatabase(':memory:');
    const first = saveConsolidationProposal(database, []);
    const second = saveConsolidationProposal(database, [{ provenanceId: 'memory_entry:engineering.md#1', provenance: { source: 'memory_entry', id: 'engineering.md#1' }, verdict: 'keep', coveredBy: null }]);

    expect(getConsolidationProposal(database, first.id)).toMatchObject({ status: 'superseded', resolvedAt: second.createdAt });
    expect(getConsolidationProposal(database, second.id)).toMatchObject({ status: 'pending', resolvedAt: null, items: second.items });
    expect(() => database.prepare("UPDATE consolidation_proposals SET status = 'applied' WHERE id = ?").run(second.id)).toThrow();
  });

  it('creates consolidation proposal storage when upgrading from migration 091', () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-db-test-'));
    roots.push(root);
    const path = join(root, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE consolidation_proposals;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '092_consolidation_proposals'").run();
    expect(current.prepare("SELECT id FROM schema_migrations WHERE id = '091_agent_run_review_dispatch'").get()).toBeTruthy();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'consolidation_proposals'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '092_consolidation_proposals'").get()).toBeTruthy();
    const columns = upgraded.prepare('PRAGMA table_info(consolidation_proposals)').all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(['id', 'status', 'items_json', 'created_at', 'resolved_at']);
    upgraded.close();
  });
});
