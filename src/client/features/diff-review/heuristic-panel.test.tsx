// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewDecision, ReviewDecisionHunk } from './logic.js';
import { DiffReviewHeuristicPanel } from './heuristic-panel.js';

afterEach(cleanup);

const hunk = (over: Partial<ReviewDecisionHunk> & { filePath: string; lines: string[] }): ReviewDecisionHunk => ({
  id: `${over.filePath}::@@`, fileStatus: 'modified', editorUrl: null, hunkRange: '@@ -1 +1 @@',
  location: 'Line 1', additions: 1, deletions: 1, state: null, note: null, ...over,
});

const decision = (over: Partial<ReviewDecision> & { hunks: ReviewDecisionHunk[] }): ReviewDecision => ({
  id: 'decision', ordinal: 1, subject: 'example', behavior: 'Example.',
  filePaths: [...new Set(over.hunks.map((entry) => entry.filePath))],
  additions: 1, deletions: 1, changeType: 'behavior_edit', secondaryChangeTypes: [],
  riskSignals: [], state: null, note: null, ...over,
});

function open(subject: ReviewDecision, all: ReviewDecision[] = []) {
  render(<DiffReviewHeuristicPanel decision={subject} decisions={all} />);
  fireEvent.click(screen.getByRole('button'));
}

describe('diff review heuristic panel', () => {
  it('names the rule that decided the type, so the verdict can be checked rather than trusted', () => {
    open(decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/added.ts', fileStatus: 'added', lines: ['+export function created() { return 1; }'] })],
    }));
    const fired = document.querySelector('.outcome-fired');
    expect(fired).toHaveTextContent('Is any of this in a newly added file?');
    expect(fired).toHaveTextContent('New code');
  });

  it('distinguishes a rule that was checked and did not hold from one that was never reached', () => {
    open(decision({
      changeType: 'docs_comment',
      hunks: [hunk({ filePath: 'docs/guide.md', lines: ['+Some prose.'] })],
    }));
    // Documentation is decided in the file pass, so every later rule is
    // short-circuited — and says so instead of reading as a negative finding.
    expect(document.querySelectorAll('.outcome-not_reached').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Not reached/)[0]).toBeInTheDocument();
  });

  it('shows the measurement each rule read, including the similarity score behind a refactor call', () => {
    open(decision({
      changeType: 'refactor_pure',
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-const total = a + b;', '+const total = a + b + 0;'] })],
    }));
    expect(screen.getByText(/Sørensen–Dice similarity \d+%/)).toBeInTheDocument();
  });

  it('reports a declaration the change drops even when the change reads as something else', () => {
    open(decision({
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-export function removed() {}', '+const kept = 1;'] })],
    }));
    expect(screen.getByText('Dropped')).toBeInTheDocument();
    expect(document.querySelector('.diff-review-heuristic-flag')).toHaveTextContent('removed');
  });

  it('explains why the parity table does not apply to a change that is meant to differ', () => {
    open(decision({ changeType: 'behavior_edit', hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-const a = 1;', '+const b = 2;'] })] }));
    expect(screen.getByText(/would report every intended change as a difference/)).toBeInTheDocument();
  });

  it('requires the parity axes on a replacement, and lists them', () => {
    open(decision({
      changeType: 'replacement',
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-export function run() { return 1; }', '+export function run() { return compute(); }'] })],
    }));
    for (const axis of ['SIGNATURE', 'ERROR HANDLING', 'ORDERING', 'COMPLEXITY']) {
      expect(screen.getByText(axis)).toBeInTheDocument();
    }
  });

  it('finds the covering test in a sibling decision, because a test never shares a decision with the code it covers', () => {
    const subject = decision({
      id: 'code', changeType: 'new_code',
      hunks: [hunk({ id: 'code-hunk', filePath: 'src/created.ts', fileStatus: 'added', lines: ['+export function created() { return 1; }'] })],
    });
    const test = decision({
      id: 'test', changeType: 'test_only',
      hunks: [hunk({ id: 'test-hunk', filePath: 'src/created.test.ts', fileStatus: 'added', lines: ["+it('works', () => expect(created()).toBe(1));"] })],
    });
    open(subject, [subject, test]);
    expect(screen.getByText(/src\/created\.test\.ts/)).toBeInTheDocument();
  });

  it('says when a new declaration is named by no test anywhere in the review', () => {
    open(decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/created.ts', fileStatus: 'added', lines: ['+export function uncovered() { return 1; }'] })],
    }));
    expect(screen.getByText(/No test hunk anywhere in this diff mentions uncovered/)).toBeInTheDocument();
  });

  it('flags a stored verdict that no longer matches what the classifier produces', () => {
    open(decision({
      changeType: 'docs_comment',
      hunks: [hunk({ filePath: 'src/thing.ts', fileStatus: 'added', lines: ['+export function created() { return 1; }'] })],
    }));
    expect(screen.getByText(/Stored verdict is Docs; recomputing here gives New code/)).toBeInTheDocument();
  });

  it('stays collapsed until asked, so it does not compete with the diff for attention', () => {
    render(<DiffReviewHeuristicPanel decision={decision({ hunks: [hunk({ filePath: 'src/thing.ts', lines: ['+const a = 1;'] })] })} />);
    expect(screen.queryByText('Rules, in the order they ran')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
});
