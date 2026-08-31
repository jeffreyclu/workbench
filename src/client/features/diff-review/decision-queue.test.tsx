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
    hunks: [{ id, filePath: 'src/example.ts', fileStatus: 'modified', editorUrl: null, hunkRange: `@@ -${ordinal} +${ordinal} @@ example`, location: `Line ${ordinal}`, contentHash: `hash-${ordinal}`, lines: ['+const after = true;'], additions: 1, deletions: 0, state, note: null }],
    filePaths: ['src/example.ts'],
    additions: 1,
    deletions: 0,
    changeType: 'behavior_edit' as const, secondaryChangeTypes: [],
  riskSignals: [],
    state,
    note: null,
  };
}

const decisions = [decision(1, null), decision(2, 'reviewed'), decision(3, 'needs_changes'), decision(4, 'commented')];

describe('diff review decision queue', () => {
  it('marks every settled decision so a reviewer coming back around can see it was handled', () => {
    render(<DiffReviewDecisionQueue decisions={decisions} selectedId={decisions[0].id} onSelect={vi.fn()} />);

    // Chips are too small for written state, so the redundant non-colour cue is the
    // per-state icon plus the state written into the accessible name.
    const buttons = screen.getAllByRole('button');
    expect(buttons[0].className).not.toContain('settled');
    expect(buttons[0]).toHaveAccessibleName(/Pending/);
    for (const [index, label] of [[1, 'Approved'], [2, 'Needs changes'], [3, 'Commented']] as const) {
      expect(buttons[index].className).toContain('settled');
      expect(buttons[index]).toHaveAccessibleName(new RegExp(label));
      expect(buttons[index].querySelector('svg')).toBeInTheDocument();
    }
  });

  it('carries the state tone class so the chip and rail cannot disagree with the written state', () => {
    render(<DiffReviewDecisionQueue decisions={decisions} selectedId={decisions[0].id} onSelect={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons[1].className).toContain('state-reviewed');
    expect(buttons[2].className).toContain('state-needs_changes');
    expect(buttons[3].className).toContain('state-commented');
    expect(buttons[2]).toHaveAccessibleName(/Needs changes/);
  });

  it('says which unsettled decision is waiting on a delegated review rather than on the reviewer', () => {
    render(<DiffReviewDecisionQueue decisions={decisions} selectedId={decisions[0].id} onSelect={vi.fn()} delegating={new Set([decisions[0].id])} />);

    // The spinner is the glance-level cue; the accessible name carries the same
    // fact for anyone who cannot see it turn.
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveAccessibleName(/awaiting delegated review/);
    expect(buttons[0].className).toContain('delegating');
    // A settled decision is never owed a turn, so it must not be marked as one.
    expect(buttons[1]).not.toHaveAccessibleName(/awaiting delegated review/);
  });

  it('reports how much of the queue is already reviewed', () => {
    render(<DiffReviewDecisionQueue decisions={decisions} selectedId={decisions[0].id} onSelect={vi.fn()} />);

    expect(screen.getByText('3 of 4 reviewed')).toBeInTheDocument();
  });
});
