import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

type ConfirmationDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
  confirmDisabled?: boolean;
  confirmVariant?: 'danger' | 'primary';
  children?: ReactNode;
};

export function ConfirmationDialog({ title, description, confirmLabel, onConfirm, onClose, pending = false, confirmDisabled = false, confirmVariant = 'danger', children }: ConfirmationDialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, pending]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!pending) onClose(); }}>
      <section className="dialog confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><span className="eyebrow">Confirm action</span><h2 id="confirmation-dialog-title">{title}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} disabled={pending} aria-label="Close"><X size={17} /></button>
        </div>
        <p className="dialog-description">{description}</p>
        {children}
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={pending} autoFocus={!children}>Cancel</button>
          <button type="button" className={`button ${confirmVariant}`} onClick={onConfirm} disabled={pending || confirmDisabled}>{pending ? `${confirmLabel}…` : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
