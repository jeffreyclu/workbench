// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunElapsedTimer } from './view';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RunElapsedTimer', () => {
  it('ticks every second while the agent run is live', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:05.000Z'));
    render(<RunElapsedTimer status="running" createdAt="2026-08-25T12:00:00.000Z" completedAt={null} />);
    expect(screen.getByLabelText('Elapsed 5s')).toHaveTextContent('5s');
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByLabelText('Elapsed 7s')).toHaveTextContent('7s');
  });

  it('shows the final elapsed time once the run finishes and stops ticking', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:10:00.000Z'));
    render(<RunElapsedTimer status="completed" createdAt="2026-08-25T12:00:00.000Z" completedAt="2026-08-25T12:02:03.000Z" />);
    expect(screen.getByLabelText('Run took 2m 03s')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByLabelText('Run took 2m 03s')).toBeInTheDocument();
  });

  it('switches from live to final when the reply completes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T12:00:30.000Z'));
    const { rerender } = render(<RunElapsedTimer status="running" createdAt="2026-08-25T12:00:00.000Z" completedAt={null} />);
    expect(screen.getByLabelText('Elapsed 30s')).toBeInTheDocument();
    rerender(<RunElapsedTimer status="completed" createdAt="2026-08-25T12:00:00.000Z" completedAt="2026-08-25T12:00:31.000Z" />);
    expect(screen.getByLabelText('Run took 31s')).toBeInTheDocument();
  });

  it('renders nothing for a queued reply that has not started', () => {
    const { container } = render(<RunElapsedTimer status="queued" createdAt="2026-08-25T12:00:00.000Z" completedAt={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
