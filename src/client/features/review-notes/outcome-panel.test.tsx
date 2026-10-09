// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewOutcome } from './outcome-logic.js';
import { ReviewOutcomePanel } from './outcome-panel.js';

afterEach(cleanup);

const outcome: ReviewOutcome = {
  status: 'needs_changes',
  decisions: { total: 4, approved: 1, needsChanges: 1, commented: 1, pending: 1 },
  notes: { open: 1, resolved: 2, outdated: 0 },
  unresolvedFeedback: 2, fixRequests: 1, whitespaceOnlyFiles: ['src/ws.ts'],
  ledgerVerdicts: [{ decisionId: 'd1', ordinal: 1, behavior: 'Retries', severity: 'blocking' }],
  queue: [{ key: 'decision:d1', kind: 'decision', filePath: 'src/a.ts', label: 'Decision 1 needs changes', decisionId: 'd1' }, { key: 'note:n1', kind: 'note', filePath: 'src/b.ts', label: 'Check null' }],
};

function renderPanel(over: Partial<ReviewOutcome> = {}, activeKey: string | null = null) {
  const props = { outcome: { ...outcome, ...over }, activeKey, onJumpItem: vi.fn(), onStep: vi.fn(), onJumpDecision: vi.fn(), onJumpFile: vi.fn() };
  render(<ReviewOutcomePanel {...props} />);
  return props;
}

describe('ReviewOutcomePanel', () => {
  it('shows the status, decision and note totals, unresolved count and fix requests', () => {
    renderPanel();
    const panel = screen.getByRole('region', { name: 'Review outcome' });
    expect(within(panel).getByText('Changes requested')).toBeInTheDocument();
    expect(within(panel).getByText('Needs changes').nextSibling).toHaveTextContent('1');
    expect(within(panel).getByText('Resolved notes').nextSibling).toHaveTextContent('2');
    expect(panel).toHaveTextContent('2 unresolved items · 1 fix request sent');
  });

  it('jumps from ledger verdicts, whitespace-only files and queue items', () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Jump to decision 1' }));
    expect(props.onJumpDecision).toHaveBeenCalledWith(expect.objectContaining({ decisionId: 'd1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump to whitespace-only file src/ws.ts' }));
    expect(props.onJumpFile).toHaveBeenCalledWith('src/ws.ts');
    fireEvent.click(screen.getByRole('button', { name: 'Jump to note in src/b.ts: Check null' }));
    expect(props.onJumpItem).toHaveBeenCalledWith(expect.objectContaining({ key: 'note:n1' }));
  });

  it('steps through the queue and marks the active item', () => {
    const props = renderPanel({}, 'note:n1');
    fireEvent.click(screen.getByRole('button', { name: /Previous unresolved/ }));
    expect(props.onStep).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole('button', { name: /Next unresolved/ }));
    expect(props.onStep).toHaveBeenCalledWith(1);
    expect(screen.getByText(/Unresolved queue \(2 of 2\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Jump to note in src\/b.ts/ })).toHaveAttribute('aria-current', 'true');
  });

  it('shows an empty queue without step controls and hides empty sections', () => {
    renderPanel({ status: 'approved', queue: [], ledgerVerdicts: [], whitespaceOnlyFiles: [], unresolvedFeedback: 0, fixRequests: 0 });
    expect(screen.getByText('Nothing unresolved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next unresolved/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Review ledger')).not.toBeInTheDocument();
    expect(screen.getByText('Approved', { selector: 'strong' })).toBeInTheDocument();
  });
});
