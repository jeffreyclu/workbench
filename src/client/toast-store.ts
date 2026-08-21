/**
 * Stacking toast notifications.
 *
 * The store lives at module scope instead of in React context because toasts are
 * fired from mutation callbacks scattered across App.tsx. Threading a provider and
 * a hook through every one of them would add plumbing without adding clarity, and
 * it would break the existing tests that render App and SharedWorkspace directly.
 * Components import `toast` and call it; <Toaster /> in toast.tsx renders the stack.
 */
export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
  description?: string;
  /** Repeats of an identical toast collapse into one row and bump this counter. */
  count: number;
  /** Milliseconds on screen. Zero or less pins the toast until it is dismissed. */
  duration: number;
  action?: () => void;
  actionLabel?: string;
}

export interface ToastOptions {
  /** Second line, for the server error message behind a human summary. */
  description?: string;
  duration?: number;
  /** Makes the notification itself a navigation/action target. */
  action?: () => void;
  actionLabel?: string;
}

/** A burst of failures must never bury the UI, so the oldest toasts fall off the stack. */
const MAX_VISIBLE = 4;
const DEFAULT_DURATION: Record<ToastTone, number> = { success: 4_000, info: 5_000, error: 8_000 };

interface Timer { handle: number; remaining: number; startedAt: number }

let toasts: Toast[] = [];
let sequence = 0;
let paused = false;
const listeners = new Set<() => void>();
const timers = new Map<string, Timer>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer) window.clearTimeout(timer.handle);
  timers.delete(id);
}

function startTimer(id: string, remaining: number): void {
  clearTimer(id);
  if (remaining <= 0) return;
  if (paused) {
    timers.set(id, { handle: 0, remaining, startedAt: 0 });
    return;
  }
  timers.set(id, { handle: window.setTimeout(() => dismissToast(id), remaining), remaining, startedAt: Date.now() });
}

/** Hovering or focusing the stack freezes every countdown so a toast can be read. */
export function pauseToastTimers(): void {
  if (paused) return;
  paused = true;
  for (const [id, timer] of [...timers]) {
    window.clearTimeout(timer.handle);
    const elapsed = Date.now() - timer.startedAt;
    timers.set(id, { handle: 0, remaining: Math.max(1, timer.remaining - elapsed), startedAt: 0 });
  }
}

export function resumeToastTimers(): void {
  if (!paused) return;
  paused = false;
  for (const [id, timer] of [...timers]) startTimer(id, timer.remaining);
}

function push(tone: ToastTone, message: string, options: ToastOptions = {}): string {
  const duration = options.duration ?? DEFAULT_DURATION[tone];
  const existing = toasts.find((item) => item.tone === tone && item.message === message && item.description === options.description);
  if (existing) {
    // Keep its place in the stack; a repeat should restart the countdown, not reshuffle the list.
    toasts = toasts.map((item) => item.id === existing.id ? { ...item, count: item.count + 1, duration, action: options.action ?? item.action, actionLabel: options.actionLabel ?? item.actionLabel } : item);
    startTimer(existing.id, duration);
    emit();
    return existing.id;
  }
  sequence += 1;
  const created: Toast = { id: `toast-${sequence}`, tone, message, description: options.description, count: 1, duration, action: options.action, actionLabel: options.actionLabel };
  toasts = [...toasts, created].slice(-MAX_VISIBLE);
  for (const id of [...timers.keys()]) if (!toasts.some((item) => item.id === id)) clearTimer(id);
  startTimer(created.id, duration);
  emit();
  return created.id;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

function clearToasts(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  if (toasts.length === 0) return;
  toasts = [];
  emit();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToasts(): Toast[] {
  return toasts;
}

export const toast = {
  success: (message: string, options?: ToastOptions) => push('success', message, options),
  error: (message: string, options?: ToastOptions) => push('error', message, options),
  info: (message: string, options?: ToastOptions) => push('info', message, options),
  dismiss: dismissToast,
  clear: clearToasts,
};

/**
 * Mutation `onError` callbacks receive `unknown`. This keeps the server's message
 * as the detail line under a summary the reader can act on.
 */
export function toastError(summary: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return toast.error(summary, { description: detail || undefined });
}
