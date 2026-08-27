import { LoaderCircle, X } from 'lucide-react';
import { ModalDialog } from './modal-dialog';
import type { RetrievedMemoryDetail } from '../../../shared/contracts';

export function RetrievedMemoryDialog({ detail, loading, onClose }: { detail: RetrievedMemoryDetail | null | undefined; loading: boolean; onClose: () => void }) {
  return <ModalDialog className="retrieved-memory-dialog" labelledBy="retrieved-memory-dialog-title" onClose={onClose}>
    <div className="dialog-header"><div><span className="eyebrow">RAG memory retrieval</span><h2 id="retrieved-memory-dialog-title">What was retrieved for this reply</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></div>
    {loading && <p className="dialog-description"><LoaderCircle className="spin" size={13} /> Loading retrieval detail…</p>}
    {!loading && !detail && <p className="dialog-description">No retrieval detail was recorded for this reply.</p>}
    {!loading && detail && (
      <div className="retrieved-memory-detail">
        <p className="dialog-description">Query: <code>{detail.query}</code></p>
        {detail.items.length === 0
          ? <p className="dialog-description">No memory items matched this query.</p>
          : <ul className="retrieved-memory-items">
              {detail.items.map((item, index) => (
                <li key={`${item.source}-${index}`} className="retrieved-memory-item">
                  <div className="retrieved-memory-item-header"><strong>{item.title}</strong><span className="retrieved-memory-item-source">{item.source}</span></div>
                  <p className="retrieved-memory-item-body">{item.body}</p>
                  <time>{new Date(item.createdAt).toLocaleString()}</time>
                </li>
              ))}
            </ul>}
      </div>
    )}
  </ModalDialog>;
}
