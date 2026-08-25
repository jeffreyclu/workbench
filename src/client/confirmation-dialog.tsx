import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { ModalDialog } from './modal-dialog';

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
  return (
    <ModalDialog className="confirmation-dialog" labelledBy="confirmation-dialog-title" onClose={onClose} closeDisabled={pending}>
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
    </ModalDialog>
  );
}
