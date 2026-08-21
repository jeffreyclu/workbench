import { X } from 'lucide-react';
import { useEffect } from 'react';

type ConfirmationDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
};

export function ConfirmationDialog({ title, description, confirmLabel, onConfirm, onClose, pending = false }: ConfirmationDialogProps) {
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
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={pending} autoFocus>Cancel</button>
          <button type="button" className="button danger" onClick={onConfirm} disabled={pending}>{pending ? 'Deleting…' : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
