// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDriftSummary } from '../../../shared/knowledge-drift';
import { KnowledgeDriftPanel } from './knowledge-drift';

afterEach(cleanup);

function report(status: KnowledgeDriftSummary['status']): KnowledgeDriftSummary {
  return {
    checkedAt: '2026-10-08T06:00:00.000Z',
    status,
    checks: {
      indexRows: { status: 'healthy', reason: 'Every memory file has an index row.' },
      oversizedFiles: { status: status === 'healthy' ? 'healthy' : 'degraded', reason: status === 'healthy' ? 'No memory file exceeds the 60-entry threshold.' : '1 file exceeds the 60-entry threshold.' },
      tierHeaders: { status: status === 'failed' ? 'failed' : 'healthy', reason: status === 'failed' ? '2 files have a missing or invalid tier header.' : 'Every memory file has a valid tier header.' },
    },
  };
}

function renderPanel(props: Partial<Parameters<typeof KnowledgeDriftPanel>[0]> = {}) {
  const handlers = { onRetry: vi.fn(), onRecheck: vi.fn() };
  render(<KnowledgeDriftPanel data={report('healthy')} loading={false} error={false} rechecking={false} recheckFailed={false} {...handlers} {...props} />);
  return handlers;
}

describe('KnowledgeDriftPanel', () => {
  it.each([
    ['healthy', 'Knowledge is in sync', 'No memory file exceeds the 60-entry threshold.'],
    ['degraded', 'Knowledge is drifting', '1 file exceeds the 60-entry threshold.'],
    ['failed', 'Knowledge needs repair', '2 files have a missing or invalid tier header.'],
  ] as const)('renders the %s report with each check and its reason', (status, heading, reason) => {
    renderPanel({ data: report(status) });
    expect(screen.getByRole('heading', { name: heading })).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText(/Last checked/)).toBeTruthy();
    expect(document.querySelector('.knowledge-drift-panel')?.className).toContain(`status-${status}`);
  });

  it('shows skeletons, not a spinner, while loading', () => {
    renderPanel({ data: undefined, loading: true });
    expect(screen.getByLabelText('Knowledge drift loading').querySelectorAll('.skeleton-line').length).toBe(2);
  });

  it('offers Re-check now as a secondary action', () => {
    const { onRecheck } = renderPanel();
    const button = screen.getByRole('button', { name: /Re-check now/ });
    expect(button.className).toContain('secondary');
    fireEvent.click(button);
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it('disables the action while re-checking and reports a failed re-check', () => {
    renderPanel({ rechecking: true, recheckFailed: true });
    expect((screen.getByRole('button', { name: /Re-checking/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Showing the previous report');
  });

  it('explains the pending state before the first nightly report', () => {
    renderPanel({ data: null });
    expect(screen.getByRole('heading', { name: 'First nightly check is pending' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Re-check now/ })).toBeTruthy();
  });

  it('offers Retry when the report cannot be read', () => {
    const { onRetry } = renderPanel({ data: undefined, error: true });
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
