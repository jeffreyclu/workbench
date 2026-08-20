import type { AgentRun, SharedMessage } from '../shared/contracts.js';
import { judgeExecutionProfile, modelFor, runAgentCommandWithFallback } from './agent-runner.js';
import { WorkItemRepository } from './repository.js';
import { contextForPrompt } from './connection-broker.js';

const activeReplies = new Map<string, AbortController>();
const replyRunIds = new Map<string, string>();
export const isSharedReplyActive = (id: string) => activeReplies.has(id);

function connectionSearchQuery(message: string): string {
  return message.replace(/https?:\/\/\S+/g, ' ').replace(/\b(?:linear|search|find|look|show|check|issues?|tasks?|tickets?|for|in|on|the|a|an|me|please)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

export const connectionContextForPrompt = contextForPrompt;

export function linearContextForPrompt(repository: WorkItemRepository, message: string): string {
  if (!/\blinear\b|linear\.app/i.test(message)) return '';
  const query = connectionSearchQuery(message);
  const items = repository.searchLinear(query, 10);
  if (!items.length) return `Workbench Linear context: the synced Linear catalog has no matches for ${query ? `“${query}”` : 'this request'}. Do not direct Jeffrey to a dialog; explain that no synced match was found.`;
  return `Workbench Linear context (synced catalog; use this directly and do not ask Jeffrey to open a dialog):\n${items.map((item) => [
    `- ${item.sourceIdentifier ?? 'Linear'}: ${item.title}`,
    `  Project: ${item.projectName ?? 'none'}; status: ${item.status}`,
    item.sourceUrl ? `  URL: ${item.sourceUrl}` : '',
    item.description ? `  Description: ${item.description.slice(0, 2_000)}` : '',
  ].filter(Boolean).join('\n')).join('\n')}`;
}

export function dispatchNextSharedTurn(repository: WorkItemRepository, conversationId: string): SharedMessage[] {
  if (repository.listSharedMessages(1_000, conversationId).some((message) => message.status === 'running')) return [];
  const queued = repository.nextQueuedSharedTurn(conversationId);
  if (!queued) return [];
  repository.updateSharedMessage(queued.message.id, { status: 'completed' });
  const agents = queued.dispatchTarget === 'both' ? ['codex', 'claude'] as const
    : queued.dispatchTarget === 'auto' ? [repository.selectBalancedAgent('codex')] : [queued.dispatchTarget];
  const conversation = repository.listConversations().find((item) => item.id === conversationId);
  const linkedItem = conversation?.workItemId ? repository.get(conversation.workItemId) : null;
  if (linkedItem && !linkedItem.archivedAt && linkedItem.status !== 'done' && linkedItem.status !== 'canceled') {
    repository.update(linkedItem.id, { status: 'in_progress' });
    const attachmentText = queued.message.attachments.length ? ` · ${queued.message.attachments.length} attachment${queued.message.attachments.length === 1 ? '' : 's'}` : '';
    repository.addActivity(linkedItem.id, 'jeffrey', 'chat_started', `To ${agents.join(' and ')}${attachmentText}: ${queued.message.body.trim() || '(attachment-only message)'}`);
  }
  const replies = agents.map((agent) => repository.createSharedMessage(agent, '', 'running', conversationId));
  for (const reply of replies) {
    const agent = reply.author as AgentRun['agent'];
    const run = linkedItem && !linkedItem.archivedAt && linkedItem.status !== 'done' && linkedItem.status !== 'canceled'
      ? repository.createRun(linkedItem.id, 'analysis', queued.dispatchTarget, agent, queued.message.body, conversationId)
      : null;
    void replyInSharedRoom(repository, agent, reply.id, run?.id);
  }
  return replies;
}

function settleLinkedTask(repository: WorkItemRepository, conversationId: string, reason: string): void {
  if (repository.listSharedMessages(1_000, conversationId).some((message) => message.status === 'running')) return;
  const conversation = repository.listConversations().find((item) => item.id === conversationId);
  if (!conversation?.workItemId) return;
  const item = repository.get(conversation.workItemId);
  if (!item || item.archivedAt || item.status !== 'in_progress') return;
  repository.update(item.id, { status: 'ready' });
  repository.moveForAttention(item.id, 'top', reason);
  repository.addActivity(item.id, 'system', 'chat_completed', reason);
}

export async function runSharedBackgroundJob(
  repository: WorkItemRepository,
  messageId: string,
  job: (signal: AbortSignal, onProgress: (body: string) => void) => Promise<string>,
): Promise<void> {
  const controller = new AbortController();
  activeReplies.set(messageId, controller);
  try {
    const body = await job(controller.signal, (partial) => repository.updateSharedMessage(messageId, { body: partial }));
    repository.updateSharedMessage(messageId, { body, status: 'completed' });
  } catch (error) {
    repository.updateSharedMessage(messageId, controller.signal.aborted
      ? { status: 'canceled' }
      : { status: 'failed', error: error instanceof Error ? error.message : 'Background job failed.' });
  } finally { activeReplies.delete(messageId); }
}

export async function replyInSharedRoom(repository: WorkItemRepository, agent: AgentRun['agent'], messageId: string, runId?: string): Promise<void> {
  const target = repository.listSharedMessages(1_000).find((message) => message.id === messageId);
  if (!target) return;
  const controller = new AbortController();
  activeReplies.set(messageId, controller);
  if (runId) {
    replyRunIds.set(messageId, runId);
    repository.updateRun(runId, { status: 'running', startedAt: new Date().toISOString() });
  }
  try {
    const thread = repository.listSharedMessages(100, target.conversationId).filter((message) => message.id !== messageId);
    const latestUserMessage = [...thread].reverse().find((message) => message.author === 'jeffrey')?.body ?? '';
    const connectionContext = await connectionContextForPrompt(repository, latestUserMessage);
    const prompt = `You are ${agent}, participating in Jeffrey's shared Workbench room with Jeffrey, Codex, and Claude.

${repository.getSharedContext(target.conversationId)}

${connectionContext}

Current conversation:
${thread.slice(-12).map((message) => `${message.author}: ${message.body.slice(0, 4_000)}${message.attachments.length ? `\nAttached files:\n${message.attachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')}` : ''}`).join('\n\n')}

Respond directly to Jeffrey's latest message. Be concise and useful. Build on the shared context, but do not impersonate or wait for the other agent. This is a non-interactive environment: use tools directly and never tell Jeffrey to grant a permission, approve a terminal prompt, or look at a dialog. If access is missing, name the exact unavailable integration or credential.`;
    repository.updateSharedMessage(messageId, { model: modelFor('codex', 'economy'), executionProfile: 'routing' });
    const profile = await judgeExecutionProfile(latestUserMessage || prompt, process.cwd(), controller.signal);
    repository.updateSharedMessage(messageId, { model: modelFor(agent, profile), executionProfile: profile });
    if (runId) repository.updateRun(runId, { model: modelFor(agent, profile), executionProfile: profile });
    const result = await runAgentCommandWithFallback(agent, process.cwd(), prompt, (partial) => {
      repository.updateSharedMessage(messageId, { body: partial });
      if (runId) repository.updateRun(runId, { output: partial });
    }, controller.signal, (fallback) => {
      repository.updateSharedMessage(messageId, { author: fallback, model: modelFor(fallback, profile), executionProfile: profile });
      if (runId) repository.updateRun(runId, { agent: fallback, model: modelFor(fallback, profile), executionProfile: profile });
    }, profile);
    repository.updateSharedMessage(messageId, { author: result.agent, body: result.output, status: 'completed' });
    if (runId) repository.updateRun(runId, { agent: result.agent, output: result.output, status: 'completed', completedAt: new Date().toISOString() });
  } catch (error) {
    if (controller.signal.aborted) {
      repository.updateSharedMessage(messageId, { status: 'canceled' });
      if (runId) repository.updateRun(runId, { status: 'canceled', completedAt: new Date().toISOString() });
      return;
    }
    const errorMessage = error instanceof Error ? error.message : 'Agent response failed.';
    repository.updateSharedMessage(messageId, {
      status: 'failed', error: errorMessage,
    });
    if (runId) repository.updateRun(runId, { status: 'failed', error: errorMessage, completedAt: new Date().toISOString() });
  } finally {
    activeReplies.delete(messageId);
    replyRunIds.delete(messageId);
    const dispatched = dispatchNextSharedTurn(repository, target.conversationId);
    if (!dispatched.length) settleLinkedTask(repository, target.conversationId, `${agent} finished responding; review the conversation.`);
  }
}

export function cancelSharedReply(repository: WorkItemRepository, messageId: string) {
  const message = repository.listSharedMessages(1_000).find((item) => item.id === messageId);
  if (!message || message.status !== 'running') return null;
  activeReplies.get(messageId)?.abort();
  repository.updateSharedMessage(messageId, { status: 'canceled' });
  const runId = replyRunIds.get(messageId);
  if (runId) repository.updateRun(runId, { status: 'canceled', completedAt: new Date().toISOString() });
  const dispatched = dispatchNextSharedTurn(repository, message.conversationId);
  if (!dispatched.length) settleLinkedTask(repository, message.conversationId, 'Agent conversation was canceled; review or redirect the task.');
  return { ...message, status: 'canceled' as const };
}
