import { Brain, FilePenLine, FileSearch, Terminal, GitBranch, X } from 'lucide-react';
import { memo, useMemo } from 'react';
import type { AgentStreamEvent, SharedMessage } from '../../../shared/contracts';
import { ModalDialog } from '../../modal-dialog';
import { buildDecisionTree, type DecisionTreeNode } from './decision-tree';

const TreeNode = memo(function TreeNode({ node }: { node: DecisionTreeNode }) {
  return <li className="decision-tree-node">
    <div className="decision-tree-card">
      <span className={`decision-tree-status status-${node.status}`} aria-label={node.status} />
      <div><strong>{node.label}</strong><small>{node.detail}</small></div>
    </div>
    {node.events.length > 0 && <ol className="decision-tree-events" aria-label={`${node.label} decisions and tools`}>
      {node.events.map((event) => <li key={event.id} className={`decision-tree-event kind-${event.kind}`}>
        {event.kind === 'decision' ? <Brain size={12} /> : event.kind === 'file_read' ? <FileSearch size={12} /> : event.kind === 'file_write' ? <FilePenLine size={12} /> : <Terminal size={12} />}
        <div>
          <span>{event.kind === 'decision' ? 'Decision' : event.kind === 'tool' ? 'Tool call' : event.kind === 'file_read' ? 'Read' : 'Write'}</span>
          <strong>{event.action}</strong>
          {event.kind === 'decision' ? <small>{event.detail}</small> : <>
            <small>Details: {event.detail}</small>
            {event.rationale && <small className="decision-tree-rationale">Why: {event.rationale}</small>}
          </>}
        </div>
      </li>)}
    </ol>}
    {node.children.length > 0 && <ol className="decision-tree-children">{node.children.map((child) => <TreeNode key={child.id} node={child} />)}</ol>}
  </li>;
});

export function DecisionTreeVisualizer({ messages, events, isLoadingEvents, onClose }: { messages: SharedMessage[]; events: AgentStreamEvent[]; isLoadingEvents: boolean; onClose: () => void }) {
  const tree = useMemo(() => buildDecisionTree(messages, events), [messages, events]);
  return <ModalDialog className="decision-tree-dialog" labelledBy="decision-tree-title" onClose={onClose}>
    <header className="decision-tree-dialog-header">
      <div><span className="eyebrow"><GitBranch size={12} /> Agent debugger</span><h2 id="decision-tree-title">Decisions and tools</h2><p>What each agent decided and called while handling this turn.</p></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close decision tree"><X size={15} /></button>
    </header>
    {tree.length === 0 ? <p className="decision-tree-empty">No agent stream has been dispatched in this conversation yet.</p>
      : <><ol className="decision-tree">{tree.map((node) => <TreeNode key={node.id} node={node} />)}</ol>{isLoadingEvents && <p className="decision-tree-loading">Loading agent events…</p>}</>}
  </ModalDialog>;
}
