import { GitBranch, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentStreamEvent, SharedMessage } from '../../../shared/contracts';
import { ModalDialog } from '../../modal-dialog';
import { buildDecisionTree, type DecisionTreeEvent } from './decision-tree';

function toolRows(messages: SharedMessage[], events: AgentStreamEvent[]): DecisionTreeEvent[] {
  return buildDecisionTree(messages, events)
    .flatMap((request) => request.children)
    .flatMap((stream) => stream.events)
    .filter((event) => event.kind !== 'decision');
}

export function DecisionTreeVisualizer({ messages, events, isLoadingEvents, onClose }: { messages: SharedMessage[]; events: AgentStreamEvent[]; isLoadingEvents: boolean; onClose: () => void }) {
  const rows = useMemo(() => toolRows(messages, events), [messages, events]);
  const [hoveredDetail, setHoveredDetail] = useState<string | null>(null);
  const [pinnedDetail, setPinnedDetail] = useState<string | null>(null);
  const activeDetail = pinnedDetail ?? hoveredDetail;

  function toggleDetail(detail: string) {
    setPinnedDetail((current) => current === detail ? null : detail);
  }

  return <ModalDialog className="decision-tree-dialog" labelledBy="decision-tree-title" onClose={onClose}>
    <header className="decision-tree-dialog-header">
      <div><span className="eyebrow"><GitBranch size={12} /> Agent debugger</span><h2 id="decision-tree-title">Decisions and tools</h2></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close decision tree"><X size={15} /></button>
    </header>
    {rows.length === 0 && !isLoadingEvents ? <p className="decision-tree-empty">No tool calls have been recorded in this conversation yet.</p>
      : <><div className="decision-tree-table-wrap">
        <table className="decision-tree">
          <thead><tr><th scope="col">Decision</th><th scope="col">Why</th><th scope="col">Details</th></tr></thead>
          <tbody>{rows.map((event) => {
            const isOpen = activeDetail === event.detail;
            return <tr key={event.id}>
              <td title={event.action}>{event.action}</td>
              <td title={event.rationale ?? undefined}>{event.rationale ?? '—'}</td>
              <td className="decision-tree-details">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-describedby={isOpen ? 'decision-tree-details-panel' : undefined}
                  onMouseEnter={() => setHoveredDetail(event.detail)}
                  onMouseLeave={() => setHoveredDetail(null)}
                  onFocus={() => setHoveredDetail(event.detail)}
                  onBlur={() => setHoveredDetail(null)}
                  onClick={() => toggleDetail(event.detail)}
                  onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === 'Escape') setPinnedDetail(null); }}
                >Details</button>
              </td>
            </tr>;
          })}</tbody>
        </table>
        <aside id="decision-tree-details-panel" className="decision-tree-details-panel" aria-live="polite">
          {activeDetail ? <><span>Details</span><code>{activeDetail}</code></> : <span>Hover or select Details to inspect the recorded call.</span>}
        </aside>
      </div>{isLoadingEvents && <p className="decision-tree-loading">Loading agent events…</p>}</>}
  </ModalDialog>;
}
