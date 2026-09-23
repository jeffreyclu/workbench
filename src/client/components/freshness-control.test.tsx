// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreshnessControl } from './freshness-control';

describe('FreshnessControl', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('updates its timestamp in real time and refetches only when requested', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
    const onRefresh = vi.fn();
    render(<FreshnessControl updatedAt={Date.now()} isRefreshing={false} onRefresh={onRefresh} />);

    expect(screen.getByText('Updated just now')).toBeTruthy();
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByText('Updated 2m ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh data. Updated 2m ago' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('prevents overlapping refresh requests while one is in flight', () => {
    render(<FreshnessControl updatedAt={Date.now()} isRefreshing onRefresh={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Refreshing data/ })).toBeDisabled();
  });

  it('offers a short label for constrained phone chrome', () => {
    render(<FreshnessControl updatedAt={Date.now()} isRefreshing={false} onRefresh={vi.fn()} compact />);
    expect(screen.getByText('Now')).toBeVisible();
  });
});
