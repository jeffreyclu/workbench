/** Renders the toast stack. State and timers live in toast-store.ts. */
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { memo, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { dismissToast, getToasts, pauseToastTimers, resumeToastTimers, subscribeToasts, type Toast } from '../../state/toast-store';

const toneIcons = { success: Check, error: AlertTriangle, info: Info };

const ToastRow = memo(function ToastRow({ item }: { item: Toast }) {
  const Icon = toneIcons[item.tone];
  return (
    <li className={`toast toast-${item.tone} ${item.action ? 'toast-actionable' : ''} ${item.exiting ? 'toast-exiting' : ''}`}>
      <button type="button" className="toast-content" disabled={!item.action} onClick={() => { if (!item.action) return; dismissToast(item.id); item.action(); }} aria-label={item.action ? `${item.actionLabel ?? 'Open'}: ${item.message}` : undefined}>
        <Icon className="toast-icon" size={15} aria-hidden="true" />
        <div className="toast-copy">
          <p className="toast-message">
            {item.message}
            {item.count > 1 && <span className="toast-count">×{item.count}</span>}
          </p>
          {item.description && <p className="toast-description">{item.description}</p>}
          {item.action && <span className="toast-action-label">{item.actionLabel ?? 'Open'}</span>}
        </div>
      </button>
      <button type="button" className="toast-close" aria-label={`Dismiss notification: ${item.message}`} onClick={() => dismissToast(item.id)}>
        <X size={13} />
      </button>
    </li>
  );
});

/**
 * Mount once, near the app root. The live region stays mounted even when empty so
 * screen readers announce additions reliably. Announcements are polite on purpose:
 * toasts are supplementary, and `assertive` would interrupt someone mid-sentence.
 */
export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <ol
      className="toast-viewport"
      aria-label="Notifications"
      aria-live="polite"
      aria-relevant="additions text"
      onMouseEnter={pauseToastTimers}
      onMouseLeave={resumeToastTimers}
      onFocusCapture={pauseToastTimers}
      onBlurCapture={resumeToastTimers}
    >
      {items.map((item) => <ToastRow key={item.id} item={item} />)}
    </ol>,
    document.body,
  );
}
