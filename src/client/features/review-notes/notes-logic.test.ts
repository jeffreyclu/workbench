import { describe, expect, it } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import { buildFileDiffHunks } from '../diff-review/logic.js';
import {
  anchorForLines, createReviewNote, groupReviewNotes, loadReviewNotes, nextUnresolvedNote, resolveReviewNote, saveReviewNotes, storageKeyForScope, summarizeReviewNotes,
} from './notes-logic.js';

const file = (path: string, patch: string): WorkspaceDiffFile => ({ path, previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch });
const alpha = file('src/alpha.ts', '@@ -1,3 +1,3 @@ alpha\n one\n-before\n+after\n three');
const beta = file('src/beta.ts', '@@ -5,2 +5,2 @@ beta\n-old\n+fresh');
const hunksByFile = new Map([alpha, beta].map((f) => [f.path, buildFileDiffHunks(f)] as const));

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return { items, getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v), removeItem: (k: string) => void items.delete(k) };
}

const noteOn = (filePath: string, startIndex: number, id: string, extra: { resolved?: boolean; excerpt?: string } = {}) => {
  const hunk = hunksByFile.get(filePath)![0]!;
  const note = createReviewNote({ filePath, hunkRange: hunk.range, startIndex, endIndex: startIndex, excerpt: extra.excerpt ?? hunk.lines[startIndex]!.text }, ` body ${id} `, id, '2026-10-09T00:00:00.000Z');
  return { ...note, resolved: extra.resolved ?? false };
};

describe('review note anchors', () => {
  it('builds an anchor and a readable label from a highlighted run of lines', () => {
    const hunk = hunksByFile.get('src/alpha.ts')![0]!;
    const hunks = hunksByFile.get('src/alpha.ts')!;
    const span = anchorForLines('src/alpha.ts', hunks, { hunkRange: hunk.range, startIndex: 0, endIndex: 3 });
    expect(span?.label).toBe('src/alpha.ts · lines 1–3');
    expect(span?.anchor.excerpt).toBe(hunk.lines[0]!.text);
    expect(anchorForLines('src/alpha.ts', hunks, { hunkRange: hunk.range, startIndex: 1, endIndex: 1 })?.label).toBe('src/alpha.ts · line 2');
    expect(anchorForLines('src/alpha.ts', hunksByFile.get('src/alpha.ts')!, { hunkRange: hunk.range, startIndex: 0, endIndex: 99 })).toBeNull();
  });

  it('resolves a note to its hunk and line, and reports it outdated once the code under it changed', () => {
    const live = resolveReviewNote(noteOn('src/alpha.ts', 2, 'a'), hunksByFile);
    expect(live.target?.kind).toBe('addition');
    expect(live.target?.lineKey).toBe(`${hunksByFile.get('src/alpha.ts')![0]!.range}:2`);
    expect(resolveReviewNote(noteOn('src/alpha.ts', 2, 'b', { excerpt: '+something else' }), hunksByFile).target).toBeNull();
    expect(resolveReviewNote(noteOn('src/alpha.ts', 2, 'c'), new Map()).target).toBeNull();
  });
});

describe('review note drafts', () => {
  it('round-trips through storage per scope and clears the key when empty', () => {
    const storage = memoryStorage();
    const notes = [noteOn('src/alpha.ts', 1, 'a')];
    expect(saveReviewNotes(storage, 'work-item:1', notes)).toBe(true);
    expect(loadReviewNotes(storage, 'work-item:1')).toEqual(notes);
    expect(loadReviewNotes(storage, 'work-item:2')).toEqual([]);
    saveReviewNotes(storage, 'work-item:1', []);
    expect(storage.items.has(storageKeyForScope('work-item:1'))).toBe(false);
  });

  it('survives corrupt storage and drops malformed entries', () => {
    expect(loadReviewNotes(memoryStorage({ [storageKeyForScope('s')]: '{nope' }), 's')).toEqual([]);
    const good = noteOn('src/alpha.ts', 1, 'a');
    expect(loadReviewNotes(memoryStorage({ [storageKeyForScope('s')]: JSON.stringify([good, { id: 1 }, null]) }), 's')).toEqual([good]);
  });

  it('reports a write the browser refused', () => {
    const refusing = { setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(saveReviewNotes(refusing, 's', [noteOn('src/alpha.ts', 1, 'a')])).toBe(false);
  });
});

describe('review note listing', () => {
  const resolved = [
    noteOn('src/beta.ts', 1, 'b1'),
    noteOn('src/alpha.ts', 3, 'a-late'),
    noteOn('src/alpha.ts', 1, 'a-early', { resolved: true }),
    noteOn('src/alpha.ts', 1, 'a-gone', { excerpt: 'stale' }),
  ].map((note) => resolveReviewNote(note, hunksByFile));

  it('groups by file with notes in line order and outdated ones last', () => {
    const groups = groupReviewNotes(resolved);
    expect(groups.map((g) => g.filePath)).toEqual(['src/beta.ts', 'src/alpha.ts']);
    expect(groups[1]!.notes.map((e) => e.note.id)).toEqual(['a-early', 'a-late', 'a-gone']);
  });

  it('summarizes open, resolved, outdated and file counts', () => {
    expect(summarizeReviewNotes(resolved)).toEqual({ total: 4, unresolved: 3, resolved: 1, outdated: 1, files: 2 });
  });

  it('walks unresolved, jumpable notes in drawer order and wraps', () => {
    const groups = groupReviewNotes(resolved);
    expect(nextUnresolvedNote(groups, null)?.note.id).toBe('b1');
    expect(nextUnresolvedNote(groups, 'b1')?.note.id).toBe('a-late');
    expect(nextUnresolvedNote(groups, 'a-late')?.note.id).toBe('b1');
    expect(nextUnresolvedNote([], null)).toBeNull();
  });
});
