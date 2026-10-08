import '@testing-library/jest-dom/vitest';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidationProposal } from '../../../shared/contracts';
import { ConsolidationProposalCard } from './consolidation-card';

const proposal: ConsolidationProposal = {
  id: 'p1',
  status: 'pending',
  createdAt: '2026-10-01T00:00:00.000Z',
  resolvedAt: null,
  applyResults: null,
  items: [
    { provenanceId: 'short_term_memory:c1', provenance: { source: 'short_term_memory', id: 'c1' }, verdict: 'promote', targetFile: 'engineering.md', title: 'Re-read writes', text: 'Confirm every write.' },
    { provenanceId: 'pinned_message:m1', provenance: { source: 'pinned_message', id: 'm1' }, verdict: 'keep', coveredBy: '[engineering.md#1]' },
    { provenanceId: 'run_learning:r1#0', provenance: { source: 'run_learning', id: 'r1', learningIndex: 0 }, verdict: 'archive_then_remove', reason: 'Stale run note.' },
  ],
};

describe('ConsolidationProposalCard', () => {
  afterEach(cleanup);

  it('renders verdicts, target or citation, reason, and calls onResolve from Accept/Reject', () => {
    const onResolve = vi.fn();
    render(<ConsolidationProposalCard proposal={proposal} pendingResolution={null} onResolve={onResolve} />);

    expect(screen.getByText('Promote')).toBeInTheDocument();
    expect(screen.getByText('Keep')).toBeInTheDocument();
    expect(screen.getByText('Archive then remove')).toBeInTheDocument();
    expect(screen.getByText('To engineering.md')).toBeInTheDocument();
    expect(screen.getByText('Covered by [engineering.md#1]')).toBeInTheDocument();
    expect(screen.getByText('To discard-log.md')).toBeInTheDocument();
    expect(screen.getByText('Re-read writes: Confirm every write.')).toBeInTheDocument();
    expect(screen.getByText('Stale run note.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Accept/ }));
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    expect(onResolve.mock.calls).toEqual([['accepted'], ['rejected']]);
  });

  it('disables both buttons while a resolution is in flight', () => {
    render(<ConsolidationProposalCard proposal={proposal} pendingResolution="accepted" onResolve={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Accepting/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeDisabled();
  });

  it('shows applied and failed lists without buttons after a partial apply', () => {
    render(<ConsolidationProposalCard pendingResolution={null} onResolve={vi.fn()} proposal={{
      ...proposal, status: 'partially_applied',
      applyResults: [
        { provenanceId: 'short_term_memory:c1', verdict: 'promote', status: 'applied', detail: 'Promoted to [engineering.md#4].' },
        { provenanceId: 'pinned_message:m1', verdict: 'keep', status: 'failed', detail: 'boom' },
        { provenanceId: 'run_learning:r1#0', verdict: 'archive_then_remove', status: 'not_attempted', detail: '' },
      ],
    }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Applied: short_term_memory:c1');
    expect(screen.getByRole('status')).toHaveTextContent('Failed: pinned_message:m1 (boom)');
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
  });
});
