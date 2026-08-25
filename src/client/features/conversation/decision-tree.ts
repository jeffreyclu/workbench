import type { SharedMessage } from '../../../shared/contracts';

export type DecisionTreeNode = {
  id: string;
  label: string;
  detail: string;
  status: SharedMessage['status'] | 'completed';
  children: DecisionTreeNode[];
};

const isAgentMessage = (message: SharedMessage) => message.author === 'codex' || message.author === 'claude';

function requestLabel(message: SharedMessage) {
  const target = message.dispatchTarget === 'both' ? 'Codex + Claude'
    : message.dispatchTarget === 'auto' ? 'automatic routing'
      : message.dispatchTarget[0].toUpperCase() + message.dispatchTarget.slice(1);
  return `Requested ${target}`;
}

function streamNode(message: SharedMessage): DecisionTreeNode {
  const telemetry = [
    message.model,
    message.executionProfile && message.executionProfile !== 'routing' ? message.executionProfile : null,
    message.accountProfile,
    message.attempt > 0 ? `attempt ${message.attempt + 1}` : null,
  ].filter(Boolean).join(' · ');
  const details = [telemetry || 'Starting stream', typeof message.retrievedMemoryCount === 'number'
    ? `${message.retrievedMemoryCount} memory match${message.retrievedMemoryCount === 1 ? '' : 'es'}`
    : null, message.fallbackFrom ? `fallback from ${message.fallbackFrom}` : null, message.error || null]
    .filter(Boolean).join(' · ');
  return {
    id: message.id,
    label: message.author[0].toUpperCase() + message.author.slice(1),
    detail: details,
    status: message.status,
    children: [],
  };
}

/**
 * Maps the canonical message stream into a compact dispatch tree. A user turn
 * is a branching decision; agent replies inherit that turn through
 * dispatchGroupId. Older records without that id fall back to the immediately
 * preceding user turn, preserving useful debugging context without writes.
 */
export function buildDecisionTree(messages: SharedMessage[]): DecisionTreeNode[] {
  const requests = new Map<string, DecisionTreeNode>();
  const nodes: DecisionTreeNode[] = [];
  let latestRequest: DecisionTreeNode | null = null;

  for (const message of messages) {
    if (message.author === 'jeffrey' && message.dispatchTarget !== 'none') {
      const node: DecisionTreeNode = {
        id: message.id,
        label: requestLabel(message),
        detail: message.queuePriority ? 'Interjected ahead of queued work' : 'Conversation turn',
        status: message.status,
        children: [],
      };
      nodes.push(node);
      requests.set(message.id, node);
      latestRequest = node;
      continue;
    }
    if (!isAgentMessage(message)) continue;
    const parent = message.dispatchGroupId ? requests.get(message.dispatchGroupId) : latestRequest;
    if (parent) parent.children.push(streamNode(message));
  }
  return nodes;
}
