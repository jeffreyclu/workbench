// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewDecision, ReviewDecisionHunk, StaleReferenceReport } from './logic.js';
import { DiffReviewHeuristicPanel } from './heuristic-panel.js';

afterEach(cleanup);

const hunk = (over: Partial<ReviewDecisionHunk> & { filePath: string; lines: string[] }): ReviewDecisionHunk => ({
  id: `${over.filePath}::@@`, fileStatus: 'modified', editorUrl: null, hunkRange: '@@ -1 +1 @@',
  location: 'Line 1', contentHash: 'hash-1', additions: 1, deletions: 1, state: null, note: null, ...over,
});

const decision = (over: Partial<ReviewDecision> & { hunks: ReviewDecisionHunk[] }): ReviewDecision => ({
  id: 'decision', ordinal: 1, subject: 'example', behavior: 'Example.',
  filePaths: [...new Set(over.hunks.map((entry) => entry.filePath))],
  additions: 1, deletions: 1, changeType: 'behavior_edit', secondaryChangeTypes: [],
  riskSignals: [], state: null, note: null, ...over,
});

function open(subject: ReviewDecision, all: ReviewDecision[] = [], staleReferences: StaleReferenceReport | null = null) {
  render(<DiffReviewHeuristicPanel decision={subject} decisions={all} staleReferences={staleReferences} />);
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

  it('stays under the word cap even when every warning applies at once', () => {
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
    // The cap is on explanations. The one-clause overflow line rides above it,
    // because a warning nobody is told about is worse than a longer summary.
    expect(summaryWords()).toBeLessThanOrEqual(150);
    expect(summaryWords()).toBeGreaterThan(0);
  });

  it('never drops a warning to make room, because the warnings are the reason to read it', () => {
    open(decision({
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-export function removed() {}', '+const kept = 1;'] })],
    }));
    expect(document.querySelector('.diff-review-heuristic-warn'))
      .toHaveTextContent(/removed is removed with nothing put back under the same name/);
  });

  it('says a stored verdict is stale in one sentence instead of a disagreement table', () => {
    open(decision({
      changeType: 'docs_comment',
      hunks: [hunk({ filePath: 'src/thing.ts', fileStatus: 'added', lines: ['+export function created() { return 1; }'] })],
    }));
    expect(screen.getByText(/saved as Docs, but classifying these exact hunks now gives/)).toBeInTheDocument();
  });

  it('says when a new declaration is named by no test anywhere in the review', () => {
    open(decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/created.ts', fileStatus: 'added', lines: ['+export function uncovered() { return 1; }'] })],
    }));
    expect(screen.getByText(/No test in this review touches uncovered\./)).toBeInTheDocument();
  });

  it('clears the untested warning from a sibling decision, because a test never shares a decision with the code it covers', () => {
    const subject = decision({
      id: 'code', changeType: 'new_code',
      hunks: [hunk({ id: 'code-hunk', filePath: 'src/created.ts', fileStatus: 'added', lines: ['+export function created() { return 1; }'] })],
    });
    const test = decision({
      id: 'test', changeType: 'test_only',
      hunks: [hunk({ id: 'test-hunk', filePath: 'src/created.test.ts', fileStatus: 'added', lines: ["+it('works', () => expect(created()).toBe(1));"] })],
    });
    open(subject, [subject, test]);
    // The covering hunk is not worth a sentence of its own — it lowers the cost
    // of the block, and the way it does that is by removing the warning.
    expect(screen.queryByText(/No test in this review touches/)).not.toBeInTheDocument();
  });

  it('asks the parity question once, folded into the rewrite it applies to', () => {
    open(decision({
      changeType: 'replacement',
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-export function run() { return 1; }', '+export function run() { return compute(); }'] })],
    }));
    expect(screen.getByText(/signature, error handling, ordering and cost/)).toBeInTheDocument();
    // The standalone parity sentence and the rewrite sentence make the same
    // request, so a rewrite in place gets one of them, never both.
    expect(screen.queryByText(/It claims behaviour is unchanged/)).not.toBeInTheDocument();
    // A change meant to differ gets no parity line at all, rather than a
    // paragraph explaining why the table does not apply.
    cleanup();
    open(decision({ changeType: 'behavior_edit', hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-const a = 1;', '+const b = 2;'] })] }));
    expect(screen.queryByText(/signature, error handling, ordering and cost/)).not.toBeInTheDocument();
  });

  it('explains rather than enumerates: no measurement is restated in a second form', () => {
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
    expect(summaryWords()).toBeLessThanOrEqual(130);
    const summary = document.querySelector('.diff-review-heuristic-summary')!.textContent!;
    // The size is stated once. The file list, the bucket mix and the
    // production-only split are the same fact in other words, so they are gone.
    expect(summary.match(/\+3\/−1/g)).toHaveLength(1);
    expect(summary).not.toMatch(/docs\/thing\.md/);
    expect(summary).not.toMatch(/production/);
  });

  it('leads with how much time the block is worth, not with the change type', () => {
    open(decision({
      changeType: 'behavior_edit', riskSignals: ['auth'],
      hunks: [hunk({ filePath: 'src/thing.ts', lines: ['-const a = 1;', '+const b = 2;'] })],
    }));
    expect(screen.getByRole('button')).toHaveTextContent('Heuristic · Read closely');
    expect(screen.getByText(/^Read closely\./)).toBeInTheDocument();
  });

  it('names a warning it had no room to explain, instead of dropping it', () => {
    open(decision({
      changeType: 'docs_comment', riskSignals: ['auth'],
      hunks: [hunk({
        filePath: 'src/thing.ts',
        lines: [
          '-export function alpha() { return 1; }', '-export function beta() { return 2; }',
          '+export function alpha() { return compute(); }', '+export function created() { return alpha(); }',
        ],
      })],
    }));
    expect(screen.getByText(/Also outstanding, with no room to explain here:.*saved under the wrong change type/))
      .toBeInTheDocument();
  });

  it('says a quiet block is cheap and names the checks that made it cheap', () => {
    open(decision({
      changeType: 'docs_comment',
      hunks: [hunk({ filePath: 'docs/thing.md', lines: ['+Documented.'] })],
    }));
    expect(screen.getByRole('button')).toHaveTextContent('Heuristic · Skim');
    expect(screen.getByText(/Everything that would argue for more time came back clean/)).toBeInTheDocument();
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

  it('names a reference left outside the change when the server reports one', () => {
    open(
      decision({ hunks: [hunk({ filePath: 'src/config.ts', lines: ['-export function loadConfig(path) {', '+export function loadConfig(path, mode) {'] })] }),
      [],
      {
        symbols: ['loadConfig'],
        staleSymbols: ['loadConfig'],
        truncated: false,
        references: [{ symbol: 'loadConfig', filePath: 'src/untouched.ts', line: 12, text: 'loadConfig(path)' }],
      },
    );
    expect(screen.getByText(/src\/untouched\.ts still references it/)).toBeInTheDocument();
  });

  it('ignores a stale reference to a symbol this decision does not own', () => {
    open(
      decision({ hunks: [hunk({ filePath: 'src/config.ts', lines: ['+export function added() { return 1; }'] })] }),
      [],
      {
        symbols: ['elsewhere'],
        staleSymbols: ['elsewhere'],
        truncated: false,
        references: [{ symbol: 'elsewhere', filePath: 'src/untouched.ts', line: 3, text: 'elsewhere()' }],
      },
    );
    expect(screen.queryByText(/still references it/)).not.toBeInTheDocument();
  });

  it('reports a test that names the new code but asserts nothing about it', () => {
    const subject = decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/loader.ts', fileStatus: 'added', lines: ['+export function loadConfig() { return { port: 80 }; }'] })],
    });
    const test = decision({
      id: 'test-decision', ordinal: 2,
      hunks: [hunk({ filePath: 'src/loader.test.ts', lines: ["+it('loads', () => { expect(loadConfig()).toBeDefined(); });"] })],
    });
    open(subject, [subject, test]);
    expect(screen.getByText(/assert nothing|asserts only/)).toBeInTheDocument();
  });

  it('says a test constrains the new code when it pins a value', () => {
    const subject = decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/loader.ts', fileStatus: 'added', lines: ['+export function loadConfig() { return { port: 80 }; }'] })],
    });
    const test = decision({
      id: 'test-decision', ordinal: 2,
      hunks: [hunk({ filePath: 'src/loader.test.ts', lines: ["+it('loads', () => { expect(loadConfig().port).toBe(80); });"] })],
    });
    open(subject, [subject, test]);
    expect(screen.queryByText(/asserts only/)).not.toBeInTheDocument();
  });

  it('lists a new dependency as a claim review cannot settle by reading', () => {
    open(decision({
      changeType: 'new_code',
      hunks: [hunk({ filePath: 'src/client.ts', fileStatus: 'added', lines: ["+import { retry } from 'resilient';", '+export function call() { return retry(); }'] })],
    }));
    expect(screen.getByText(/nothing in the diff or the repository can confirm exists/)).toBeInTheDocument();
  });
});
