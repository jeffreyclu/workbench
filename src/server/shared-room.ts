import { DEFAULT_ACCOUNT_PROFILE, defaultAccountProfileForTask, type AgentRun, type SharedMessage, type WorkItem } from '../shared/contracts.js';
import { buildPrompt, claudeScopeRecoveryPrompt, classifyExecution, hasUnsupportedClaudeScopeClaim, judgeExecutionProfile, modelFor, resolveAgents, resolveWorkingDirectory, runAgentCommandWithFallback, selectPromptExecutionProfile } from './agent-runner.js';
import { WorkItemRepository } from './repository.js';
import { contextForPrompt } from './connection-broker.js';
import { HEARTBEAT_MS, OWNER_ID, LEASE_MS } from './scheduler.js';
import { publishRealtimeEvent, publishRealtimeNotification } from './realtime.js';

const activeReplies = new Map<string, AbortController>();
const replyRunIds = new Map<string, string>();
export const isSharedReplyActive = (id: string) => activeReplies.has(id);

function connectionSearchQuery(message: string): string {
  return message.replace(/https?:\/\/\S+/g, ' ').replace(/\b(?:linear|search|find|look|show|check|issues?|tasks?|tickets?|for|in|on|the|a|an|me|please)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

export const connectionContextForPrompt = contextForPrompt;

/**
 * Workbench has no durable handle for a process an agent detaches from its CLI.
 * Treat a promise to report after this response as a protocol violation, rather
 * than falsely marking the conversation finished while that untracked work runs.
 */
export function hasUntrackedContinuationClaim(output: string): boolean {
  return /\b(?:i['’]ll|i will|will)\s+report\b[\s\S]{0,180}\b(?:when|once|after|the moment)\b[\s\S]{0,100}\b(?:finish(?:es|ed)?|complete(?:s|d)?|land(?:s|ed)?)\b/i.test(output)
    || /\b(?:background|detached)\b[\s\S]{0,100}\b(?:run|process|job|bench|monitor)\b/i.test(output)
    || /\b(?:run|bench|monitor)\b[\s\S]{0,100}\b(?:in progress|still running)\b[\s\S]{0,160}\b(?:i['’]ll|i will|will)\s+report\b/i.test(output)
    // Claude's actual bad completion was: "Waiting for the background probe to
    // complete before continuing analysis." It omitted both "run" and "report",
    // so the narrower rules above let Workbench falsely close the turn.
    || /\b(?:waiting|wait|continue|continuing|resume|resuming)\b[\s\S]{0,180}\b(?:background|detached|subagent|child\s+agent)\b/i.test(output)
    || /\b(?:background|detached)\s+(?:run|process|job|bench|monitor|probe)\b/i.test(output)
    || /\b(?:subagent|child\s+agent)\b[\s\S]{0,180}\b(?:still\s+running|in\s+progress|finish(?:es|ed)?|complete(?:s|d)?|report)\b/i.test(output);
}

export function classificationForLinkedItem(repository: WorkItemRepository, item: WorkItem) {
  return repository.getClassification(item.id) ?? repository.setClassification(item.id, classifyExecution(item));
}

/** Linked conversations inherit their task workspace rather than the Workbench server cwd. */
export function resolveSharedReplyWorkingDirectory(linkedItem: WorkItem | null): string {
  return linkedItem ? resolveWorkingDirectory(linkedItem) : process.cwd();
}

/** An explicit room choice wins; otherwise retain the project-scoped default. */
export function accountProfileForSharedReply(linkedItem: WorkItem | null, requestedProfile?: string | null): string {
  return requestedProfile?.trim() || (linkedItem ? defaultAccountProfileForTask(linkedItem) : DEFAULT_ACCOUNT_PROFILE);
}

export function compactConversationHistory(messages: SharedMessage[], budget = 3_000): string {
  const reserveForOlder = messages.length > 4 ? Math.min(900, Math.floor(budget * 0.15)) : 0;
  let remaining = Math.max(0, budget - reserveForOlder);
  const recent: string[] = [];
  let firstIncluded = messages.length;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    const attachmentText = message.attachments.length ? `\nAttached files:\n${message.attachments.map((file) => `- ${file.name}: ${file.path}`).join('\n')}` : '';
    const prefix = `${message.author}: `;
    const bodyBudget = Math.min(700, Math.max(0, remaining - prefix.length - attachmentText.length - 2));
    if (bodyBudget < 80) break;
    recent.push(`${prefix}${message.body.slice(0, bodyBudget)}${attachmentText}`);
    remaining -= recent[recent.length - 1].length + 2;
    firstIncluded = index;
  }
  recent.reverse();
  const older = messages.slice(0, firstIncluded);
  const olderHeader = older.length ? `Earlier conversation (${older.length} messages, compacted):\n` : '';
  const olderSummary = older.length ? older.slice(-4).map((message) => {
    const oneLine = message.body.replace(/\s+/g, ' ').trim();
    return `- ${message.author}: ${oneLine.slice(0, 140)}${oneLine.length > 140 ? '…' : ''}`;
  }).join('\n').slice(0, Math.max(0, reserveForOlder - olderHeader.length - 2)) : '';
  return [olderSummary ? `${olderHeader}${olderSummary}` : '', recent.join('\n\n')].filter(Boolean).join('\n\n');
}

/** Keep current handoff state cheap; the full historical record arrives through retrieval. */
export function compactSharedBrief(sharedContext: string, budget = 700): string {
  if (sharedContext.length <= budget) return sharedContext;
  const head = Math.floor(budget * 0.65);
  const tail = Math.floor(budget * 0.25);
  const omitted = sharedContext.length - head - tail;
  return `${sharedContext.slice(0, head)}\n\n[… ${omitted.toLocaleString()} characters compacted; use retrieved memory for older detail …]\n\n${sharedContext.slice(-tail)}`;
}

function formatRetrievedMemory(matches: Array<{ source: string; title: string; body: string; createdAt: string }>): string {
  if (!matches.length) return 'Retrieved memory: no indexed match for the latest message. This does not mean nothing relevant exists — query /api/activity-memory directly with different terms before concluding history is silent on this.';
  const focused = matches.slice(0, 3);
  return `Retrieved memory (top ${focused.length} hybrid FTS+embedding matches for the latest message, pulled automatically from the same index that backs /api/activity-memory — durable docs, past messages, activities, and agent-run output together): do not re-derive facts these already settle.\n${focused.map((match) => `- [${match.source}, ${match.createdAt}] ${match.title}: ${match.body.slice(0, 200).replace(/\s+/g, ' ')}`).join('\n')}`;
}

export function buildSharedReplyPrompt(
  agent: AgentRun['agent'],
  sharedContext: string,
  connectionContext: string,
  thread: SharedMessage[],
  linked?: { item: WorkItem; run: AgentRun },
  retrievedMemory?: Array<{ source: string; title: string; body: string; createdAt: string }>,
): string {
  const roleContext = linked
    ? buildPrompt(linked.item, linked.run, sharedContext)
    : `You are ${agent}, participating in Jeffrey's shared Workbench room with Jeffrey, Codex, and Claude.\n\n${compactSharedBrief(sharedContext)}`;
  return `${roleContext}

${connectionContext}

${formatRetrievedMemory(retrievedMemory ?? [])}

Current conversation:
${compactConversationHistory(thread)}

Respond directly to Jeffrey's latest message. Be concise and useful. Build on the shared context, but do not impersonate or wait for the other agent. Start by naming the relevant decision, handoff, or blocker from the structured shared brief that you are continuing; if it conflicts with observed state, say so before acting. The retrieved-memory block above is auto-pulled from the full durable Workbench history (docs, messages, activities, run output) for the latest message only — if you need a different angle, query it yourself: curl -sG http://localhost:5180/api/activity-memory --data-urlencode 'q=<focused terms>' --data 'limit=40'. Append anything durable you learn (a standing preference or correction) to the right docs/shared-memory/*.md topic file in the same turn instead of writing a private per-agent memory; consult docs/shared-memory.md's index only if the retrieved block didn't surface the topic you need to update. This is a non-interactive environment: use tools directly and never tell Jeffrey to grant a permission, approve a terminal prompt, or look at a dialog. If access is missing, name the exact unavailable integration or credential. Never launch detached/background work (including &, nohup, tmux, screen, or a subagent you will report on later): Workbench cannot track it after this CLI turn exits. Keep every command and delegated action foreground until its observed result is available, then report it in this response. If that is not possible, state that the work is blocked or incomplete.`;
}

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
  const conversation = repository.listConversations().find((item) => item.id === conversationId);
  const linkedItem = conversation?.workItemId ? repository.get(conversation.workItemId) : null;
  // A linked task may predate classification. Use its deterministic routing
  // instead of treating every chat instruction as generic analysis, and persist
  // it so later execute/retry paths use the same capability.
  const classification = linkedItem ? classificationForLinkedItem(repository, linkedItem) : null;
  const taskKind = classification?.kind ?? 'analysis';
  const resolvedAgents = resolveAgents(taskKind, queued.dispatchTarget);
  const agents = queued.dispatchTarget === 'auto'
    ? [repository.selectBalancedAgent(resolvedAgents[0])]
    : resolvedAgents;
  if (linkedItem && !linkedItem.archivedAt && linkedItem.status !== 'done' && linkedItem.status !== 'canceled') {
    repository.update(linkedItem.id, { status: 'in_progress' }, false, { actor: 'jeffrey', source: 'shared_room' });
    const attachmentText = queued.message.attachments.length ? ` · ${queued.message.attachments.length} attachment${queued.message.attachments.length === 1 ? '' : 's'}` : '';
    repository.addActivity(linkedItem.id, 'jeffrey', 'chat_started', `To ${agents.join(' and ')}${attachmentText}: ${queued.message.body.trim() || '(attachment-only message)'}`);
  }
  const accountProfile = accountProfileForSharedReply(linkedItem, queued.message.accountProfile);
  const replies = agents.map((agent) => repository.createSharedMessage(agent, '', 'running', conversationId, [], 'none', queued.message.executionProfile === 'routing' ? null : queued.message.executionProfile, accountProfile));
  for (const reply of replies) {
    const agent = reply.author as AgentRun['agent'];
    const run = linkedItem && !linkedItem.archivedAt && linkedItem.status !== 'done' && linkedItem.status !== 'canceled'
      ? repository.createRun(linkedItem.id, taskKind, queued.dispatchTarget, agent, queued.message.body, conversationId, reply.id, 'manual', accountProfile)
      : null;
    void replyInSharedRoom(repository, agent, reply.id, run?.id);
  }
  return replies;
}

function settleLinkedTask(repository: WorkItemRepository, conversationId: string, reason: string): void {
  if (repository.listAllSharedMessages(conversationId).some((message) => message.status === 'queued' || message.status === 'running')) return;
  const conversation = repository.listConversations().find((item) => item.id === conversationId);
  if (!conversation?.workItemId) return;
  const item = repository.get(conversation.workItemId);
  if (!item || item.archivedAt || item.status !== 'in_progress') return;
  repository.update(item.id, { status: 'ready' }, false, { actor: 'system', source: 'shared_room' });
  repository.moveForAttention(item.id, 'top', reason);
  repository.addActivity(item.id, 'system', 'chat_completed', reason);
}

export async function runSharedBackgroundJob(
  repository: WorkItemRepository,
  messageId: string,
  job: (signal: AbortSignal, onProgress: (body: string) => void) => Promise<string>,
  options: { claimQueuedPromotion?: boolean } = {},
): Promise<void> {
  const target = repository.getSharedMessageById(messageId);
  // Claim a lease so the scheduler knows this process is actively working on this message.
  const claimed = options.claimQueuedPromotion
    ? repository.claimQueuedPromotionMessage(messageId, OWNER_ID, LEASE_MS)
    : repository.claimSharedMessage(messageId, OWNER_ID, LEASE_MS);
  if (!claimed) return;
  const leaseHeartbeat = setInterval(() => repository.renewSharedMessageLease(messageId, OWNER_ID, LEASE_MS), HEARTBEAT_MS);
  leaseHeartbeat.unref();

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
    clearInterval(leaseHeartbeat);
    activeReplies.delete(messageId);
    if (target) settleLinkedTask(repository, target.conversationId, 'Agent work finished; review the conversation.');
    if (target) {
      const completed = repository.getSharedMessageById(messageId);
      publishRealtimeEvent('shared', 'work-items', 'insights');
      publishRealtimeNotification(completed?.status === 'completed'
        ? { tone: 'success', message: 'Agent finished', description: target.body.slice(0, 180), duration: 8_000, action: { label: 'Open conversation', route: `/conversations/${target.conversationId}` } }
        : { tone: 'error', message: 'Agent needs your attention', description: target.body.slice(0, 180), duration: 0, action: { label: 'Open conversation', route: `/conversations/${target.conversationId}` } });
    }
  }
}

export async function replyInSharedRoom(repository: WorkItemRepository, agent: AgentRun['agent'], messageId: string, runId?: string): Promise<void> {
  const target = repository.getSharedMessageById(messageId);
  if (!target) return;

  // Claim a lease so the scheduler knows this process is actively working on this message.
  // On restart, expired leases trigger recovery (mark failed for messages without runs).
  if (!repository.claimSharedMessage(messageId, OWNER_ID, LEASE_MS)) return;
  if (runId && !repository.claimRun(runId, OWNER_ID, LEASE_MS)) {
    repository.updateSharedMessage(messageId, { status: 'failed', error: 'Could not claim the linked agent run.' });
    return;
  }
  const leaseHeartbeat = setInterval(() => {
    repository.renewSharedMessageLease(messageId, OWNER_ID, LEASE_MS);
    if (runId) repository.renewRunLease(runId, OWNER_ID, LEASE_MS);
  }, HEARTBEAT_MS);
  leaseHeartbeat.unref();

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
    const linkedRun = runId ? repository.getRun(runId) : null;
    const linkedItem = linkedRun ? repository.get(linkedRun.workItemId) : null;
    const cwd = resolveSharedReplyWorkingDirectory(linkedItem);
    if (linkedItem) repository.addActivity(linkedItem.id, 'system', 'progress', `Conversation workspace resolved to ${cwd}.`);
    const retrievedMemory = await repository.searchActivityMemory(latestUserMessage, 6).catch((error) => {
      console.error('[shared-room] memory retrieval failed for prompt injection', error);
      return [];
    });
    const prompt = buildSharedReplyPrompt(
      agent,
      repository.getSharedContext(target.conversationId, { conversationId: target.conversationId }),
      connectionContext,
      thread,
      linkedRun && linkedItem ? { item: linkedItem, run: linkedRun } : undefined,
      retrievedMemory,
    );
    repository.updateSharedMessage(messageId, { model: modelFor('codex', 'economy'), executionProfile: 'routing' });
    const guardedPrompt = prompt;
    const profile = target.executionProfile && target.executionProfile !== 'routing'
      ? target.executionProfile
      : await judgeExecutionProfile(latestUserMessage || guardedPrompt, cwd, controller.signal);
    repository.updateSharedMessage(messageId, { model: modelFor(agent, profile), executionProfile: profile });
    if (runId) repository.updateRun(runId, { model: modelFor(agent, profile), executionProfile: profile });
    repository.setConversationExecutionProfile(target.conversationId, profile);
    let result = await runAgentCommandWithFallback(agent, cwd, agent === 'claude' ? claudeScopeRecoveryPrompt(guardedPrompt, cwd) : guardedPrompt, (partial) => {
      repository.updateSharedMessage(messageId, { body: partial });
      if (runId) repository.updateRun(runId, { output: partial });
    }, controller.signal, (fallback, reason) => {
      repository.updateSharedMessage(messageId, { author: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: agent, fallbackReason: reason.slice(0, 500) });
      if (runId) repository.updateRun(runId, { agent: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: agent, fallbackReason: reason.slice(0, 500) });
    }, profile, (usage) => {
      const telemetry = { inputTokens: usage.inputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd, costSource: usage.costSource };
      repository.updateSharedMessage(messageId, telemetry);
      if (runId) repository.updateRun(runId, telemetry);
    }, undefined, runId ? repository.getRun(runId)?.kind ?? 'analysis' : 'analysis', target.accountProfile ?? DEFAULT_ACCOUNT_PROFILE);
    if (result.agent === 'claude' && hasUnsupportedClaudeScopeClaim(result.output)) {
      const reason = 'Claude reported a sandbox or read-only scope despite this fresh bypass-permission invocation; Workbench handed the turn to Codex.';
      if (linkedItem) repository.addActivity(linkedItem.id, 'system', 'agent_fallback', reason);
      repository.updateSharedMessage(messageId, { body: '● Claude reported an invalid workspace-scope blocker. Handing this tracked turn to Codex…', fallbackFrom: 'claude', fallbackReason: reason });
      const recovered = await runAgentCommandWithFallback('codex', cwd, `${guardedPrompt}\n\nRecovery handoff: Claude incorrectly claimed it lacked workspace access. Complete the original request directly. Do not repeat that claim; report only observed commands, files changed, verification, and concrete blockers.`, (partial) => {
        repository.updateSharedMessage(messageId, { body: partial });
        if (runId) repository.updateRun(runId, { output: partial });
      }, controller.signal, undefined, profile, (usage) => {
        const telemetry = { inputTokens: usage.inputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd, costSource: usage.costSource };
        repository.updateSharedMessage(messageId, telemetry);
        if (runId) repository.updateRun(runId, telemetry);
      }, undefined, runId ? repository.getRun(runId)?.kind ?? 'analysis' : 'analysis', target.accountProfile ?? DEFAULT_ACCOUNT_PROFILE);
      result = { ...recovered, fallbackFrom: 'claude', fallbackReason: reason };
      repository.updateSharedMessage(messageId, { author: result.agent, model: modelFor(result.agent, profile), fallbackFrom: 'claude', fallbackReason: reason });
      if (runId) repository.updateRun(runId, { agent: result.agent, model: modelFor(result.agent, profile), fallbackFrom: 'claude', fallbackReason: reason });
    }
    const telemetry = { inputTokens: result.usage.inputTokens, cacheCreationInputTokens: result.usage.cacheCreationInputTokens, cacheReadInputTokens: result.usage.cacheReadInputTokens, outputTokens: result.usage.outputTokens, estimatedCostUsd: result.usage.estimatedCostUsd, costSource: result.usage.costSource, fallbackFrom: result.fallbackFrom, fallbackReason: result.fallbackReason };
    if (hasUntrackedContinuationClaim(result.output)) {
      const error = 'Agent claimed background or later-reported work. Workbench cannot track detached actions; the response was not marked finished.';
      repository.updateSharedMessage(messageId, { author: result.agent, body: result.output, status: 'failed', error, ...telemetry });
      if (runId) repository.updateRun(runId, { agent: result.agent, output: result.output, status: 'failed', error, completedAt: new Date().toISOString(), ...telemetry });
      if (linkedItem) repository.addActivity(linkedItem.id, 'system', 'blocker', error);
      return;
    }
    repository.updateSharedMessage(messageId, { author: result.agent, body: result.output, status: 'completed', ...telemetry });
    repository.recordAgentHandoff(target.conversationId, messageId, result.agent, result.output);
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
    clearInterval(leaseHeartbeat);
    activeReplies.delete(messageId);
    replyRunIds.delete(messageId);
    const synthesized = await synthesizeSharedTurn(repository, target.conversationId, target.createdAt);
    const dispatched = dispatchNextSharedTurn(repository, target.conversationId);
    if (!synthesized && !dispatched.length) settleLinkedTask(repository, target.conversationId, `${agent} finished responding; review the conversation.`);
    if (!synthesized && !dispatched.length) {
      const completed = repository.getSharedMessageById(messageId);
      publishRealtimeEvent('shared', 'work-items', 'insights');
      publishRealtimeNotification(completed?.status === 'completed'
        ? { tone: 'success', message: 'Agent finished', description: target.body.slice(0, 180), duration: 8_000, action: { label: 'Open conversation', route: `/conversations/${target.conversationId}` } }
        : { tone: 'error', message: 'Agent needs your attention', description: target.body.slice(0, 180), duration: 0, action: { label: 'Open conversation', route: `/conversations/${target.conversationId}` } });
    }
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
  const requestedAgentFor = (message: SharedMessage) => repository.getRunByMessage(message.id)?.requestedAgent ?? message.author;
  const codex = [...replies].reverse().find((message) => requestedAgentFor(message) === 'codex');
  const claude = [...replies].reverse().find((message) => requestedAgentFor(message) === 'claude');
  if (!codex || !claude || codex.status !== 'completed' || claude.status !== 'completed') return null;
  const alreadySynthesized = messages.some((message) => message.author === 'system' && message.createdAt >= request.createdAt && message.body.startsWith('Synthesis:'));
  if (alreadySynthesized) return null;
  return {
    codex, claude,
    prompt: `Synthesize these two independent agent responses to Jeffrey's request. Lead with the practical conclusion. Reconcile disagreements, retain concrete evidence, and say which points remain unverified. Do not mention that you are a synthesizer or repeat both reports. Keep it concise.\n\nJeffrey: ${request.body}\n\nCodex-requested response (executed by ${codex.author}):\n${codex.body}\n\nClaude-requested response (executed by ${claude.author}):\n${claude.body}`,
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
      repository.updateSharedMessage(message.id, { inputTokens: usage.inputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd, costSource: usage.costSource });
    });
    repository.updateSharedMessage(message.id, {
      model: modelFor(result.agent, profile), inputTokens: result.usage.inputTokens, cacheCreationInputTokens: result.usage.cacheCreationInputTokens, cacheReadInputTokens: result.usage.cacheReadInputTokens, outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.usage.estimatedCostUsd, costSource: result.usage.costSource, fallbackFrom: result.fallbackFrom, fallbackReason: result.fallbackReason,
    });
    return `Synthesis:\n${result.output}`;
  });
  const completed = repository.getSharedMessageById(message.id);
  if (completed?.status === 'completed') repository.recordAgentHandoff(conversationId, message.id, 'system', completed.body);
  return true;
}
