import type { AgentRun, SharedMessage } from '../shared/contracts.js';
import { judgeExecutionProfile, modelFor, runAgentCommandWithFallback, selectPromptExecutionProfile } from './agent-runner.js';
import { WorkItemRepository } from './repository.js';
import { contextForPrompt } from './connection-broker.js';
import { OWNER_ID, LEASE_MS } from './scheduler.js';

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
  const busyAgents = new Set(
    repository.listAllSharedMessages(conversationId)
      .filter((message) => message.status === 'running' && (message.author === 'codex' || message.author === 'claude'))
      .map((message) => message.author as AgentRun['agent']),
  );
  const queued = repository.nextQueuedSharedTurn(conversationId, busyAgents);
  if (!queued) return [];
  // Atomic conditional claim: guards against two concurrent callers (e.g. two
  // GET /api/shared/messages requests racing) both promoting and dispatching
  // the same queued turn.
  if (!repository.claimQueuedTurn(queued.message.id)) return [];
  const agents = queued.dispatchTarget === 'both' ? ['codex', 'claude'] as const
    : queued.dispatchTarget === 'auto' ? [repository.selectBalancedAgent('codex')] : [queued.dispatchTarget];
  const conversation = repository.listConversations().find((item) => item.id === conversationId);
  const linkedItem = conversation?.workItemId ? repository.get(conversation.workItemId) : null;
  if (linkedItem && !linkedItem.archivedAt && linkedItem.status !== 'done' && linkedItem.status !== 'canceled') {
    repository.update(linkedItem.id, { status: 'in_progress' });
    const attachmentText = queued.message.attachments.length ? ` · ${queued.message.attachments.length} attachment${queued.message.attachments.length === 1 ? '' : 's'}` : '';
    repository.addActivity(linkedItem.id, 'jeffrey', 'chat_started', `To ${agents.join(' and ')}${attachmentText}: ${queued.message.body.trim() || '(attachment-only message)'}`);
  }
  const replies = agents.map((agent) => repository.createSharedMessage(agent, '', 'running', conversationId, [], 'none', queued.message.executionProfile === 'routing' ? null : queued.message.executionProfile));
  for (const reply of replies) {
    const agent = reply.author as AgentRun['agent'];
    const run = linkedItem && !linkedItem.archivedAt && linkedItem.status !== 'done' && linkedItem.status !== 'canceled'
      ? repository.createRun(linkedItem.id, 'analysis', queued.dispatchTarget, agent, queued.message.body, conversationId, reply.id)
      : null;
    void replyInSharedRoom(repository, agent, reply.id, run?.id);
  }
  return replies;
}

function settleLinkedTask(repository: WorkItemRepository, conversationId: string, reason: string): void {
  if (repository.listAllSharedMessages(conversationId).some((message) => message.status === 'running')) return;
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
  const target = repository.getSharedMessageById(messageId);
  // Claim a lease so the scheduler knows this process is actively working on this message.
  if (!repository.claimSharedMessage(messageId, OWNER_ID, LEASE_MS)) return;

  const controller = new AbortController();
  activeReplies.set(messageId, controller);
  try {
    const body = await job(controller.signal, (partial) => repository.updateSharedMessage(messageId, { body: partial }));
    repository.updateSharedMessage(messageId, { body, status: 'completed' });
  } catch (error) {
    repository.updateSharedMessage(messageId, controller.signal.aborted
      ? { status: 'canceled' }
      : { status: 'failed', error: error instanceof Error ? error.message : 'Background job failed.' });
  } finally {
    activeReplies.delete(messageId);
    if (target) settleLinkedTask(repository, target.conversationId, 'Agent work finished; review the conversation.');
  }
}

export async function replyInSharedRoom(repository: WorkItemRepository, agent: AgentRun['agent'], messageId: string, runId?: string): Promise<void> {
  const target = repository.getSharedMessageById(messageId);
  if (!target) return;

  // Claim a lease so the scheduler knows this process is actively working on this message.
  // On restart, expired leases trigger recovery (mark failed for messages without runs).
  if (!repository.claimSharedMessage(messageId, OWNER_ID, LEASE_MS)) return;

  const controller = new AbortController();
  activeReplies.set(messageId, controller);
  if (runId) {
    replyRunIds.set(messageId, runId);
    repository.updateRun(runId, { status: 'running', startedAt: new Date().toISOString() });
  }
  try {
    const thread = repository.listSharedMessages(100, null, target.conversationId).messages.filter((message) => message.id !== messageId);
    const latestUserMessage = [...thread].reverse().find((message) => message.author === 'jeffrey')?.body ?? '';
    const recentSourceReferences = thread.filter((message) => message.author === 'jeffrey' && /https?:\/\/(?:[^\s/]+\.)?(?:atlassian\.net|github\.com|slack\.com|linear\.app)\//i.test(message.body)).slice(-3).map((message) => message.body);
    const connectionContext = await connectionContextForPrompt(repository, [latestUserMessage, ...recentSourceReferences].join('\n'));
    const prompt = `You are ${agent}, participating in Jeffrey's shared Workbench room with Jeffrey, Codex, and Claude.

${repository.getSharedContext(target.conversationId, { conversationId: target.conversationId })}

${connectionContext}

Current conversation:
${thread.slice(-12).map((message) => `${message.author}: ${message.body.slice(0, 4_000)}${message.attachments.length ? `\nAttached files:\n${message.attachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')}` : ''}`).join('\n\n')}

Respond directly to Jeffrey's latest message. Be concise and useful. Build on the shared context, but do not impersonate or wait for the other agent. This is a non-interactive environment: use tools directly and never tell Jeffrey to grant a permission, approve a terminal prompt, or look at a dialog. If access is missing, name the exact unavailable integration or credential.`;
    const selfHostingGuard = `

Workbench self-hosting safety:
This conversation is running inside the live Workbench control plane. Source edits appear in the preview at http://localhost:5174; the approved live release stays at http://localhost:5173. Never run runtime:promote, start, stop, restart, or kill Workbench, Vite, ngrok, or their ports from an agent response. Never claim either environment is down without an actual HTTP health check. If Jeffrey reports a preview bug, inspect and fix the source, verify it, and ask him to review the preview. Promotion happens only through Workbench's explicit preview-approval command after all agent work finishes.`;
    repository.updateSharedMessage(messageId, { model: modelFor('codex', 'economy'), executionProfile: 'routing' });
    const guardedPrompt = prompt + selfHostingGuard;
    const profile = target.executionProfile && target.executionProfile !== 'routing'
      ? target.executionProfile
      : await judgeExecutionProfile(latestUserMessage || guardedPrompt, process.cwd(), controller.signal);
    repository.updateSharedMessage(messageId, { model: modelFor(agent, profile), executionProfile: profile });
    if (runId) repository.updateRun(runId, { model: modelFor(agent, profile), executionProfile: profile });
    const result = await runAgentCommandWithFallback(agent, process.cwd(), guardedPrompt, (partial) => {
      repository.updateSharedMessage(messageId, { body: partial });
      if (runId) repository.updateRun(runId, { output: partial });
    }, controller.signal, (fallback, reason) => {
      repository.updateSharedMessage(messageId, { author: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: agent, fallbackReason: reason.slice(0, 500) });
      if (runId) repository.updateRun(runId, { agent: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: agent, fallbackReason: reason.slice(0, 500) });
    }, profile, (usage) => {
      const telemetry = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd };
      repository.updateSharedMessage(messageId, telemetry);
      if (runId) repository.updateRun(runId, telemetry);
    });
    const telemetry = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, estimatedCostUsd: result.usage.estimatedCostUsd, fallbackFrom: result.fallbackFrom, fallbackReason: result.fallbackReason };
    repository.updateSharedMessage(messageId, { author: result.agent, body: result.output, status: 'completed', ...telemetry });
    if (runId) repository.updateRun(runId, { agent: result.agent, output: result.output, status: 'completed', completedAt: new Date().toISOString(), ...telemetry });
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
    const synthesized = await synthesizeSharedTurn(repository, target.conversationId, target.createdAt);
    const dispatched = dispatchNextSharedTurn(repository, target.conversationId);
    if (!synthesized && !dispatched.length) settleLinkedTask(repository, target.conversationId, `${agent} finished responding; review the conversation.`);
  }
}

export function cancelSharedReply(repository: WorkItemRepository, messageId: string) {
  const message = repository.getSharedMessageById(messageId);
  if (!message || (message.status !== 'running' && message.status !== 'queued')) return null;
  if (message.status === 'queued') {
    repository.updateSharedMessage(messageId, { status: 'canceled' });
    return { ...message, status: 'canceled' as const };
  }
  activeReplies.get(messageId)?.abort();
  repository.updateSharedMessage(messageId, { status: 'canceled' });
  const runId = replyRunIds.get(messageId) ?? repository.getRunByMessage(messageId)?.id;
  if (runId) repository.updateRun(runId, { status: 'canceled', completedAt: new Date().toISOString() });
  const dispatched = dispatchNextSharedTurn(repository, message.conversationId);
  if (!dispatched.length) settleLinkedTask(repository, message.conversationId, 'Agent conversation was canceled; review or redirect the task.');
  return { ...message, status: 'canceled' as const };
}

export function interjectQueuedSharedMessage(repository: WorkItemRepository, messageId: string): SharedMessage[] | null {
  const message = repository.getSharedMessageById(messageId);
  if (!message || message.status !== 'queued') return null;
  const targetAgents = message.dispatchTarget === 'both' ? ['codex', 'claude'] as const
    : message.dispatchTarget === 'auto' ? ['codex', 'claude'] as const
    : message.dispatchTarget === 'none' ? [] : [message.dispatchTarget];
  const running = repository.listAllSharedMessages(message.conversationId)
    .filter((item) => item.status === 'running' && targetAgents.includes(item.author as AgentRun['agent']));
  // Do not call cancelSharedReply here: it dispatches the next queued message
  // after each cancellation, which can let an older turn win before this one
  // is promoted. Steering must make this exact message the next dispatch.
  for (const runningMessage of running) {
    activeReplies.get(runningMessage.id)?.abort();
    repository.updateSharedMessage(runningMessage.id, { status: 'canceled' });
    const runId = replyRunIds.get(runningMessage.id) ?? repository.getRunByMessage(runningMessage.id)?.id;
    if (runId) repository.updateRun(runId, { status: 'canceled', completedAt: new Date().toISOString() });
  }
  repository.promoteQueuedSharedMessage(messageId);
  return dispatchNextSharedTurn(repository, message.conversationId);
}

function synthesisSource(repository: WorkItemRepository, conversationId: string, replyCreatedAt: string): { prompt: string; codex: SharedMessage; claude: SharedMessage } | null {
  const messages = repository.listAllSharedMessages(conversationId);
  const request = [...messages].reverse().find((message) => message.author === 'jeffrey' && message.dispatchTarget === 'both' && message.createdAt <= replyCreatedAt);
  if (!request) return null;
  const replies = messages.filter((message) => message.createdAt >= request.createdAt && (message.author === 'codex' || message.author === 'claude'));
  const codex = [...replies].reverse().find((message) => message.author === 'codex');
  const claude = [...replies].reverse().find((message) => message.author === 'claude');
  if (!codex || !claude || codex.status !== 'completed' || claude.status !== 'completed') return null;
  const alreadySynthesized = messages.some((message) => message.author === 'system' && message.createdAt >= request.createdAt && message.body.startsWith('Synthesis:'));
  if (alreadySynthesized) return null;
  return {
    codex, claude,
    prompt: `Synthesize these two independent agent responses to Jeffrey's request. Lead with the practical conclusion. Reconcile disagreements, retain concrete evidence, and say which points remain unverified. Do not mention that you are a synthesizer or repeat both reports. Keep it concise.\n\nJeffrey: ${request.body}\n\nCodex:\n${codex.body}\n\nClaude:\n${claude.body}`,
  };
}

async function synthesizeSharedTurn(repository: WorkItemRepository, conversationId: string, replyCreatedAt: string): Promise<boolean> {
  const source = synthesisSource(repository, conversationId, replyCreatedAt);
  if (!source) return false;
  const message = repository.createSharedMessage('system', 'Synthesis: combining Codex and Claude…', 'running', conversationId);
  const agent = repository.selectBalancedAgent('claude');
  const profile = selectPromptExecutionProfile(source.prompt);
  repository.updateSharedMessage(message.id, { model: modelFor(agent, profile), executionProfile: profile });
  await runSharedBackgroundJob(repository, message.id, async (signal, onProgress) => {
    const result = await runAgentCommandWithFallback(agent, process.cwd(), source.prompt, onProgress, signal, undefined, profile, (usage) => {
      repository.updateSharedMessage(message.id, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd });
    });
    repository.updateSharedMessage(message.id, {
      model: modelFor(result.agent, profile), inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.usage.estimatedCostUsd, fallbackFrom: result.fallbackFrom, fallbackReason: result.fallbackReason,
    });
    return `Synthesis:\n${result.output}`;
  });
  return true;
}
