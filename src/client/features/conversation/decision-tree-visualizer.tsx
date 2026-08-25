import { Bot, ChevronDown, CircleDot, GitBranch, Terminal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentStreamEvent, SharedMessage } from '../../../shared/contracts';
import { ModalDialog } from '../../modal-dialog';
import { buildDecisionTree, type DecisionTreeEvent, type DecisionTreeNode } from './decision-tree';

type TreeEvent = DecisionTreeEvent & { stream: DecisionTreeNode };

function streamEvents(tree: DecisionTreeNode[]): TreeEvent[] {
  return tree.flatMap((request) => request.children.flatMap((stream) => stream.events.map((event) => ({ ...event, stream }))));
}

function statusLabel(status: DecisionTreeNode['status']) {
  return status === 'running' ? 'Live' : status === 'completed' ? 'Complete' : status;
}

function EventNode({ event, isSelected, onSelect, onHover }: { event: DecisionTreeEvent; isSelected: boolean; onSelect: () => void; onHover: (isActive: boolean) => void }) {
  const isDecision = event.kind === 'decision';
  return <li className={`decision-tree-event ${isDecision ? 'is-decision' : 'is-tool'}`}>
    <span className="decision-tree-event-connector" aria-hidden="true"><ChevronDown size={13} /></span>
    <article className="decision-tree-event-card">
      <div className="decision-tree-event-type">{isDecision ? <CircleDot size={12} /> : <Terminal size={12} />}<span>{isDecision ? 'Decision' : 'Tool call'}</span></div>
      <p>{isDecision ? event.detail : event.action}</p>
      {!isDecision && event.rationale && <p className="decision-tree-event-why"><span>Why</span>{event.rationale}</p>}
      <button type="button" className="decision-tree-inspect" aria-expanded={isSelected} aria-controls="decision-tree-details-panel" onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} onFocus={() => onHover(true)} onBlur={() => onHover(false)} onClick={onSelect} onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === 'Escape') onSelect(); }}>{isSelected ? 'Hide details' : 'Inspect call'}</button>
    </article>
  </li>;
}

function StreamBranch({ stream, selectedEventId, onSelectEvent, onHoverEvent }: { stream: DecisionTreeNode; selectedEventId: string | null; onSelectEvent: (event: DecisionTreeEvent) => void; onHoverEvent: (event: DecisionTreeEvent | null) => void }) {
  return <li className="decision-tree-stream">
    <div className="decision-tree-stream-connector" aria-hidden="true" />
    <section className="decision-tree-stream-card" aria-label={`${stream.label} agent stream`}>
      <header><span className="decision-tree-stream-icon"><Bot size={13} /></span><div><strong>{stream.label}</strong><span>{stream.detail}</span></div><em className={`decision-tree-status is-${stream.status}`}>{statusLabel(stream.status)}</em></header>
      {stream.events.length > 0 ? <ol className="decision-tree-events">{stream.events.map((event) => <EventNode key={event.id} event={event} isSelected={selectedEventId === event.id} onSelect={() => onSelectEvent(event)} onHover={(isActive) => onHoverEvent(isActive ? event : null)} />)}</ol> : <p className="decision-tree-awaiting">Waiting for recorded decisions or tool calls.</p>}
    </section>
  </li>;
}

export function DecisionTreeVisualizer({ messages, events, isLoadingEvents, onClose }: { messages: SharedMessage[]; events: AgentStreamEvent[]; isLoadingEvents: boolean; onClose: () => void }) {
  const tree = useMemo(() => buildDecisionTree(messages, events), [messages, events]);
  const allEvents = useMemo(() => streamEvents(tree), [tree]);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const activeEvent = allEvents.find((event) => event.id === (selectedEventId ?? hoveredEventId)) ?? null;

  function selectEvent(event: DecisionTreeEvent) { setSelectedEventId((current) => current === event.id ? null : event.id); }

  return <ModalDialog className="decision-tree-dialog" labelledBy="decision-tree-title" onClose={onClose}>
    <header className="decision-tree-dialog-header">
      <div><span className="eyebrow"><GitBranch size={12} /> Agent debugger</span><h2 id="decision-tree-title">Decision map</h2><p>Follow each request through the agent’s decisions and tool calls.</p></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close decision tree"><X size={15} /></button>
    </header>
    {tree.length === 0 && !isLoadingEvents ? <p className="decision-tree-empty">No agent streams have been recorded in this conversation yet.</p>
      : <div className="decision-tree-layout"><ol className="decision-tree-roots" aria-label="Agent decision tree">{tree.map((request) => <li key={request.id} className="decision-tree-root"><div className="decision-tree-root-card"><span><GitBranch size={13} /> Request</span><strong>{request.label}</strong><small>{request.detail}</small></div>{request.children.length > 0 && <ol className="decision-tree-streams">{request.children.map((stream) => <StreamBranch key={stream.id} stream={stream} selectedEventId={selectedEventId} onSelectEvent={selectEvent} onHoverEvent={(event) => setHoveredEventId(event?.id ?? null)} />)}</ol>}</li>)}</ol><aside id="decision-tree-details-panel" className="decision-tree-details-panel" aria-live="polite">{activeEvent ? <><span>{activeEvent.kind === 'decision' ? 'Recorded decision' : `${activeEvent.stream.label} tool call`}</span><code>{activeEvent.detail}</code></> : <span>Select a decision or tool call to inspect the recorded detail.</span>}</aside>{isLoadingEvents && <p className="decision-tree-loading">Loading agent events…</p>}</div>}
  </ModalDialog>;
}
