import { describe, expect, it } from 'vitest';
import type { ReviewDecision, ReviewDiffHunk } from '../diff-review/logic.js';
import { buildDiffLines } from '../diff-review/logic.js';
import type { ResolvedReviewNote, ReviewNote } from './notes-logic.js';
import { buildOutcomeQueue, buildReviewOutcome, ledgerVerdictsOf, reviewOutcomeStatus, stepOutcomeQueue, whitespaceOnlyFiles } from './outcome-logic.js';

const decision = (id: string, ordinal: number, filePath: string, state: ReviewDecision['state'], note: string | null = null) =>
  ({ id, ordinal, behavior: `Behavior ${ordinal}`, filePaths: [filePath], state, note }) as ReviewDecision;
const note = (id: string, filePath: string, resolved = false): ReviewNote => ({ id, body: `Body ${id}`, resolved, createdAt: 't', anchor: { filePath, hunkRange: 'r', startIndex: 0, endIndex: 0, excerpt: '+x' } });
const live = (n: ReviewNote): ResolvedReviewNote => ({ note: n, target: { hunkId: 'h', lineKey: 'k', lineNumber: 1, kind: 'addition' } });
const hunk = (lines: string[]) => ({ range: '@@ -1 +1 @@', lines: buildDiffLines('@@ -1 +1 @@', lines) }) as unknown as ReviewDiffHunk;

describe('reviewOutcomeStatus', () => {
  const counts = (over: Partial<Parameters<typeof reviewOutcomeStatus>[0]>) => ({ total: 3, approved: 3, needsChanges: 0, commented: 0, pending: 0, ...over });
  it('follows the GitHub model: changes requested beats pending beats commented beats approved', () => {
    expect(reviewOutcomeStatus(counts({ needsChanges: 1, pending: 1 }), 0)).toBe('needs_changes');
    expect(reviewOutcomeStatus(counts({ pending: 1 }), 0)).toBe('pending');
    expect(reviewOutcomeStatus(counts({ commented: 1 }), 0)).toBe('commented');
    expect(reviewOutcomeStatus(counts({}), 2)).toBe('commented');
    expect(reviewOutcomeStatus(counts({}), 0)).toBe('approved');
  });
});

describe('ledgerVerdictsOf', () => {
  it('keeps only decisions the agent ledger recorded as blocking or non-blocking', () => {
    const verdicts = ledgerVerdictsOf([
      decision('a', 1, 'a.ts', 'needs_changes', 'Agent review (x, t):\n…'),
      decision('b', 2, 'b.ts', 'commented', 'Agent review (x, t):\n…'),
      decision('c', 3, 'c.ts', 'needs_changes', 'Mine'),
      decision('d', 4, 'd.ts', 'reviewed', 'Agent review (x, t):\n…'),
    ]);
    expect(verdicts.map((v) => [v.ordinal, v.severity])).toEqual([[1, 'blocking'], [2, 'non-blocking']]);
  });
});

describe('whitespaceOnlyFiles', () => {
  it('lists files whose every hunk only changes whitespace', () => {
    const blank = hunk(['-a  b', '+a b']);
    const real = hunk(['-a', '+b']);
    expect(whitespaceOnlyFiles(new Map([['ws.ts', [blank]], ['mixed.ts', [blank, real]], ['empty.ts', []]]))).toEqual(['ws.ts']);
  });
});

describe('outcome queue', () => {
  const decisions = [decision('d1', 1, 'b.ts', 'needs_changes'), decision('d2', 2, 'a.ts', 'needs_changes'), decision('d3', 3, 'a.ts', 'reviewed')];
  const groups = [{ filePath: 'b.ts', notes: [live(note('n1', 'b.ts')), { note: note('n2', 'b.ts'), target: null }] }, { filePath: 'a.ts', notes: [live(note('n3', 'a.ts', true)), live(note('n4', 'a.ts'))] }];
  const queue = buildOutcomeQueue(decisions, groups, ['a.ts', 'b.ts']);

  it('orders unresolved items by file, decisions before notes, skipping resolved and outdated notes', () => {
    expect(queue.map((item) => item.key)).toEqual(['decision:d2', 'note:n4', 'decision:d1', 'note:n1']);
  });

  it('steps with wrap-around, starting at the ends when nothing is current', () => {
    expect(stepOutcomeQueue(queue, null, 1)?.key).toBe('decision:d2');
    expect(stepOutcomeQueue(queue, null, -1)?.key).toBe('note:n1');
    expect(stepOutcomeQueue(queue, 'note:n1', 1)?.key).toBe('decision:d2');
    expect(stepOutcomeQueue(queue, 'decision:d2', -1)?.key).toBe('note:n1');
    expect(stepOutcomeQueue([], null, 1)).toBeNull();
  });

  it('totals decisions, unresolved feedback and fix requests', () => {
    const outcome = buildReviewOutcome({ decisions, noteGroups: groups, noteSummary: { unresolved: 2, resolved: 1, outdated: 1 }, hunksByFile: new Map(), fixRequests: 1 });
    expect(outcome).toMatchObject({ status: 'needs_changes', unresolvedFeedback: 4, fixRequests: 1, decisions: { approved: 1, needsChanges: 2 } });
  });
});
