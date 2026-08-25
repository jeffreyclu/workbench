import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ACCOUNT_PROFILE, defaultAccountProfileForTask, type AgentRun, type SharedMessage, type WorkItem } from '../shared/contracts.js';
import { projectKey } from '../shared/project-name.js';
import { buildPrompt, cancelAgentRun, claudeScopeRecoveryPrompt, classifyExecution, hasUnsupportedClaudeScopeClaim, judgeExecutionProfile, modelFor, PROMPT_MEMORY_CANDIDATE_LIMIT, resolveAgents, resolveWorkingDirectory, runAgentCommandWithFallback, selectPromptExecutionProfile, selectRelevantMemoryForPrompt, type AgentInputSteering, type RetrievedMemory } from './agent-runner.js';
import { WorkItemRepository } from './repository.js';
import { contextForPrompt } from './connection-broker.js';
import { HEARTBEAT_MS, OWNER_ID, LEASE_MS } from './scheduler.js';
import { publishRealtimeEvent, publishRealtimeNotification } from './realtime.js';
import { humanizeRunOutputBlocks } from '../shared/run-output.js';

const activeReplies = new Map<string, AbortController>();
const replyRunIds = new Map<string, string>();
/**
 * A live provider session owns this callback for the life of its reply.  An
 * interjection is input to that session, never a second reply/run.
 */
type ActiveReplySteering = AgentInputSteering;
const activeReplySteering = new Map<string, ActiveReplySteering>();
export const isSharedReplyActive = (id: string) => activeReplies.has(id);

/** Associates a running reply with its provider's live input channel. */
export function registerActiveReplySteering(messageId: string, steer: ActiveReplySteering): void {
  activeReplySteering.set(messageId, steer);
}

/** Gives an active provider an unambiguous instruction to react in this turn. */
export function interjectionSteeringPrompt(body: string): string {
  return `The user is interjecting into your active response. Acknowledge and apply this direction immediately; do not wait for a later turn or start a separate response:\n\n${body}`;
}

export function agentStreamEventForCodexAppServerItem(method: string, item: Record<string, unknown> | undefined): { kind: 'decision' | 'tool'; detail: string } | null {
  if (!item) return null;
  const type = String(item.type ?? '');
  if (method === 'item/started' && (type === 'commandExecution' || type === 'command_execution')) {
    return { kind: 'tool', detail: `command_execution: ${String(item.command ?? 'command').slice(0, 500)}` };
  }
  if (method === 'item/completed' && type === 'reasoning') {
    // App-server emits the requested reasoning summary as `summary[]`, while
    // older versions exposed it directly as `text`. Both are provider-recorded
    // summaries; encrypted reasoning is intentionally never surfaced here.
    const summary = typeof item.text === 'string' ? item.text : Array.isArray(item.summary)
      ? item.summary.flatMap((part) => {
        if (typeof part === 'string') return [part];
        if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') return [(part as Record<string, unknown>).text as string];
        return [];
      }).join('\n').trim()
      : '';
    if (summary) return { kind: 'decision', detail: summary.slice(0, 2_000) };
  }
  if (method === 'item/completed' && (type === 'agentMessage' || type === 'agent_message') && typeof item.text === 'string') {
    // The shared-room prompt requires a visible Decision: preamble before each
    // tool call. Preserve only that explicit, agent-authored record; regular
    // response text is not a decision and must not become fabricated context.
    const decision = item.text.match(/^\s*Decision:\s*([^\n]+)\s*$/i)?.[1]?.trim();
    if (decision) return { kind: 'decision', detail: decision.slice(0, 2_000) };
  }
  return null;
}

/** App-server sends debugger-only decision preambles as ordinary text deltas. */
export function isCodexDecisionPreamble(text: string): boolean {
  return /^\s*Decision:\s*/i.test(text);
}

/** The completed reply is authored answer text; the live feed also includes decisions. */
export function codexFinalReply(itemTexts: Iterable<string>): string {
  return Array.from(itemTexts)
    .filter((text) => !isCodexDecisionPreamble(text))
    .join('\n\n')
    .trim();
}

export function codexTurnStartParams(threadId: string, cwd: string, prompt: string): Record<string, unknown> {
  return {
    threadId,
    cwd,
    effort: 'medium',
    // The debugger needs a provider-authored, human-readable decision record.
    // `concise` provides that without exposing encrypted chain-of-thought.
    summary: 'concise',
    input: [{ type: 'text', text: prompt, text_elements: [] }],
  };
}

/** Codex's app-server is the provider protocol that supports turn/steer. */
function runSteerableCodex(prompt: string, cwd: string, signal: AbortSignal, onProgress: (body: string) => void, onReady: (steer: ActiveReplySteering) => void, onEvent: (event: { kind: 'decision' | 'tool' | 'file_read' | 'file_write'; detail: string }) => void): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let buffered = ''; let output = ''; let liveOutput = ''; let threadId = ''; let turnId = ''; let sequence = 0; let settled = false;
    const pendingSteers = new Map<number, (accepted: boolean) => void>();
    // A steered turn emits a separate `agentMessage` item per exchange (the
    // pre-interjection reply, then the reply to the steer). Deltas carry an
    // `itemId`; concatenating them flat without an item boundary runs the two
    // messages together, which reads as garbled/broken even though the steer
    // landed correctly in the same turn.
    const itemOrder: string[] = [];
    const itemText = new Map<string, string>();
    const liveBlocks: string[] = [];
    const publishLiveOutput = () => {
      // The debugger contract requires a literal "Decision: " preamble in the
      // model's own text so the audit trail can capture it, but the live feed
      // is user-facing prose, not an audit log — strip the label there.
      const messageBlocks = itemOrder.map((id) => (itemText.get(id) ?? '').replace(/^\s*Decision:\s*/i, ''));
      liveOutput = [...liveBlocks, ...messageBlocks].filter(Boolean).join('\n\n');
      onProgress(liveOutput);
    };
    const appendLiveEvent = (detail: string) => {
      if (!detail || liveBlocks.at(-1) === detail) return;
      liveBlocks.push(detail);
      publishLiveOutput();
    };
    const request = (method: string, params: Record<string, unknown>) => {
      const id = ++sequence;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return id;
    };
    const rejectPendingSteers = () => {
      for (const resolveSteer of pendingSteers.values()) resolveSteer(false);
      pendingSteers.clear();
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        rejectPendingSteers();
        reject(error);
      }
    };
    const stop = () => { try { process.kill(child.pid ? -child.pid : child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); } };
    const steer: ActiveReplySteering = (body) => {
      if (!threadId || !turnId || settled) return Promise.resolve(false);
      return new Promise((resolveSteer) => {
        // `turn/steer` is delivered into the agent's current context, not as a
        // separate response. Make the immediate, in-place behavior explicit.
        const id = request('turn/steer', { threadId, expectedTurnId: turnId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: interjectionSteeringPrompt(body), text_elements: [] }] });
        pendingSteers.set(id, resolveSteer);
      });
    };
    signal.addEventListener('abort', stop, { once: true });
    child.on('error', fail);
    child.stderr.on('data', (chunk: Buffer) => { if (!settled && chunk.toString().trim()) { /* diagnostics arrive on close */ } });
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString(); const lines = buffered.split('\n'); buffered = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        let event: any; try { event = JSON.parse(line); } catch { continue; }
        if (event.id === 1 && event.result) request('thread/start', { cwd, ephemeral: true, model: null, approvalPolicy: 'never' });
        else if (event.result?.thread?.id && !threadId) { threadId = event.result.thread.id; request('turn/start', codexTurnStartParams(threadId, cwd, prompt)); }
        else if (event.result?.turn?.id && !turnId) { turnId = event.result.turn.id; onReady(steer); }
        if (typeof event.id === 'number' && pendingSteers.has(event.id)) {
          const resolveSteer = pendingSteers.get(event.id)!;
          pendingSteers.delete(event.id);
          if (event.result?.turnId) {
            turnId = event.result.turnId;
            resolveSteer(true);
          } else {
            resolveSteer(false);
          }
          // A rejected steer leaves the human message queued. The active turn
          // keeps streaming and no second reply is started.
          continue;
        }
        if (event.method === 'item/agentMessage/delta' && typeof event.params?.delta === 'string') {
          const itemId = typeof event.params?.itemId === 'string' ? event.params.itemId : null;
          if (itemId) {
            if (!itemText.has(itemId)) itemOrder.push(itemId);
            itemText.set(itemId, `${itemText.get(itemId) ?? ''}${event.params.delta}`);
            output = codexFinalReply(itemOrder.map((id) => itemText.get(id) ?? ''));
          } else {
            const next = `${output}${event.params.delta}`;
            output = isCodexDecisionPreamble(next) ? '' : next;
            if (event.params.delta) {
              const fallbackItemId = '__unidentified-agent-message__';
              if (!itemText.has(fallbackItemId)) itemOrder.push(fallbackItemId);
              itemText.set(fallbackItemId, `${itemText.get(fallbackItemId) ?? ''}${event.params.delta}`);
            }
          }
          publishLiveOutput();
        }
        const item = event.params?.item as Record<string, unknown> | undefined;
        // Reasoning items begin before their summary text is available. Capture
        // the completed item so each subsequent tool call has the actual
        // decision that preceded it rather than an empty placeholder.
        const agentEvent = agentStreamEventForCodexAppServerItem(event.method, item);
        if (agentEvent) {
          onEvent(agentEvent);
          // The debugger is an audit trail, not the only place the user gets
          // to see work in progress. Keep provider-recorded decisions and
          // tool starts in the running activity feed too.
          // Agent-message decisions already arrive in delta form. Reasoning
          // summaries and tool starts do not, so surface those explicitly.
          const itemType = String(item?.type ?? '');
          if (itemType === 'reasoning' || agentEvent.kind === 'tool') {
            appendLiveEvent(agentEvent.kind === 'tool' ? `● ${agentEvent.detail}` : agentEvent.detail);
          }
        }
        if (event.method === 'turn/completed') {
          settled = true;
          rejectPendingSteers();
          resolveOutput(output.trim());
          child.stdin.end();
        }
        if (event.error) {
          if (typeof event.id === 'number' && pendingSteers.has(event.id)) {
            pendingSteers.get(event.id)!(false);
            pendingSteers.delete(event.id);
          } else fail(new Error(String(event.error.message ?? 'Codex app-server request failed.')));
        }
      }
    });
    child.on('close', (code) => { if (!settled) fail(signal.aborted ? new Error('Agent run canceled.') : new Error(`Codex app-server exited with code ${code}.`)); });
    request('initialize', { clientInfo: { name: 'workbench', title: 'Workbench', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  });
}

type SharedReplyRetrieval = {
  query: string;
  matches: Promise<RetrievedMemory[]>;
};

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

export function compactConversationHistory(messages: SharedMessage[], budget = 1_500): string {
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
  const olderSummary = older.length ? older.slice(-8).map((message) => `- ${message.author}: ${compactKeyPoints(message.body, 140)}`).join('\n').slice(0, Math.max(0, reserveForOlder - olderHeader.length - 2)) : '';
  return [olderSummary ? `${olderHeader}${olderSummary}` : '', recent.join('\n\n')].filter(Boolean).join('\n\n');
}

/** Extractive summary: preserve decisions/evidence before generic prose. */
export function compactKeyPoints(text: string, budget: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= budget) return normalized;
  const candidates = text.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const keyLines = candidates.filter((line) => /\b(?:decid\w*|decis\w*|must|should|will |do not|don't|blocked|blocker|failed|error|verified|test(?:ed|s)?|passed|changed|fixed)\b/i.test(line));
  const unique = [...new Set([...keyLines, ...candidates.slice(-3)])];
  const summary = unique.join(' · ');
  if (summary && summary.length <= budget) return summary;
  // A recognised decision or blocker is more valuable than the surrounding
  // prose. Keep it even when the newest raw lines would otherwise consume the
  // whole compacted section.
  if (keyLines.length) {
    const kept: string[] = [];
    let remaining = budget;
    for (const line of unique) {
      const separator = kept.length ? 3 : 0;
      if (remaining <= separator + 20) break;
      const compacted = line.length + separator <= remaining ? line : `${line.slice(0, remaining - separator - 1)}…`;
      kept.push(compacted);
      remaining -= compacted.length + separator;
    }
    return kept.join(' · ');
  }
  const head = Math.floor((budget - 35) * 0.65);
  const tail = Math.max(0, budget - 35 - head);
  return `${normalized.slice(0, head)} [… key points compacted …] ${normalized.slice(-tail)}`;
}

/** Keep current handoff state cheap; the full historical record arrives through retrieval. */
export function compactSharedBrief(sharedContext: string, budget = 700): string {
  if (sharedContext.length <= budget) return sharedContext;
  const summary = compactKeyPoints(sharedContext, budget - 80);
  return `Key points from shared brief:\n${summary}\n\n[… ${Math.max(0, sharedContext.length - summary.length).toLocaleString()} characters compacted; use retrieved memory for older detail …]`;
}

/**
 * Keep every room turn grounded without turning retrieval into the dominant
 * prompt payload. The full index remains available through /api/activity-memory.
 */
function formatRetrievedMemory(matches: RetrievedMemory[]): string {
  if (!matches.length) return 'Retrieved memory: no indexed match. Query /api/activity-memory with focused terms if needed.';
  const focused = selectRelevantMemoryForPrompt(matches);
  if (!focused.length) return 'Retrieved memory: no match cleared this query’s relevance threshold.';
  return `Retrieved memory (${focused.length} relevant matches, selected from up to ${matches.length}; same index as /api/activity-memory — docs, messages, activities, run output). Settled; don't re-derive.\n${focused.map((match) => `- [${match.source}, ${match.createdAt}] ${match.title}: ${match.body.slice(0, 420).replace(/\s+/g, ' ')}`).join('\n')}`;
}

export function buildSharedReplyPrompt(
  agent: AgentRun['agent'],
  sharedContext: string,
  connectionContext: string,
  thread: SharedMessage[],
  linked?: { item: WorkItem; run: AgentRun },
  retrievedMemory?: RetrievedMemory[],
): string {
  const roleContext = linked
    ? buildPrompt(linked.item, linked.run, sharedContext)
    : `You are ${agent}, participating in Jeffrey's shared Workbench room with Jeffrey, Codex, and Claude.\n\n${compactSharedBrief(sharedContext)}`;
  return `${roleContext}

${connectionContext}

${formatRetrievedMemory(retrievedMemory ?? [])}

Current conversation:
${compactConversationHistory(thread)}

Answer Jeffrey concisely. State the decision, handoff, or blocker you are continuing and any conflict with observed state. Before each tool call, emit a separate, concise \`Decision: <why this tool is the next correct action>\` statement. It is recorded in the agent debugger, so make it concrete and human-readable; never claim hidden reasoning. Retrieved memory covers the latest message only; query more via curl -sG http://localhost:5180/api/activity-memory --data-urlencode 'q=<terms>' --data 'limit=100'. Record durable facts in docs/shared-memory/*.md, never private memory. Workbench is non-interactive: use tools directly and report exact missing access. Finish foreground work now; never detach work or promise a later result.`;
}

/**
 * A shorthand follow-up needs the preceding user turn to retrieve the right
 * decision. A complete new question does not: adding an unrelated control turn
 * (for example, "Approve the Workbench preview") dilutes its retrieval terms
 * and lets exact lexical noise outrank the requested memory.
 */
function isContextDependentFollowUp(message: string): boolean {
  const normalized = message.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  if (/^(?:yes|yeah|yep|no|nope|ok|okay|do it|go ahead|ship it|fix it|that works|sounds good)[.!?]*$/.test(normalized)) return true;
  if (/^(?:why|how|what|which|who|when|where)\??$/.test(normalized)) return true;
  return normalized.split(' ').length <= 8
    && /\b(?:it|that|this|those|these|them|there|same|again|previous|above)\b/.test(normalized);
}

/** A short, context-dependent follow-up needs the preceding user decision. */
export function memoryQueryForSharedReply(thread: SharedMessage[]): string {
  const userTurns = thread.filter((message) => message.author === 'jeffrey' && message.body.trim());
  const latest = userTurns.at(-1)?.body.trim() ?? '';
  if (!isContextDependentFollowUp(latest)) return latest.slice(0, 2_000);
  return userTurns.slice(-2).map((message) => message.body.trim()).join('\n').slice(0, 2_000);
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
  // Conversation turns are one-at-a-time per agent. Interject writes to the
  // active provider turn and never enters this dispatcher.
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
  // Both recipients of one human turn must see the exact same retrieval
  // snapshot. Starting independent refreshes lets the first recipient's
  // streamed output enter the index before the second searches, which can
  // crowd out the prior context the two agents were meant to share.
  const retrievalThread = repository.listSharedMessages(100, null, conversationId).messages;
  const retrievalQuery = memoryQueryForSharedReply(retrievalThread);
  const retrieval: SharedReplyRetrieval = {
    query: retrievalQuery,
    matches: repository.searchActivityMemory(retrievalQuery, PROMPT_MEMORY_CANDIDATE_LIMIT, {
      excludeExactBody: retrievalQuery,
      projectKey: linkedItem ? projectKey(linkedItem.projectName) || undefined : undefined,
    }).catch((error) => {
      console.error('[shared-room] memory retrieval failed for prompt injection', error);
      return [];
    }),
  };
  const replies = agents.map((agent) => repository.createSharedMessage(agent, '', 'running', conversationId, [], 'none', queued.message.executionProfile === 'routing' ? null : queued.message.executionProfile, accountProfile, queued.message.id));
  for (const reply of replies) {
    const agent = reply.author as AgentRun['agent'];
    const run = linkedItem && !linkedItem.archivedAt && linkedItem.status !== 'done' && linkedItem.status !== 'canceled'
      ? repository.createRun(linkedItem.id, taskKind, queued.dispatchTarget, agent, queued.message.body, conversationId, reply.id, 'manual', accountProfile)
      : null;
    void replyInSharedRoom(repository, agent, reply.id, run?.id, retrieval);
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

export async function replyInSharedRoom(repository: WorkItemRepository, agent: AgentRun['agent'], messageId: string, runId?: string, retrievalSnapshot?: SharedReplyRetrieval): Promise<void> {
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
    const memoryQuery = retrievalSnapshot?.query ?? memoryQueryForSharedReply(thread);
    const recentSourceReferences = thread.filter((message) => message.author === 'jeffrey' && /https?:\/\/(?:[^\s/]+\.)?(?:atlassian\.net|github\.com|slack\.com|linear\.app)\//i.test(message.body)).slice(-3).map((message) => message.body);
    const connectionContext = await connectionContextForPrompt(repository, [latestUserMessage, ...recentSourceReferences].join('\n'));
    const linkedRun = runId ? repository.getRun(runId) : null;
    const linkedConversation = repository.getConversation(target.conversationId);
    const linkedItem = linkedRun
      ? repository.get(linkedRun.workItemId)
      : linkedConversation?.workItemId ? repository.get(linkedConversation.workItemId) : null;
    const cwd = resolveSharedReplyWorkingDirectory(linkedItem);
    if (linkedItem) repository.addActivity(linkedItem.id, 'system', 'progress', `Conversation workspace resolved to ${cwd}.`);
    const retrievedMemory = await (retrievalSnapshot?.matches ?? repository.searchActivityMemory(memoryQuery, PROMPT_MEMORY_CANDIDATE_LIMIT, {
      excludeExactBody: memoryQuery,
      projectKey: linkedItem ? projectKey(linkedItem.projectName) || undefined : undefined,
    }).catch((error) => {
      console.error('[shared-room] memory retrieval failed for prompt injection', error);
      return [];
    }));
    const injectedMemory = selectRelevantMemoryForPrompt(retrievedMemory);
    repository.updateSharedMessage(messageId, {
      retrievedMemoryCount: injectedMemory.length,
      retrievedMemoryDetail: { query: memoryQuery, items: injectedMemory },
    });
    const prompt = buildSharedReplyPrompt(
      agent,
      repository.getSharedContext(target.conversationId, { conversationId: target.conversationId }),
      connectionContext,
      thread,
      linkedRun && linkedItem ? { item: linkedItem, run: linkedRun } : undefined,
      injectedMemory,
    );
    repository.updateSharedMessage(messageId, { model: modelFor('codex', 'economy'), executionProfile: 'routing' });
    const guardedPrompt = prompt;
    const profile = target.executionProfile && target.executionProfile !== 'routing'
      ? target.executionProfile
      : await judgeExecutionProfile(latestUserMessage || guardedPrompt, cwd, controller.signal);
    repository.updateSharedMessage(messageId, { model: modelFor(agent, profile), executionProfile: profile });
    if (runId) repository.updateRun(runId, { model: modelFor(agent, profile), executionProfile: profile });
    repository.setConversationExecutionProfile(target.conversationId, profile);
    let result = agent === 'codex'
      ? await runSteerableCodex(guardedPrompt, cwd, controller.signal, (partial) => {
        repository.updateSharedMessage(messageId, { body: partial });
        if (runId) repository.updateRun(runId, { output: partial });
      }, (steer) => {
        registerActiveReplySteering(messageId, steer);
        // A click can arrive while the app-server is still creating its turn.
        // Keep that explicitly promoted human message queued, then deliver it
        // as soon as the same live session exposes turn/steer.
        void deliverPendingSharedInterjections(repository, messageId);
      }, (event) => repository.addAgentStreamEvents(messageId, runId ?? null, [event]))
        .then((output) => ({ output, agent: 'codex' as const, usage: { inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null, estimatedCostUsd: null, costSource: null }, fallbackFrom: null, fallbackReason: null }))
      : await runAgentCommandWithFallback(agent, cwd, agent === 'claude' ? claudeScopeRecoveryPrompt(guardedPrompt, cwd) : guardedPrompt, (partial) => {
      repository.updateSharedMessage(messageId, { body: partial });
      if (runId) repository.updateRun(runId, { output: partial });
    }, controller.signal, (fallback, reason) => {
      repository.updateSharedMessage(messageId, { author: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: agent, fallbackReason: reason.slice(0, 500) });
      if (runId) repository.updateRun(runId, { agent: fallback, model: modelFor(fallback, profile), executionProfile: profile, fallbackFrom: agent, fallbackReason: reason.slice(0, 500) });
    }, profile, (usage) => {
      const telemetry = { inputTokens: usage.inputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens, cacheReadInputTokens: usage.cacheReadInputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd, costSource: usage.costSource };
      repository.updateSharedMessage(messageId, telemetry);
      if (runId) repository.updateRun(runId, telemetry);
    }, (entries) => repository.addAgentStreamEvents(messageId, runId ?? null, entries.map((entry) => ({
      kind: entry.streamKind ?? (entry.category === 'agent_file_read' ? 'file_read' : entry.category === 'agent_file_write' ? 'file_write' : 'tool'), detail: entry.detail,
    }))), runId ? repository.getRun(runId)?.kind ?? 'analysis' : 'analysis', target.accountProfile ?? DEFAULT_ACCOUNT_PROFILE, undefined, agent === 'claude' ? (steer) => {
      registerActiveReplySteering(messageId, steer);
      void deliverPendingSharedInterjections(repository, messageId);
    } : undefined);
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
    activeReplySteering.delete(messageId);
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
  const runId = replyRunIds.get(messageId) ?? repository.getRunByMessage(messageId)?.id;
  // Task-linked replies execute through the durable run runner. Cancelling
  // only the chat bubble marks it canceled but leaves a runner in another
  // process free to keep working; route it through the run cancel protocol so
  // its cancellation flag reaches that process and kills its whole CLI tree.
  if (runId) cancelAgentRun(repository, runId);
  else activeReplies.get(messageId)?.abort();
  repository.updateSharedMessage(messageId, { status: 'canceled' });
  const dispatched = dispatchNextSharedTurn(repository, message.conversationId);
  if (!dispatched.length) settleLinkedTask(repository, message.conversationId, 'Agent conversation was canceled; review or redirect the task.');
  return { ...message, status: 'canceled' as const };
}

export async function interjectQueuedSharedMessage(repository: WorkItemRepository, messageId: string): Promise<SharedMessage[] | null> {
  // Priority is durable intent: if the provider session is still starting, its
  // onReady callback will retry this message instead of making the user click
  // Interject again. Only explicit Interject uses queuePriority.
  const message = repository.promoteQueuedSharedMessage(messageId);
  if (!message) return null;
  const targets = message.dispatchTarget === 'both'
    ? ['codex', 'claude']
    : message.dispatchTarget === 'auto'
      ? ['codex', 'claude']
      : [message.dispatchTarget];
  const running = repository.listAllSharedMessages(message.conversationId)
    .filter((candidate) => candidate.status === 'running' && targets.includes(candidate.author));
  // Do not silently degrade into a second process. A provider that has not
  // exposed its live session yet remains queued and the UI can retry once the
  // active reply reaches the steering-ready point.
  const attempted = await Promise.all(running.map(async (reply) => ({
    reply,
    accepted: await activeReplySteering.get(reply.id)?.(message.body),
  })));
  // The request must be acknowledged while the same reply remains live. This
  // closes the observed race where a canceled reply made the queued human
  // message appear delivered even though no active turn could receive it.
  const steered = attempted
    .filter(({ reply, accepted }) => accepted && activeReplySteering.has(reply.id) && repository.getSharedMessageById(reply.id)?.status === 'running')
    .map(({ reply }) => reply);
  if (steered.length) {
    repository.updateSharedMessage(messageId, { status: 'completed', interjectionStreamOffset: humanizeRunOutputBlocks(steered[0].body).length });
    publishRealtimeEvent('shared');
  }
  if (!steered.length) return [];
  return steered;
}

/** Deliver explicitly interjected messages that arrived before Codex was ready. */
export async function deliverPendingSharedInterjections(repository: WorkItemRepository, replyId: string): Promise<void> {
  const reply = repository.getSharedMessageById(replyId);
  if (!reply || reply.status !== 'running' || (reply.author !== 'codex' && reply.author !== 'claude')) return;
  const pending = repository.listAllSharedMessages(reply.conversationId)
    .filter((message) => message.author === 'jeffrey' && message.status === 'queued' && (message.queuePriority ?? 0) > 0)
    .filter((message) => message.dispatchTarget === 'auto' || message.dispatchTarget === 'both' || message.dispatchTarget === reply.author)
    .sort((left, right) => (right.queuePriority ?? 0) - (left.queuePriority ?? 0));
  for (const message of pending) {
    const steered = await interjectQueuedSharedMessage(repository, message.id);
    // The session ended or rejected input. Leave this and any older
    // interjections queued for the normal dispatcher; do not start a parallel
    // provider turn or cancel the current one.
    if (!steered?.length) break;
  }
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
