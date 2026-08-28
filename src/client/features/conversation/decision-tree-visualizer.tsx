import { Bot, ChevronDown, GitBranch, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentStreamEvent, SharedMessage } from '../../../shared/contracts';
import { ModalDialog } from '../../components/dialogs/modal-dialog';
import { buildDecisionTree, type DecisionTreeEvent, type DecisionTreeNode } from './decision-tree';

type TreeEvent = DecisionTreeEvent & { stream: DecisionTreeNode };
type EventBranch = { decision: DecisionTreeEvent | null; calls: DecisionTreeEvent[] };

function streamEvents(tree: DecisionTreeNode[]): TreeEvent[] {
  return tree.flatMap((request) => request.children.flatMap((stream) => stream.events.map((event) => ({ ...event, stream }))));
}

function statusLabel(status: DecisionTreeNode['status']) {
  return status === 'running' ? 'Live' : status === 'completed' ? 'Complete' : status;
}

function eventBranches(events: DecisionTreeEvent[]): EventBranch[] {
  const branches: EventBranch[] = [];
  let current: EventBranch | null = null;
  for (const event of events) {
    if (event.kind === 'decision') {
      current = { decision: event, calls: [] };
      branches.push(current);
      continue;
    }
    if (!current || current.decision?.id !== event.decisionId) {
      current = { decision: null, calls: [] };
      branches.push(current);
    }
    current.calls.push(event);
  }
  return branches;
}

function ToolCall({ event, onHoverEvent }: { event: DecisionTreeEvent; onHoverEvent: (event: DecisionTreeEvent | null) => void }) {
  return <li className="decision-tree-tool-call">
    <span className="decision-tree-tool-connector" aria-hidden="true"><ChevronDown size={13} /></span>
    <article className="decision-tree-event-row">
      <span className="decision-tree-event-action" title={event.action}>{event.action}</span>
      <span className="decision-tree-event-rationale" title={event.rationale ?? undefined}>{event.rationale ?? 'No recorded Why.'}</span>
      <button type="button" className="decision-tree-details-pill" onMouseEnter={() => onHoverEvent(event)} onMouseLeave={() => onHoverEvent(null)} onFocus={() => onHoverEvent(event)} onBlur={() => onHoverEvent(null)} onClick={() => onHoverEvent(event)} aria-describedby="decision-tree-details-panel">Details</button>
    </article>
  </li>;
}

function StreamBranch({ stream, onHoverEvent }: { stream: DecisionTreeNode; onHoverEvent: (event: DecisionTreeEvent | null) => void }) {
  const branches = eventBranches(stream.events);
  return <li className="decision-tree-stream">
    <div className="decision-tree-stream-connector" aria-hidden="true" />
    <section className="decision-tree-stream-card" aria-label={`${stream.label} agent stream`}>
      <header><span className="decision-tree-stream-icon"><Bot size={13} /></span><div><strong>{stream.label}</strong><span>{stream.detail}</span></div><em className={`decision-tree-status is-${stream.status}`}>{statusLabel(stream.status)}</em></header>
      {stream.events.length > 0 ? <ol className="decision-tree-events">{branches.map((branch, index) => <li key={branch.decision?.id ?? `unrecorded-${index}`} className={`decision-tree-decision-branch ${branch.decision ? '' : 'is-unrecorded'}`}>
        <span className="decision-tree-event-connector" aria-hidden="true"><ChevronDown size={13} /></span>
        {branch.calls.length > 0 && <ol className="decision-tree-tool-calls">{branch.calls.map((event) => <ToolCall key={event.id} event={event} onHoverEvent={onHoverEvent} />)}</ol>}
        {!branch.decision && branch.calls.length === 0 && <div className="decision-tree-unrecorded"><strong>No recorded decision</strong><span>This event has no provider-authored Why.</span></div>}
      </li>)}</ol> : <p className="decision-tree-awaiting">Waiting for recorded decisions or tool calls.</p>}
    </section>
  </li>;
}

export function DecisionTreeVisualizer({ messages, events, isLoadingEvents, onClose }: { messages: SharedMessage[]; events: AgentStreamEvent[]; isLoadingEvents: boolean; onClose: () => void }) {
  const tree = useMemo(() => buildDecisionTree(messages, events), [messages, events]);
  const allEvents = useMemo(() => streamEvents(tree), [tree]);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const activeEvent = allEvents.find((event) => event.id === hoveredEventId) ?? null;

  return <ModalDialog className="decision-tree-dialog" labelledBy="decision-tree-title" onClose={onClose}>
    <header className="decision-tree-dialog-header">
      <div><span className="eyebrow"><GitBranch size={12} /> Agent debugger</span><h2 id="decision-tree-title">Decision map</h2><p>Follow each request through the agent’s decisions and tool calls.</p></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close decision tree"><X size={15} /></button>
    </header>
    {tree.length === 0 && !isLoadingEvents ? <p className="decision-tree-empty">No agent streams have been recorded in this conversation yet.</p>
      : <div className="decision-tree-layout"><ol className="decision-tree-roots" aria-label="Agent decision tree">{tree.map((request) => <li key={request.id} className="decision-tree-root"><div className="decision-tree-root-card"><span><GitBranch size={13} /> Request</span><strong>{request.label}</strong><small><b>Brief</b>{request.detail}</small>{request.meta && <em>{request.meta}</em>}</div>{request.children.length > 0 && <details className="decision-tree-branches"><summary>{request.children.length} agent {request.children.length === 1 ? 'branch' : 'branches'}</summary><ol className="decision-tree-streams">{request.children.map((stream) => <StreamBranch key={stream.id} stream={stream} onHoverEvent={(event) => setHoveredEventId(event?.id ?? null)} />)}</ol></details>}</li>)}</ol><aside id="decision-tree-details-panel" className="decision-tree-details-panel" aria-live="polite">{activeEvent ? <><span>{activeEvent.kind === 'decision' ? 'Recorded decision' : `${activeEvent.stream.label} tool call`}</span><code>{activeEvent.detail}</code></> : <span>Hover or focus a decision or tool call to inspect the recorded detail.</span>}</aside>{isLoadingEvents && <p className="decision-tree-loading">Loading agent events…</p>}</div>}
  </ModalDialog>;
}
