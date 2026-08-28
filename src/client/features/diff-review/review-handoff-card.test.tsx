// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';
import { AgentRunReviewHandoffCard } from './review-handoff-card.js';

afterEach(cleanup);

const handoff: AgentRunReviewHandoff = {
  agentRunId: 'run-1', formatVersion: 1, summary: 'Fixed the flaky login test.', createdAt: '2026-08-27T01:00:00.000Z',
  changes: [{ path: 'src/app.ts', summary: 'Changed during this run.', rationale: 'Observed file-write event from the coding runner.' }],
  acceptanceCriteria: [{ criterion: 'Fix the flaky login test.', files: ['src/app.ts'], decisions: [] }], contractChanges: [],
  verification: [{ command: 'pnpm typecheck', exitCode: 0, result: 'passed' }, { command: 'pnpm build', exitCode: 1, result: 'failed' }],
  uncertainties: [], tradeoffs: [],
};

describe('AgentRunReviewHandoffCard', () => {
  it('shows the handoff and observed verification above review decisions', () => {
    render(<AgentRunReviewHandoffCard handoff={handoff} />);

    expect(screen.getByText('Agent handoff')).toBeInTheDocument();
    expect(screen.getByText('Agent-reported context only. It is not verification evidence.')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText(/pnpm typecheck/)).toBeInTheDocument();
    expect(screen.getByText('1/2 passed')).toBeInTheDocument();
  });

  it('states the evidence gap when no verification command was observed', () => {
    render(<AgentRunReviewHandoffCard handoff={{ ...handoff, verification: [], uncertainties: ['No completed test, build, typecheck, or lint command was observed by the runner.'] }} />);

    expect(screen.getByText('No completed test, build, typecheck, or lint command was observed by the runner.')).toBeInTheDocument();
  });
});
