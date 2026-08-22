import { Bot, Cloud, FileText, GitPullRequest, Link2, MessageSquare, User } from 'lucide-react';
import type { AgentRun, SharedConversation, WorkItemReferenceType } from '../shared/contracts';

export function ReferenceTypeIcon({ type }: { type: WorkItemReferenceType }) {
  if (type === 'linear_issue') return <Cloud size={13} />;
  if (type === 'pull_request') return <GitPullRequest size={13} />;
  if (type === 'slack_thread') return <MessageSquare size={13} />;
  if (type === 'document') return <FileText size={13} />;
  return <Link2 size={13} />;
}

export function ConversationOriginBadge({ workItemId }: Pick<SharedConversation, 'workItemId'>) {
  const isTaskLinked = Boolean(workItemId);
  return <span
    className={`conversation-origin conversation-origin-${isTaskLinked ? 'task' : 'manual'}`}
    title={isTaskLinked ? 'Created automatically for a task' : 'Created manually'}
  >
    {isTaskLinked ? <Bot size={10} aria-hidden="true" /> : <User size={10} aria-hidden="true" />}
    {isTaskLinked ? 'Task-linked' : 'Manual'}
  </span>;
}
export function ModelProfileSelect({ value, onChange, className = '' }: { value: AgentRun['executionProfile']; onChange: (value: AgentRun['executionProfile']) => void; className?: string }) {
  return <select className={className} value={value ?? 'auto'} onChange={(event) => onChange(event.target.value === 'auto' ? null : event.target.value as NonNullable<AgentRun['executionProfile']>)} aria-label="Model choice">
    <option value="auto">Auto model</option>
    <option value="economy">Fast · Haiku / Luna</option>
    <option value="standard">Balanced · Sonnet / Terra</option>
    <option value="deep">Powerful · Opus / Sol</option>
  </select>;
}
