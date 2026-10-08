import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiscardLogError, removeKnowledgeEntries } from './discard-log.js';

describe('removeKnowledgeEntries', () => {
  let root: string;
  let directories: { shared: string; knowledge: string };
  const read = (name: string) => readFileSync(join(directories.shared, name), 'utf8');
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'discard-log-'));
    directories = { shared: join(root, 'docs/shared-memory'), knowledge: join(root, 'knowledge') };
    mkdirSync(directories.shared, { recursive: true });
    mkdirSync(directories.knowledge);
    writeFileSync(join(directories.shared, 'topic.md'),
      'tier: workbench\n### <a id="1"></a>1. First\n\nKeep.\n\n### <a id="2"></a>2. Second\n\nDrop me.\nSecond line.\n\n### <a id="3"></a>3. Third\n\nSee [topic.md#2].\n');
    writeFileSync(join(directories.shared, 'discard-log.md'), 'tier: workbench\n');
    writeFileSync(join(root, 'docs/shared-memory.md'),
      '| Path | Entries |\n| --- | ---: |\n| `topic.md` | 3 | workbench | core | k | — |\n| `discard-log.md` | 0 | workbench | archive | d | — |\n');
    writeFileSync(join(directories.knowledge, 'index.md'), '| Path | Entries |\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('logs full text, tombstones the number, and matches counts', () => {
    const result = removeKnowledgeEntries({ file: 'topic.md', numbers: [2], reason: 'stale', supersededBy: { 2: '[topic.md#1]' }, date: '2026-10-15' }, directories);
    expect(result).toMatchObject({ removed: [2], logRecords: 1, logCitations: ['[discard-log.md#1]'] });
    const log = read('discard-log.md');
    expect(log).toContain('- Reason: stale');
    expect(log).toContain('- Superseded by: [topic.md#1]');
    expect(log).toContain('> ### <a id="2"></a>2. Second\n> \n> Drop me.\n> Second line.');
    const topic = read('topic.md');
    expect(topic).toContain('### <a id="2"></a>2. REMOVED -> discard-log.md 2026-10-15');
    expect(topic).not.toContain('Drop me.');
    expect(topic).toContain('Keep.');
    expect(topic).toContain('See [topic.md#2].');
    expect(read('../shared-memory.md')).toContain('| `discard-log.md` | 1 |');
  });

  it('removes several entries with one record each', () => {
    const result = removeKnowledgeEntries({ file: 'topic.md', numbers: [1, 3], reason: 'dup' }, directories);
    expect(result.logRecords).toBe(2);
    expect(read('topic.md')).not.toContain('Keep.');
    expect(read('discard-log.md').match(/^### <a id="\d+"><\/a>/gm)).toHaveLength(2);
  });

  it('removes nothing when the log is unavailable', () => {
    writeFileSync(join(root, 'docs/shared-memory.md'), '| Path | Entries |\n| --- | ---: |\n| `topic.md` | 3 | workbench | core | k | — |\n');
    const before = read('topic.md');
    expect(() => removeKnowledgeEntries({ file: 'topic.md', numbers: [2], reason: 'x' }, directories)).toThrow(DiscardLogError);
    expect(read('topic.md')).toBe(before);
  });

  it('removes nothing when the log write is refused', () => {
    writeFileSync(join(directories.shared, 'topic.md'), 'tier: workbench\n### <a id="1"></a>1. Leak\n\npassword = hunter2hunter2\n');
    const before = read('topic.md');
    expect(() => removeKnowledgeEntries({ file: 'topic.md', numbers: [1], reason: 'x' }, directories)).toThrow(/secret/);
    expect(read('topic.md')).toBe(before);
  });

  it('rejects bad input and double removal', () => {
    expect(() => removeKnowledgeEntries({ file: 'topic.md', numbers: [9], reason: 'x' }, directories)).toThrow(/no entry 9/);
    expect(() => removeKnowledgeEntries({ file: 'topic.md', numbers: [2], reason: ' ' }, directories)).toThrow(/reason/);
    expect(() => removeKnowledgeEntries({ file: 'discard-log.md', numbers: [1], reason: 'x' }, directories)).toThrow(/append-only/);
    removeKnowledgeEntries({ file: 'topic.md', numbers: [2], reason: 'x' }, directories);
    expect(() => removeKnowledgeEntries({ file: 'topic.md', numbers: [2], reason: 'x' }, directories)).toThrow(/already removed/);
  });
});
