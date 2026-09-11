// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewDecision, ReviewDecisionHunk } from '../../../shared/review-decisions.js';
import { DiffReviewChangeMapCode } from './change-map-code.js';

afterEach(cleanup);

function hunk(id: string, filePath: string, hunkRange: string, lines: string[]): ReviewDecisionHunk {
  return {
    id, filePath, fileStatus: 'modified', editorUrl: null, hunkRange, location: hunkRange.slice(3, 12),
    lines, contentHash: id,
    additions: lines.filter((line) => line.startsWith('+')).length,
    deletions: lines.filter((line) => line.startsWith('-')).length,
    state: null, note: null,
  };
}

function decision(hunks: ReviewDecisionHunk[]): ReviewDecision {
  return {
    id: hunks[0]!.id, ordinal: 2, subject: 'renderWorkspace', behavior: 'Rewrites renderWorkspace.',
    hunks, filePaths: [...new Set(hunks.map((entry) => entry.filePath))],
    additions: hunks.reduce((total, entry) => total + entry.additions, 0),
    deletions: hunks.reduce((total, entry) => total + entry.deletions, 0),
    riskSignals: [], changeType: 'behavior_edit', secondaryChangeTypes: [], state: null, note: null,
  };
}

describe('change map code popup', () => {
  it('shows the patch of every hunk the change spans, numbered on both sides', () => {
    render(<DiffReviewChangeMapCode decision={decision([
      hunk('a', 'src/render.ts', '@@ -4,2 +4,2 @@ renderWorkspace', ['-const scale = 1', '+const scale = ratio()']),
      hunk('b', 'src/render.test.ts', '@@ -20,1 +20,1 @@ describe("render")', ['+expect(scale).toBe(2)']),
    ])} />);

    const panel = screen.getByRole('region', { name: 'Code for change 2' });
    expect(within(panel).getByText('src/render.ts')).toBeInTheDocument();
    expect(within(panel).getByText('src/render.test.ts')).toBeInTheDocument();
    // Highlighting splits a line into token spans, so the code is read back
    // off the line element rather than matched as one text node.
    const code = [...panel.querySelectorAll('.diff-line-code')].map((line) => line.textContent);
    expect(code).toContain('const scale = ratio()');
    expect(code).toContain('const scale = 1');
    // The removed line keeps the old-side number, the added line the new one.
    const removed = panel.querySelector('.diff-line.deletion')!;
    expect(removed.textContent).toContain('4');
    expect(panel.querySelectorAll('.diff-line.addition').length).toBe(2);
  });

  it('caps a very large change and says how many lines it left out', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `+line ${index}`);
    render(<DiffReviewChangeMapCode decision={decision([hunk('a', 'src/big.ts', '@@ -1,0 +1,300 @@ big', lines)])} />);

    const panel = screen.getByRole('region', { name: 'Code for change 2' });
    expect(panel.querySelectorAll('.diff-line').length).toBe(240);
    expect(within(panel).getByText('60 more lines are not shown here; the diff below has all of them.')).toBeInTheDocument();
  });
});
