import { GitBranch, X } from 'lucide-react';
import { useMemo } from 'react';
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
  return <ModalDialog className="decision-tree-dialog" labelledBy="decision-tree-title" onClose={onClose}>
    <header className="decision-tree-dialog-header">
      <div><span className="eyebrow"><GitBranch size={12} /> Agent debugger</span><h2 id="decision-tree-title">Decisions and tools</h2></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close decision tree"><X size={15} /></button>
    </header>
    {rows.length === 0 && !isLoadingEvents ? <p className="decision-tree-empty">No tool calls have been recorded in this conversation yet.</p>
      : <><ol className="decision-tree">{rows.map((event) => <li key={event.id} className="decision-tree-row">
        {event.rationale && <span><b>Why:</b> {event.rationale}</span>}
        <span><b>Decision:</b> {event.action}</span>
        <span className="decision-tree-details" title={event.detail} tabIndex={0} aria-label={`Details: ${event.detail}`}>Details</span>
      </li>)}</ol>{isLoadingEvents && <p className="decision-tree-loading">Loading agent events…</p>}</>}
  </ModalDialog>;
}
