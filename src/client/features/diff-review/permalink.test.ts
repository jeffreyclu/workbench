import { describe, expect, it } from 'vitest';
import { buildFileDiffHunks, type ReviewDecision } from './logic.js';
import { hunkAnchor, lineAddress, parsePermalinkHash, permalinkHash, permalinkUrl, resolvePermalink } from './permalink.js';

const patch = [
  '@@ -1,3 +1,3 @@ alpha',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -20,2 +20,3 @@ beta',
  ' twenty',
  '+twenty-one',
  ' twenty-two',
].join('\n');
const hunks = buildFileDiffHunks({ path: 'src/a b.ts', patch, isBinary: false });
const hunksByFile = new Map([['src/a b.ts', hunks]]);
const decisions = hunks.map((hunk, index): ReviewDecision => ({
  id: `decision-${index}`,
  ordinal: index + 1,
  subject: 'subject',
  behavior: 'behavior',
  hunks: [{ id: hunk.decisionId, filePath: 'src/a b.ts', fileStatus: 'modified', editorUrl: null, hunkRange: hunk.range, location: hunk.location, contentHash: `hash-${index}`, lines: [], additions: 1, deletions: 0, state: null, note: null }],
  filePaths: ['src/a b.ts'],
  additions: 1,
  deletions: 0,
  changeType: 'behavior_edit',
  secondaryChangeTypes: [],
  riskSignals: [],
  state: null,
  note: null,
}));

describe('diff permalinks', () => {
  it('names a hunk by its two start lines, and a line by side and number', () => {
    expect(hunkAnchor('@@ -20,2 +20,3 @@ beta')).toBe('20,20');
    expect(hunkAnchor('Whole-file change')).toBeNull();
    expect(lineAddress({ kind: 'deletion', oldLine: 2, newLine: null })).toEqual({ side: 'old', number: 2 });
    expect(lineAddress({ kind: 'context', oldLine: 1, newLine: 1 })).toEqual({ side: 'new', number: 1 });
  });

  it('round-trips a link through the fragment, including a path that needs escaping', () => {
    const target = { filePath: 'src/a b.ts', hunk: '20,20', line: { side: 'new' as const, number: 21 } };
    expect(parsePermalinkHash(permalinkHash(target))).toEqual(target);
    expect(permalinkHash({ filePath: 'x.ts', hunk: null, line: { side: 'old', number: 2 } })).toBe('#diff=x.ts&line=o2');
    expect(permalinkUrl({ origin: 'https://wb.test', pathname: '/work/1', search: '?tab=changes' }, { filePath: 'x.ts', hunk: null, line: null })).toBe('https://wb.test/work/1?tab=changes#diff=x.ts');
  });

  it('ignores fragments that are not diff links and malformed parts of ones that are', () => {
    expect(parsePermalinkHash('')).toBeNull();
    expect(parsePermalinkHash('#section-2')).toBeNull();
    expect(parsePermalinkHash('#diff=x.ts&hunk=abc&line=z9')).toEqual({ filePath: 'x.ts', hunk: null, line: null });
  });

  it('resolves a new-side line, an old-side line and a bare hunk to the row they name', () => {
    const added = resolvePermalink({ filePath: 'src/a b.ts', hunk: null, line: { side: 'new', number: 21 } }, hunksByFile, decisions);
    expect(added).toMatchObject({ decisionId: 'decision-1', kind: 'addition', newLine: 21, lineKey: `${hunks[1].range}:1` });
    const deleted = resolvePermalink({ filePath: 'src/a b.ts', hunk: null, line: { side: 'old', number: 2 } }, hunksByFile, decisions);
    expect(deleted).toMatchObject({ decisionId: 'decision-0', kind: 'deletion', newLine: null });
    const hunk = resolvePermalink({ filePath: 'src/a b.ts', hunk: '20,20', line: null }, hunksByFile, decisions);
    expect(hunk).toMatchObject({ decisionId: 'decision-1', lineKey: null, newLine: 20 });
  });

  it('degrades a stale line to its hunk and a plain-context line to the nearest change', () => {
    expect(resolvePermalink({ filePath: 'src/a b.ts', hunk: '20,20', line: { side: 'new', number: 99 } }, hunksByFile, decisions)).toMatchObject({ decisionId: 'decision-1', lineKey: null });
    expect(resolvePermalink({ filePath: 'src/a b.ts', hunk: null, line: { side: 'new', number: 18 } }, hunksByFile, decisions)).toMatchObject({ decisionId: 'decision-1', lineKey: null, newLine: 18 });
  });

  it('returns null when the file is not in the diff', () => {
    expect(resolvePermalink({ filePath: 'gone.ts', hunk: null, line: null }, hunksByFile, decisions)).toBeNull();
  });
});
