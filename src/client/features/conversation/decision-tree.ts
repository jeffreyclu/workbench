import type { AgentStreamEvent, SharedMessage } from '../../../shared/contracts';

export type DecisionTreeNode = {
  id: string;
  label: string;
  detail: string;
  meta: string | null;
  status: SharedMessage['status'] | 'completed';
  events: DecisionTreeEvent[];
  children: DecisionTreeNode[];
};

export type DecisionTreeEvent = AgentStreamEvent & {
  action: string;
  rationale: string | null;
  decisionId: string | null;
};

const isAgentMessage = (message: SharedMessage) => message.author === 'codex' || message.author === 'claude';

function requestLabel(message: SharedMessage) {
  const target = message.dispatchTarget === 'both' ? 'Codex + Claude'
    : message.dispatchTarget === 'auto' ? 'automatic routing'
      : message.dispatchTarget[0].toUpperCase() + message.dispatchTarget.slice(1);
  return `Requested ${target}`;
}

function readableCommand(command: string): string {
  if (/(?:npm|pnpm|yarn) (?:test|run test)|vitest/.test(command)) return 'Ran the test suite.';
  if (/(?:npm|pnpm|yarn) run (?:build|typecheck|lint)/.test(command)) return 'Verified the project.';
  if (/git (?:status|diff|log)/.test(command)) return 'Inspected repository changes.';
  if (/(?:rg|grep|find)\b/.test(command)) return 'Searched the codebase.';
  if (/(?:cat|sed|head|tail)\b/.test(command)) return 'Read project files.';
  return 'Ran a workspace command.';
}

export function formatDecisionTreeEvents(events: AgentStreamEvent[]): DecisionTreeEvent[] {
  let latestRationale: string | null = null;
  let latestDecisionId: string | null = null;
  return events.map((event) => {
    if (event.kind === 'decision') {
      latestRationale = event.detail;
      latestDecisionId = event.id;
      return { ...event, action: 'Recorded the approach.', rationale: null, decisionId: null };
    }
    const action = event.kind === 'file_read' ? `Read ${event.detail}.`
      : event.kind === 'file_write' ? `Updated ${event.detail.replace(/^(?:update|create|delete):\s*/i, '')}.`
        : event.detail.startsWith('command_execution: ')
          ? readableCommand(event.detail.slice('command_execution: '.length))
          : `Used ${event.detail}.`;
    return { ...event, action, rationale: latestRationale, decisionId: latestDecisionId };
  });
}

function streamNode(message: SharedMessage, events: AgentStreamEvent[]): DecisionTreeNode {
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
    meta: null,
    status: message.status,
    events: formatDecisionTreeEvents(events.filter((event) => event.messageId === message.id)),
    children: [],
  };
}

/**
 * Maps the canonical message stream into a compact dispatch tree. A user turn
 * is a branching decision; agent replies inherit that turn through
 * dispatchGroupId. Older records without that id fall back to the immediately
 * preceding user turn, preserving useful debugging context without writes.
 */
export function buildDecisionTree(messages: SharedMessage[], events: AgentStreamEvent[] = []): DecisionTreeNode[] {
  const requests = new Map<string, DecisionTreeNode>();
  const nodes: DecisionTreeNode[] = [];
  let latestRequest: DecisionTreeNode | null = null;

  for (const message of messages) {
    if (message.author === 'jeffrey' && message.dispatchTarget !== 'none') {
      const node: DecisionTreeNode = {
        id: message.id,
        label: requestLabel(message),
        detail: message.body.trim() || 'No written brief.',
        meta: message.queuePriority ? 'Interjected ahead of queued work' : null,
        status: message.status,
        events: [],
        children: [],
      };
      nodes.push(node);
      requests.set(message.id, node);
      latestRequest = node;
      continue;
    }
    if (!isAgentMessage(message)) continue;
    const parent = message.dispatchGroupId ? requests.get(message.dispatchGroupId) : latestRequest;
    if (parent) parent.children.push(streamNode(message, events));
  }
  return nodes;
}
