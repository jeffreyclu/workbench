import { GitBranch, X } from 'lucide-react';
import { memo, useMemo } from 'react';
import type { SharedMessage } from '../../../shared/contracts';
import { ModalDialog } from '../../modal-dialog';
import { buildDecisionTree, type DecisionTreeNode } from './decision-tree';

const TreeNode = memo(function TreeNode({ node }: { node: DecisionTreeNode }) {
  return <li className="decision-tree-node">
    <div className="decision-tree-card">
      <span className={`decision-tree-status status-${node.status}`} aria-label={node.status} />
      <div><strong>{node.label}</strong><small>{node.detail}</small></div>
    </div>
    {node.children.length > 0 && <ol className="decision-tree-children">{node.children.map((child) => <TreeNode key={child.id} node={child} />)}</ol>}
  </li>;
});

export function DecisionTreeVisualizer({ messages, onClose }: { messages: SharedMessage[]; onClose: () => void }) {
  const tree = useMemo(() => buildDecisionTree(messages), [messages]);
  return <ModalDialog className="decision-tree-dialog" labelledBy="decision-tree-title" onClose={onClose}>
    <header className="decision-tree-dialog-header">
      <div><span className="eyebrow"><GitBranch size={12} /> Agent debugger</span><h2 id="decision-tree-title">Decision tree</h2><p>Dispatch choices and their current agent streams.</p></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close decision tree"><X size={15} /></button>
    </header>
    {tree.length === 0 ? <p className="decision-tree-empty">No agent stream has been dispatched in this conversation yet.</p>
      : <ol className="decision-tree">{tree.map((node) => <TreeNode key={node.id} node={node} />)}</ol>}
  </ModalDialog>;
}
