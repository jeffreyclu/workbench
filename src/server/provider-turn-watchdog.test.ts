import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderTurnWatchdog } from './provider-turn-watchdog.js';

afterEach(() => vi.useRealTimers());

describe('ProviderTurnWatchdog', () => {
  it('distinguishes transport acceptance from first meaningful activity', () => {
    vi.useFakeTimers();
    const timedOut: string[] = [];
    const watchdog = new ProviderTurnWatchdog({ firstActivityMs: 100, idleActivityMs: 500, onTimeout: (reason) => timedOut.push(reason) });
    watchdog.accepted();
    expect(watchdog.phase).toBe('awaiting_activity');
    vi.advanceTimersByTime(100);
    expect(timedOut).toEqual(['first_activity']);
  });

  it('opens a fresh first-activity deadline for an interjection accepted during activity', () => {
    vi.useFakeTimers();
    const timedOut: string[] = [];
    const watchdog = new ProviderTurnWatchdog({ firstActivityMs: 100, idleActivityMs: 500, onTimeout: (reason) => timedOut.push(reason) });
    watchdog.accepted();
    watchdog.activity();
    vi.advanceTimersByTime(400);
    expect(watchdog.accepted()).toBe(2);
    expect(watchdog.phase).toBe('awaiting_activity');
    vi.advanceTimersByTime(100);
    expect(timedOut).toEqual(['first_activity']);
  });

  it('resets the idle deadline on meaningful provider activity', () => {
    vi.useFakeTimers();
    const timedOut: string[] = [];
    const watchdog = new ProviderTurnWatchdog({ firstActivityMs: 100, idleActivityMs: 500, onTimeout: (reason) => timedOut.push(reason) });
    watchdog.accepted();
    watchdog.activity();
    vi.advanceTimersByTime(400);
    watchdog.activity();
    vi.advanceTimersByTime(499);
    expect(timedOut).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(timedOut).toEqual(['idle_activity']);
  });

  it('clears turn timers on completion and process timers on termination', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = new ProviderTurnWatchdog({ firstActivityMs: 100, idleActivityMs: 100, onTimeout });
    watchdog.accepted();
    watchdog.activity();
    watchdog.completed();
    expect(watchdog.phase).toBe('idle');
    vi.runAllTimers();
    expect(onTimeout).not.toHaveBeenCalled();
    watchdog.accepted();
    watchdog.terminal();
    vi.runAllTimers();
    expect(watchdog.phase).toBe('terminal');
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
