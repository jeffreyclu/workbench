import { useLayoutEffect, useRef, type ReactNode } from 'react';

const focusableSelector = 'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

type ModalDialogProps = {
  children: ReactNode;
  className?: string;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  onClose: () => void;
  closeDisabled?: boolean;
};

export function ModalDialog({ children, className = '', label, labelledBy, describedBy, onClose, closeDisabled = false }: ModalDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const previouslyFocusedElement = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (!dialog.contains(document.activeElement)) (focusableElements(dialog)[0] ?? dialog).focus();

    return () => {
      if (previouslyFocusedElement.current?.isConnected) previouslyFocusedElement.current.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !closeDisabled) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = focusableElements(event.currentTarget);
    if (focusable.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose(); }}>
      <section ref={dialogRef} className={`dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} tabIndex={-1} onKeyDown={handleKeyDown}>
        {children}
      </section>
    </div>
  );
}
