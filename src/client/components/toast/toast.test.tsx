// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster } from './toast';
import { toast, toastError } from '../../state/toast-store';

function visibleMessages(): string[] {
  return [...document.querySelectorAll('.toast-message')].map((node) => node.textContent ?? '');
}

beforeEach(() => {
  vi.useFakeTimers();
  render(<Toaster />);
});

afterEach(() => {
  act(() => toast.clear());
  cleanup();
  vi.useRealTimers();
});

describe('toast stack', () => {
  it('stacks several toasts at once, oldest first so reading order matches the visual stack', () => {
    act(() => { toast.success('Task archived.'); toast.error('Message not sent.'); toast.info('Run queued.'); });

    expect(visibleMessages()).toEqual(['Task archived.', 'Message not sent.', 'Run queued.']);
  });

  it('caps the stack and drops the oldest toast so a burst cannot bury the UI', () => {
    act(() => { for (const label of ['one', 'two', 'three', 'four', 'five']) toast.info(label); });

    expect(visibleMessages()).toEqual(['two', 'three', 'four', 'five']);
  });

  it('collapses an identical repeat into one row with a counter instead of a duplicate', () => {
    act(() => { toast.error('Could not reorder the stack.'); toast.info('Run queued.'); });
    act(() => { toast.error('Could not reorder the stack.'); });

    // The repeat keeps its place in the stack rather than jumping to the end.
    expect(visibleMessages()).toEqual(['Could not reorder the stack.×2', 'Run queued.']);
  });

  it('auto-dismisses each toast on its own timer, giving errors longer than successes', () => {
    act(() => { toast.success('Task archived.'); toast.error('Message not sent.'); });

    act(() => { vi.advanceTimersByTime(4_000 + 200); });
    expect(visibleMessages()).toEqual(['Message not sent.']);

    act(() => { vi.advanceTimersByTime(4_000 + 200); });
    expect(visibleMessages()).toEqual([]);
  });

  it('restarts the countdown when a toast repeats', () => {
    act(() => { toast.success('Task archived.'); });
    act(() => { vi.advanceTimersByTime(3_000); });
    act(() => { toast.success('Task archived.'); });

    act(() => { vi.advanceTimersByTime(3_000); });
    expect(visibleMessages()).toEqual(['Task archived.×2']);

    act(() => { vi.advanceTimersByTime(1_000 + 200); });
    expect(visibleMessages()).toEqual([]);
  });

  it('freezes the countdown while the stack is hovered and resumes the remainder on leave', () => {
    act(() => { toast.success('Task archived.'); });
    const viewport = document.querySelector('.toast-viewport')!;

    act(() => { vi.advanceTimersByTime(2_000); });
    fireEvent.mouseOver(viewport);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(visibleMessages()).toEqual(['Task archived.']);

    fireEvent.mouseOut(viewport, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1_999); });
    expect(visibleMessages()).toEqual(['Task archived.']);

    act(() => { vi.advanceTimersByTime(2 + 200); });
    expect(visibleMessages()).toEqual([]);
  });

  it('dismisses a single toast from its close button and leaves the rest of the stack alone', () => {
    act(() => { toast.info('Run queued.'); toast.error('Message not sent.'); });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification: Run queued.' }));
    act(() => { vi.advanceTimersByTime(200); });

    expect(visibleMessages()).toEqual(['Message not sent.']);
  });

  it('runs an actionable toast and dismisses it when its content is clicked', () => {
    const action = vi.fn();
    act(() => { toast.info('Agent has follow-ups for review', { action, actionLabel: 'Review suggestions', duration: 0 }); });

    fireEvent.click(screen.getByRole('button', { name: 'Review suggestions: Agent has follow-ups for review' }));
    act(() => { vi.advanceTimersByTime(200); });

    expect(action).toHaveBeenCalledOnce();
    expect(visibleMessages()).toEqual([]);
  });

  it('pins a toast with a non-positive duration until it is dismissed', () => {
    let id = '';
    act(() => { id = toast.error('Preview build failed.', { duration: 0 }); });

    act(() => { vi.advanceTimersByTime(120_000); });
    expect(visibleMessages()).toEqual(['Preview build failed.']);

    act(() => { toast.dismiss(id); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(visibleMessages()).toEqual([]);
  });

  it('marks a toast as exiting before it clears, so the CSS exit animation can play', () => {
    let id = '';
    act(() => { id = toast.error('Preview build failed.', { duration: 0 }); });

    act(() => { toast.dismiss(id); });
    expect(document.querySelector('.toast-exiting')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(200); });
    expect(document.querySelector('.toast-exiting')).toBeFalsy();
    expect(visibleMessages()).toEqual([]);
  });

  it('keeps the server message as the detail line under a readable summary', () => {
    act(() => { toastError('Could not delete the conversation.', new Error('Conversation is locked by a running agent.')); });

    expect(screen.getByText('Could not delete the conversation.')).toBeTruthy();
    expect(screen.getByText('Conversation is locked by a running agent.')).toBeTruthy();
  });

  it('exposes the stack as a polite live region so additions are announced', () => {
    const viewport = screen.getByRole('list', { name: 'Notifications' });

    expect(viewport.getAttribute('aria-live')).toBe('polite');
  });
});
