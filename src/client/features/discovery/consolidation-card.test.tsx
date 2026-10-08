import '@testing-library/jest-dom/vitest';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsolidationProposal, ConsolidationProposalItem } from '../../../shared/contracts';
import { ConsolidationProposalCard } from './consolidation-card';
import { summarizeConsolidation } from './logic';

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

const keep = (index: number): ConsolidationProposalItem => ({ provenanceId: `pinned_message:k${index}`, provenance: { source: 'pinned_message', id: `k${index}` }, verdict: 'keep', coveredBy: null });
const archive = (index: number): ConsolidationProposalItem => ({ provenanceId: `run_learning:a${index}#0`, provenance: { source: 'run_learning', id: `a${index}`, learningIndex: 0 }, verdict: 'archive_then_remove', reason: `Stale note ${index}.` });
const largeProposal: ConsolidationProposal = { ...proposal, items: [...Array.from({ length: 447 }, (_, index) => keep(index)), ...Array.from({ length: 15 }, (_, index) => archive(index))] };

describe('summarizeConsolidation', () => {
  it('separates actionable items from keeps and counts each verdict', () => {
    const summary = summarizeConsolidation(largeProposal.items);
    expect(summary).toMatchObject({ total: 462, archiveCount: 15, promoteCount: 0 });
    expect(summary.actionable).toHaveLength(15);
    expect(summary.keeps).toHaveLength(447);
  });
});

describe('ConsolidationProposalCard', () => {
  afterEach(cleanup);

  it('lists only promote and archive items, one line each, and calls onResolve from Accept/Reject', () => {
    const onResolve = vi.fn();
    render(<ConsolidationProposalCard proposal={proposal} pendingResolution={null} onResolve={onResolve} />);

    expect(screen.getByText('3 entries reviewed: 1 to archive, 1 to promote, 1 unchanged')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Items to act on' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Promote' + 'short_term_memory' + 'Re-read writes' + 'To engineering.md: Confirm every write.');
    expect(rows[1]).toHaveTextContent('Archive then remove' + 'run_learning' + 'run_learning:r1#0' + 'Stale run note.');
    expect(screen.queryByText('Covered by [engineering.md#1]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Accept: archive 1, promote 1' }));
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    expect(onResolve.mock.calls).toEqual([['accepted'], ['rejected']]);
  });

  it('renders 15 archive rows and folds 447 keeps into one collapsed disclosure', () => {
    const { container } = render(<ConsolidationProposalCard proposal={largeProposal} pendingResolution={null} onResolve={vi.fn()} />);

    expect(screen.getByText('462 entries reviewed: 15 to archive, 0 to promote, 447 unchanged')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(15);
    const disclosures = container.querySelectorAll('details');
    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).not.toHaveAttribute('open');
    expect(screen.getByText('447 unchanged (keep)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept: archive 15, promote 0' })).toBeInTheDocument();

    disclosures[0].open = true;
    fireEvent(disclosures[0], new Event('toggle'));
    expect(screen.getAllByRole('listitem')).toHaveLength(462);
  });

  it('says so in one sentence and offers Reject only when nothing is actionable', () => {
    render(<ConsolidationProposalCard proposal={{ ...proposal, items: [keep(1), keep(2)] }} pendingResolution={null} onResolve={vi.fn()} />);

    expect(screen.getByText('2 entries reviewed and none need promoting or archiving.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Items to act on' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeEnabled();
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
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).not.toBeInTheDocument();
  });
});
