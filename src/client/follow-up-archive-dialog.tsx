import { Archive, X } from 'lucide-react';

export function FollowUpArchiveDialog({ count, onChoose, onClose, pending }: { count: number; onChoose: (archiveParent: boolean) => void; onClose: () => void; pending: boolean }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="dialog follow-up-archive-dialog" role="dialog" aria-modal="true" aria-labelledby="follow-up-archive-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="dialog-header"><div><span className="eyebrow">Create follow-ups</span><h2 id="follow-up-archive-title">What should happen to the original?</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></div>
      <p className="dialog-description">Create {count} selected follow-up task{count === 1 ? '' : 's'}, then choose whether the original task and conversation stay active.</p>
      <div className="follow-up-archive-actions">
        <button type="button" className="button primary" disabled={pending} onClick={() => onChoose(false)}>Create and keep open</button>
        <button type="button" className="button secondary" disabled={pending} onClick={() => onChoose(true)}><Archive size={14} /> Create and archive original</button>
      </div>
    </section>
  </div>;
}
