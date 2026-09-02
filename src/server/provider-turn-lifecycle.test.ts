import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderTurnLifecycle } from './provider-turn-lifecycle.js';

afterEach(() => vi.useRealTimers());

describe('ProviderTurnLifecycle', () => {
  it('distinguishes transport acceptance from first meaningful activity', () => {
    vi.useFakeTimers();
    const timedOut: string[] = [];
    const lifecycle = new ProviderTurnLifecycle({ firstActivityMs: 100, idleActivityMs: 500, onTimeout: (reason) => timedOut.push(reason) });
    lifecycle.accepted();
    expect(lifecycle.phase).toBe('waiting_for_activity');
    vi.advanceTimersByTime(100);
    expect(timedOut).toEqual(['first_activity']);
  });

  it('resets one shared idle deadline on every provider activity', () => {
    vi.useFakeTimers();
    const timedOut: string[] = [];
    const lifecycle = new ProviderTurnLifecycle({ firstActivityMs: 100, idleActivityMs: 500, onTimeout: (reason) => timedOut.push(reason) });
    lifecycle.accepted();
    lifecycle.activity();
    vi.advanceTimersByTime(400);
    lifecycle.activity();
    vi.advanceTimersByTime(400);
    expect(timedOut).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(timedOut).toEqual(['idle_activity']);
  });

  it('never fires after a terminal state', () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const lifecycle = new ProviderTurnLifecycle({ firstActivityMs: 100, idleActivityMs: 100, onTimeout });
    lifecycle.accepted();
    lifecycle.terminal();
    vi.runAllTimers();
    expect(lifecycle.phase).toBe('terminal');
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
