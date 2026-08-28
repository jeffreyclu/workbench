// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunReviewHandoff } from '../../../shared/contracts.js';
import { AgentRunReviewHandoffCard } from './review-handoff-card.js';

afterEach(cleanup);

const handoff: AgentRunReviewHandoff = {
  agentRunId: 'run-1',
  formatVersion: 1,
  summary: 'Fixed the flaky login test.',
  changes: [{ path: 'src/app.ts', summary: 'Updated during this run.', rationale: 'Observed file-write event from the coding runner.' }],
  acceptanceCriteria: [{ criterion: 'Fix the flaky login test.', files: ['src/app.ts'], decisions: [] }],
  contractChanges: [],
  verification: [{ command: 'npm test', exitCode: 0, result: 'passed' }, { command: 'npm run build', exitCode: 1, result: 'failed' }],
  uncertainties: [],
  tradeoffs: [],
  createdAt: '2026-08-27T01:00:00.000Z',
};

describe('AgentRunReviewHandoffCard', () => {
  it('displays the summary, changed files, and every verification command with its result', () => {
    render(<AgentRunReviewHandoffCard handoff={handoff} />);

    expect(screen.getByText('Fixed the flaky login test.')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText(/npm test/)).toBeInTheDocument();
    expect(screen.getByText(/npm run build/)).toBeInTheDocument();
    expect(screen.getByText('1/2 passed')).toBeInTheDocument();
  });

  it('surfaces the observed-evidence uncertainty instead of trusting the model summary when no command ran', () => {
    render(<AgentRunReviewHandoffCard handoff={{ ...handoff, verification: [], uncertainties: ['No completed test, build, typecheck, or lint command was observed by the runner.'] }} />);

    expect(screen.getAllByText('No completed test, build, typecheck, or lint command was observed by the runner.').length).toBeGreaterThan(0);
  });
});
