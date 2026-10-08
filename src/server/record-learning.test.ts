import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSecretPattern, recordLearning, RecordLearningError } from './record-learning.js';

describe('recordLearning', () => {
  let root: string;
  let directories: { shared: string; knowledge: string };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'record-learning-'));
    directories = { shared: join(root, 'docs/shared-memory'), knowledge: join(root, 'knowledge') };
    mkdirSync(directories.shared, { recursive: true });
    mkdirSync(directories.knowledge);
    writeFileSync(join(directories.shared, 'topic.md'), 'tier: workbench\n### <a id="1"></a>1. First\n\nOld.\n');
    writeFileSync(join(directories.shared, 'unindexed.md'), 'tier: workbench\n');
    writeFileSync(join(root, 'docs/shared-memory.md'), '| Path | Entries |\n| --- | ---: |\n| `topic.md` | 1 | workbench | core | k | — |\n');
    writeFileSync(join(directories.knowledge, 'index.md'), '| Path | Entries |\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('appends entry N+1 and increments the catalogue count', () => {
    const result = recordLearning({ file: 'topic.md', title: 'Second', body: 'New lesson.', tier: 'workbench', provenance: 'https://example.com/x' }, directories);
    expect(result).toMatchObject({ id: 2, citation: '[topic.md#2]', entries: 2 });
    expect(readFileSync(join(directories.shared, 'topic.md'), 'utf8')).toContain('### <a id="2"></a>2. Second\n\nNew lesson.\n\n*Provenance: https://example.com/x*');
    expect(readFileSync(join(root, 'docs/shared-memory.md'), 'utf8')).toContain('| `topic.md` | 2 |');
  });

  it('refuses unknown or unindexed files with the valid list', () => {
    for (const file of ['nope.md', 'unindexed.md']) {
      expect(() => recordLearning({ file, title: 't', body: 'b' }, directories)).toThrow(/Valid files: topic\.md/);
    }
  });

  it('rejects secrets, bad provenance, and tier mismatch without writing', () => {
    expect(() => recordLearning({ file: 'topic.md', title: 't', body: 'token=ghp_' + 'a'.repeat(36) }, directories)).toThrow(RecordLearningError);
    expect(() => recordLearning({ file: 'topic.md', title: 't', body: 'b', provenance: 'trust me' }, directories)).toThrow(/provenance/);
    expect(() => recordLearning({ file: 'topic.md', title: 't', body: 'b', tier: 'writer' }, directories)).toThrow(/tier/);
    expect(readFileSync(join(directories.shared, 'topic.md'), 'utf8')).not.toContain('a id="2"');
    expect(findSecretPattern('plain lesson text')).toBeNull();
  });
});
