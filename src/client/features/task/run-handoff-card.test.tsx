// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';
import { RunHandoffCard } from './run-handoff-card.js';

const handoff: AgentRunReviewHandoff = {
  agentRunId: 'run-1', formatVersion: 2, summary: 'Added the handoff card.', changes: [{ path: 'src/a.ts', summary: 'x', rationale: 'y' }],
  acceptanceCriteria: [], contractChanges: [], verification: [{ command: 'pnpm typecheck', exitCode: 0, result: 'passed' }],
  uncertainties: [], tradeoffs: [], blockers: ['Push was refused.'], learnings: ['a.md#1'], priorArt: ['b.md#2'], createdAt: '2026-08-27T00:00:00.000Z',
};

describe('RunHandoffCard', () => {
  it('shows a short summary with folded blockers, lessons, and earlier notes', () => {
    render(<RunHandoffCard handoff={handoff} />);

    expect(screen.getByLabelText('Handoff')).toBeTruthy();
    expect(screen.getByText('Added the handoff card.')).toBeTruthy();
    expect(screen.getByText('1 file changed · 1/1 checks passed · 1 blocker · 1 lesson saved')).toBeTruthy();
    expect(screen.getByText('Push was refused.').closest('details')).toBeTruthy();
    expect(screen.getByText('a.md#1')).toBeTruthy();
    expect(screen.getByText('b.md#2')).toBeTruthy();
  });
});
