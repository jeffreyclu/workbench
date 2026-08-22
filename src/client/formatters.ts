import { formatCostUsd } from './insights';
import type { AgentRun, SharedMessage, UpdateWorkItemInput, WorkItemReferenceType } from '../shared/contracts';

export function sourceLinkLabel(sourceUrl: string): string {
  try {
    const host = new URL(sourceUrl).hostname;
    if (host.includes('slack.com')) return 'Open in Slack';
    if (host.includes('github.com')) return 'Open in GitHub';
    if (host.includes('atlassian.net')) return 'Open in Atlassian';
    if (host.includes('figma.com')) return 'Open in Figma';
    if (host.includes('linear.app')) return 'Open in Linear';
  } catch { /* Use the generic label for malformed legacy URLs. */ }
  return 'Open source';
}

export function sourceReferenceType(sourceUrl: string): WorkItemReferenceType {
  try {
    const host = new URL(sourceUrl).hostname.toLowerCase();
    if (host.includes('slack.com')) return 'slack_thread';
    if (host.includes('github.com') && /\/pull\/\d+(?:\/|$)/.test(sourceUrl)) return 'pull_request';
    if (host.includes('linear.app')) return 'linear_issue';
    if (host.includes('atlassian.net') || host.includes('confluence')) return 'document';
  } catch { /* The normal source link still supports legacy malformed URLs. */ }
  return 'other';
}

export function sourceReferenceTitle(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl;
  }
}

export function taskDetailSaveFeedback(input: UpdateWorkItemInput): { success: string; error: string } {
  if ('title' in input) return { success: 'Title saved.', error: 'Could not save the title.' };
  if ('description' in input) return { success: 'Description saved.', error: 'Could not save the description.' };
  if ('assignees' in input) return { success: 'Owners saved.', error: 'Could not save the owners.' };
  if ('blockedByIds' in input) return { success: 'Prerequisites saved.', error: 'Could not save the prerequisites.' };
  return { success: 'Task details saved.', error: 'Could not save the task details.' };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/**
 * The activity log mixes Workbench's own routing decisions with Jeffrey's edits.
 * Labelling each entry keeps both scannable without opening a run.
 */
const activityKindLabels: Record<string, string> = {
  agent_fallback: 'fallback',
  archived: 'archive',
  chat_completed: 'chat',
  chat_started: 'chat',
  classification: 'task type',
  completed: 'done',
  edited: 'edit',
  execution_retried: 'retry',
  execution_started: 'routing',
  model_selected: 'model',
  model_preference: 'model pref',
  provider_conflict_resolved: 'sync',
  queue_moved: 'queue',
  reference_added: 'link',
  restored: 'restore',
  stack_changed: 'stack',
};

export const agentDecisionKinds = new Set(['agent_fallback', 'classification', 'execution_retried', 'execution_started', 'model_selected']);

export function activityKindLabel(kind: string): string {
  return activityKindLabels[kind] ?? kind.replace(/_/g, ' ');
}

export function selectBalancedVisibleAgent(messages: Array<{ author: string }>): 'codex' | 'claude' {
  const codexCount = messages.filter((message) => message.author === 'codex').length;
  const claudeCount = messages.filter((message) => message.author === 'claude').length;
  return codexCount <= claudeCount ? 'codex' : 'claude';
}

export function formatRunTelemetry(entry: Pick<AgentRun | SharedMessage, 'executionProfile' | 'inputTokens' | 'outputTokens' | 'estimatedCostUsd' | 'fallbackFrom' | 'fallbackReason' | 'createdAt' | 'completedAt'> & { startedAt?: string | null }): string {
  const started = entry.startedAt ?? entry.createdAt;
  const duration = entry.completedAt ? Math.max(0, new Date(entry.completedAt).getTime() - new Date(started).getTime()) : null;
  const running = !entry.completedAt;
  const tokenText = running
    ? entry.outputTokens === null ? 'counting tokens…' : `~${entry.outputTokens.toLocaleString()} out · live estimate`
    : entry.inputTokens === null && entry.outputTokens === null ? 'tokens not reported' : `${entry.inputTokens?.toLocaleString() ?? '—'} in · ${entry.outputTokens?.toLocaleString() ?? '—'} out`;
  const durationText = duration === null ? '' : ` · ${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`;
  const fallbackText = entry.fallbackFrom ? ` · fallback from ${entry.fallbackFrom}${entry.fallbackReason ? ` (${entry.fallbackReason})` : ''}` : '';
  const costText = entry.estimatedCostUsd === null ? '' : ` · ${formatCostUsd(entry.estimatedCostUsd)}${running ? ' so far' : ' estimated'}`;
  return `${entry.executionProfile ?? 'unrouted'} · ${tokenText}${costText}${durationText}${fallbackText}`;
}

function compactTokenCount(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatRunBadge(entry: Pick<AgentRun | SharedMessage, 'inputTokens' | 'outputTokens' | 'estimatedCostUsd' | 'completedAt'>): string {
  // Cost is the number Jeffrey actually reads at a glance, so it leads the badge
  // when it is known; raw token counts stay in the hover title.
  const cost = entry.estimatedCostUsd === null ? '' : formatCostUsd(entry.estimatedCostUsd);
  if (!entry.completedAt) {
    if (cost) return `${cost} so far`;
    return entry.outputTokens && entry.outputTokens > 0 ? `~${compactTokenCount(entry.outputTokens)} out` : 'counting…';
  }
  if (entry.inputTokens === null && entry.outputTokens === null) return cost || 'usage unavailable';
  const input = entry.inputTokens === null ? '—' : compactTokenCount(entry.inputTokens);
  const output = entry.outputTokens === null ? '—' : compactTokenCount(entry.outputTokens);
  return `${cost ? `${cost} · ` : ''}${input} in · ${output} out`;
}
