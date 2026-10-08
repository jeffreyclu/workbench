import { X } from 'lucide-react';
import { ModalDialog } from './modal-dialog';
import type { RetrievedMemoryDetail, RetrievedMemoryItem } from '../../../shared/contracts';
import { SkeletonText } from '../skeleton/skeleton';

function MemoryItems({ items }: { items: RetrievedMemoryItem[] }) {
  return <ul className="retrieved-memory-items">
    {items.map((item, index) => (
      <li key={`${item.source}-${index}`} className="retrieved-memory-item">
        <div className="retrieved-memory-item-header"><strong>{item.title}</strong><span className="retrieved-memory-item-source">{item.source}{item.citation ? ` ${item.citation}` : ''}</span></div>
        {item.retrievalPath?.length ? <p className="retrieved-memory-item-path">Why: {item.retrievalPath.join(' → ')}</p> : null}
        <p className="retrieved-memory-item-body">{item.body}</p>
        <time>{new Date(item.createdAt).toLocaleString()}</time>
      </li>
    ))}
  </ul>;
}

/** Rows stored before the split merged open-conversation context into items. */
function splitDetail(detail: RetrievedMemoryDetail): { retrieved: RetrievedMemoryItem[]; shortTerm: RetrievedMemoryItem[] } {
  if (detail.shortTermItems) return { retrieved: detail.items, shortTerm: detail.shortTermItems };
  return { retrieved: detail.items.filter((item) => item.source !== 'active_conversation'), shortTerm: detail.items.filter((item) => item.source === 'active_conversation') };
}

export function RetrievedMemoryDialog({ detail, loading, onClose }: { detail: RetrievedMemoryDetail | null | undefined; loading: boolean; onClose: () => void }) {
  return <ModalDialog className="retrieved-memory-dialog" labelledBy="retrieved-memory-dialog-title" onClose={onClose}>
    <div className="dialog-header"><div><span className="eyebrow">Memory retrieval</span><h2 id="retrieved-memory-dialog-title">What was retrieved for this reply</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={17} /></button></div>
    {loading && <div className="dialog-description" aria-label="Loading retrieval detail"><SkeletonText lines={3} /></div>}
    {!loading && !detail && <p className="dialog-description">No retrieval detail was recorded for this reply.</p>}
    {!loading && detail && (() => {
      const { retrieved, shortTerm } = splitDetail(detail);
      return (
      <div className="retrieved-memory-detail">
        <p className="dialog-description">Query: <code>{detail.query}</code></p>
        {retrieved.length === 0
          ? <p className="dialog-description">No memory items matched this query.</p>
          : <><h3 className="retrieved-memory-section-title">Retrieved memories ({retrieved.length})</h3><MemoryItems items={retrieved} /></>}
        {shortTerm.length > 0 && <details className="retrieved-memory-short-term">
          <summary>Open conversations (always included, not retrieved) ({shortTerm.length})</summary>
          <MemoryItems items={shortTerm} />
        </details>}
      </div>
      );
    })()}
  </ModalDialog>;
}
