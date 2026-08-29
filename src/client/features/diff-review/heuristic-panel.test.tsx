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

const summaryWords = () => document.querySelector('.diff-review-heuristic-summary')!
  .textContent!.trim().split(/\s+/).filter(Boolean).length;

describe('diff review heuristic panel', () => {
  it('opens with a plain sentence saying what the change is and how big it is', () => {
    open(decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/added.ts', fileStatus: 'added', lines: ['+export function created() { return 1; }'] })],
    }));
    expect(screen.getByText(/Adds new code — \+1\/−0 lines in 1 file\./)).toBeInTheDocument();
  });

  it('stays under the word budget even when every warning applies at once', () => {
    open(decision({
      changeType: 'docs_comment',
      hunks: [hunk({
        filePath: 'src/thing.ts',
        lines: [
          '-export function alpha() { return 1; }', '-export function beta() { return 2; }',
          '-export function gamma() { return 3; }', '-export function delta() { return 4; }',
          '+export function alpha() { return compute(); }', '+export function created() { return alpha() + beta(); }',
        ],
      })],
    }));
    expect(summaryWords()).toBeLessThanOrEqual(100);
    expect(summaryWords()).toBeGreaterThan(0);
  });

  it('never drops a warning to make room, because the warnings are the reason to read it', () => {
    open(decision({
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-export function removed() {}', '+const kept = 1;'] })],
    }));
    expect(document.querySelector('.diff-review-heuristic-warn')).toHaveTextContent('Drops removed with nothing put back.');
  });

  it('says a stored verdict is stale in one sentence instead of a disagreement table', () => {
    open(decision({
      changeType: 'docs_comment',
      hunks: [hunk({ filePath: 'src/thing.ts', fileStatus: 'added', lines: ['+export function created() { return 1; }'] })],
    }));
    expect(screen.getByText('Saved as Docs, which no longer matches.')).toBeInTheDocument();
  });

  it('says when a new declaration is named by no test anywhere in the review', () => {
    open(decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/created.ts', fileStatus: 'added', lines: ['+export function uncovered() { return 1; }'] })],
    }));
    expect(screen.getByText(/No test in this review touches uncovered\./)).toBeInTheDocument();
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
    expect(screen.getByText(/Covered by src\/created\.test\.ts\./)).toBeInTheDocument();
  });

  it('reduces the parity requirement to the one question it actually asks', () => {
    open(decision({
      changeType: 'replacement',
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-export function run() { return 1; }', '+export function run() { return compute(); }'] })],
    }));
    expect(screen.getByText(/It claims behaviour is unchanged/)).toBeInTheDocument();
    // A change meant to differ gets no parity line at all, rather than a
    // paragraph explaining why the table does not apply.
    cleanup();
    open(decision({ changeType: 'behavior_edit', hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-const a = 1;', '+const b = 2;'] })] }));
    expect(screen.queryByText(/claims behaviour is unchanged/)).not.toBeInTheDocument();
  });

  it('spends the budget instead of stopping at the verdict, because one line is the label the reviewer already had', () => {
    open(decision({
      changeType: 'behavior_edit',
      hunks: [
        hunk({
          filePath: 'src/thing.ts',
          lines: [
            '-export function parseHeader(raw) { return raw.split(":"); }',
            '+export function parseHeader(raw) { return raw.split(":", 2); }',
            '+export function parseTrailer(raw) { return raw.trim(); }',
          ],
        }),
        hunk({ filePath: 'docs/thing.md', lines: ['+Documented.'] }),
      ],
    }));
    expect(summaryWords()).toBeGreaterThanOrEqual(40);
    expect(summaryWords()).toBeLessThanOrEqual(100);
  });

  it('says why the verdict came out that way, in words rather than the rule trace', () => {
    open(decision({
      changeType: 'refactor_pure',
      hunks: [hunk({
        filePath: 'src/thing.ts',
        lines: ['-export function run() { return compute(a, b); }', '+export function run() { return compute(a, b, c); }'],
      })],
    }));
    expect(screen.getByText(/removed and added back under the same name/)).toBeInTheDocument();
  });

  it('stays collapsed until asked, so it does not compete with the diff for attention', () => {
    render(<DiffReviewHeuristicPanel decision={decision({ hunks: [hunk({ filePath: 'src/thing.ts', lines: ['+const a = 1;'] })] })} />);
    expect(document.querySelector('.diff-review-heuristic-summary')).toBeNull();
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
});
