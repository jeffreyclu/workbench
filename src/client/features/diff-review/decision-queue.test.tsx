// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDecision } from './logic.js';
import { DiffReviewDecisionQueue } from './decision-queue.js';

afterEach(cleanup);

function decision(ordinal: number, state: ReviewDecision['state']): ReviewDecision {
  const id = `src/example.ts::@@ -${ordinal} +${ordinal} @@ example`;
  return {
    id,
    ordinal,
    subject: 'example',
    behavior: `Changes example ${ordinal} in src/example.ts.`,
    hunks: [{ id, fingerprint: `fingerprint-${ordinal}`, filePath: 'src/example.ts', editorUrl: null, hunkRange: `@@ -${ordinal} +${ordinal} @@ example`, location: `Line ${ordinal}`, lines: ['+const after = true;'], additions: 1, deletions: 0, state, note: null }],
    filePaths: ['src/example.ts'],
    additions: 1,
    deletions: 0,
    riskSignals: [],
    state,
    note: null,
  };
}

const decisions = [decision(1, null), decision(2, 'reviewed'), decision(3, 'needs_changes'), decision(4, 'commented')];

describe('diff review decision queue', () => {
  it('marks every settled decision so a reviewer coming back around can see it was handled', () => {
    render(<DiffReviewDecisionQueue decisions={decisions} selectedId={decisions[0].id} onSelect={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons[0].className).not.toContain('settled');
    expect(buttons[0]).toHaveTextContent('To do');
    for (const [index, label] of [[1, 'Done'], [2, 'Changes'], [3, 'Noted']] as const) {
      expect(buttons[index].className).toContain('settled');
      expect(buttons[index]).toHaveTextContent(label);
    }
  });

  it('carries the state tone class so the chip and rail cannot disagree with the written state', () => {
    render(<DiffReviewDecisionQueue decisions={decisions} selectedId={decisions[0].id} onSelect={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons[1].className).toContain('state-reviewed');
    expect(buttons[2].className).toContain('state-needs_changes');
    expect(buttons[3].className).toContain('state-commented');
    expect(screen.getByLabelText('Needs changes')).toHaveClass('state-needs_changes');
  });

  it('reports how much of the queue is already reviewed', () => {
    render(<DiffReviewDecisionQueue decisions={decisions} selectedId={decisions[0].id} onSelect={vi.fn()} />);

    expect(screen.getByText('3 of 4 reviewed')).toBeInTheDocument();
  });
});
