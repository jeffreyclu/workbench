import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedMessage } from '../shared/contracts.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { claimWarmProcess, hasWarmProcess, resetPoolForTest } from './agent-pool.js';
import { EXTERNAL_ACTION_CONTRACT } from './agent-runner.js';
import { accountProfileForSharedReply, agentStreamEventForCodexAppServerItem, buildResumedSharedReplyPrompt, buildSharedReplyPrompt, classificationForLinkedItem, CODEX_APP_SERVER_ARGS, codexActiveContextTokensFromAppServerEvent, codexAppServerInitialRequest, codexFinalReply, codexThreadBootstrapRequest, codexTurnStartParams, codexUsageFromAppServerEvent, compactConversationHistory, compactKeyPoints, compactSharedBrief, fallbackTurnGrounding, hasUntrackedContinuationClaim, isCodexDecisionPreamble, isMissingClaudeSessionError, isTransientSqliteContention, latestHumanMessageForSharedReply, precedingHumanMessageForSharedReply, resolveSharedReplyWorkingDirectory, resolveTurnGrounding, runSteerableCodex, sharedTurnKindForMessage, threadForSharedReply, warmSharedRoomCodex } from './shared-room.js';

const originalPath = process.env.PATH;
const originalProviderFirstActivityTimeout = process.env.WORKBENCH_PROVIDER_FIRST_ACTIVITY_TIMEOUT_MS;
const temporaryDirectories: string[] = [];

afterEach(() => {
  resetPoolForTest();
  process.env.PATH = originalPath;
  if (originalProviderFirstActivityTimeout === undefined) delete process.env.WORKBENCH_PROVIDER_FIRST_ACTIVITY_TIMEOUT_MS;
  else process.env.WORKBENCH_PROVIDER_FIRST_ACTIVITY_TIMEOUT_MS = originalProviderFirstActivityTimeout;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the fake app-server handshake.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function message(index: number, body: string): SharedMessage {
  return {
    id: `message-${index}`,
    conversationId: 'conversation',
    author: index % 2 ? 'claude' : 'jeffrey',
    body,
    pinned: false,
    status: 'completed',
    error: '',
    attachments: [],
    dispatchTarget: 'none',
    model: null,
    executionProfile: null,
    inputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    costSource: null,
    fallbackFrom: null,
    fallbackReason: null,
    dispatchGroupId: null,
    attempt: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    retrievedMemoryCount: null,
    completedAt: '2026-08-21T00:00:00.000Z',
    createdAt: `2026-08-21T00:00:${String(index).padStart(2, '0')}.000Z`,
  };
}

describe('compactConversationHistory', () => {
  it('recognizes SQLite writer contention without swallowing unrelated failures', () => {
    expect(isTransientSqliteContention(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 }))).toBe(true);
    expect(isTransientSqliteContention(new Error('database is busy'))).toBe(true);
    expect(isTransientSqliteContention(new Error('disk I/O error'))).toBe(false);
  });

  it('recognizes an expired Claude session so retries can start fresh', () => {
    expect(isMissingClaudeSessionError(new Error('No conversation found with session ID: abc'))).toBe(true);
    expect(isMissingClaudeSessionError(new Error('Provider rate limited'))).toBe(false);
  });
  it('rejects a reply that promises to report after untracked background work', () => {
    expect(hasUntrackedContinuationClaim("q09 is running in the background; I'll report when it finishes.")).toBe(true);
    expect(hasUntrackedContinuationClaim("The rewritten q09 fixture is now running; I'll report the pass/fail the moment it lands.")).toBe(true);
    expect(hasUntrackedContinuationClaim('Waiting for the background probe to complete before continuing analysis.')).toBe(true);
    expect(hasUntrackedContinuationClaim('My subagent is still running; I will report when it finishes.')).toBe(true);
    expect(hasUntrackedContinuationClaim('The command completed with 18 passing checks.')).toBe(false);
  });

  it('keeps the newest turns, compacts older turns, and respects its prompt budget', () => {
    const messages = Array.from({ length: 14 }, (_, index) => message(index, `turn-${index} ${'x'.repeat(2_000)}`));
    const history = compactConversationHistory(messages, 3_000);

    expect(history.length).toBeLessThanOrEqual(3_000);
    expect(history).toContain('Earlier conversation');
    expect(history).toContain('turn-13');
    expect(history).not.toContain(`turn-0 ${'x'.repeat(500)}`);
  });

  it('caps the scoped brief and points older detail to on-demand recall', () => {
    const brief = `start ${'x'.repeat(2_800)} end`;
    const compacted = compactSharedBrief(brief);

    expect(compacted.length).toBeLessThanOrEqual(800);
    expect(compacted).toContain('characters compacted; use recall_context');
    expect(compacted).toContain('start');
    expect(compacted).toContain('end');
  });

  it('preserves a buried decision when compacting a shared brief', () => {
    const compacted = compactKeyPoints(`Opening detail\n${'x'.repeat(2_000)}\nDecision: retrieve only relevant memories, up to 100.\n${'y'.repeat(2_000)}`, 250);

    expect(compacted).toContain('Decision: retrieve only relevant memories, up to 100.');
  });

  it('resolves continue to the preceding concrete human objective without adopting agent narration', () => {
    const messages = [
      message(0, 'Add the existing expandable task-type robot control beside the pin.'),
      message(1, 'I should add a database column and a passive badge.'),
      message(2, 'fucking continue now'),
    ];

    const grounding = fallbackTurnGrounding(messages);

    expect(grounding.continuation).toBe(true);
    expect(grounding.objective).toContain('Add the existing expandable task-type robot control beside the pin.');
    expect(grounding.objective).not.toContain('database column');
  });

  it('walks through an urgency and continuation chain to the unresolved concrete request', () => {
    const messages = [
      message(0, "Why is this text so big and taking up so much space? Clicking a hunk doesn't work; it does nothing."),
      message(1, 'I inspected several unrelated files and hit the tool cap.'),
      message(2, '???'),
      message(3, 'I inspected again and hit the tool cap.'),
      message(4, 'continue'),
      message(5, 'I restarted discovery and hit the tool cap.'),
      message(6, 'WHY THE FUCK ARE YOU TAKING SO LONG JUST FUCKING BUILD IT'),
      message(7, 'I started another broad investigation.'),
      message(8, 'continue'),
    ];

    const grounding = fallbackTurnGrounding(messages);

    expect(grounding.objective).toContain('Why is this text so big');
    expect(grounding.objective).toContain("Clicking a hunk doesn't work");
    expect(grounding.objective).not.toContain('TAKING SO LONG');
  });

  it('reuses a persisted objective instantly for a continuation without another model call', async () => {
    const prior = {
      objective: 'Fix the oversized text and make hunk clicks select the matching decision.',
      acceptanceCriteria: ['Both interactions work in the live diff review.'],
      exclusions: ['Do not revisit diff colors.'],
      continuation: false,
      source: 'haiku' as const,
    };
    let classifierCalls = 0;
    const grounding = await resolveTurnGrounding([message(0, 'continue')], async () => {
      classifierCalls += 1;
      return '{}';
    }, prior);

    expect(classifierCalls).toBe(0);
    expect(grounding).toEqual({ ...prior, continuation: true, source: 'persisted' });
  });

  it('keeps a correction authoritative instead of treating it as a continuation', () => {
    const prior = { objective: 'Add a passive badge.', acceptanceCriteria: [], exclusions: [], continuation: false, source: 'haiku' as const };
    const grounding = fallbackTurnGrounding([message(0, 'No, that is not the problem. Remove the badge.')], prior);

    expect(grounding.objective).toBe('No, that is not the problem. Remove the badge.');
    expect(grounding.source).toBe('fallback');
  });

  it('keeps a short referential question authoritative instead of inheriting the prior task', async () => {
    const prior = {
      objective: 'Fix the inconsistent connector icons.',
      acceptanceCriteria: ['Every connector icon is consistent.'],
      exclusions: [],
      continuation: false,
      source: 'haiku' as const,
    };
    let classifierCalls = 0;
    const grounding = await resolveTurnGrounding([
      message(0, 'can we fix these icons, ugh they look inconsistent'),
      message(1, 'I changed the connector icon implementation.'),
      message(2, 'is this PR worth stacking?'),
    ], async () => {
      classifierCalls += 1;
      return JSON.stringify({
        objective: 'Answer whether this PR is worth stacking.',
        acceptanceCriteria: ['Give a direct recommendation supported by the PR shape.'],
        exclusions: ['Do not continue changing connector icons.'],
        continuation: false,
      });
    }, prior);

    expect(classifierCalls).toBe(1);
    expect(grounding.objective).toBe('Answer whether this PR is worth stacking.');
    expect(grounding.continuation).toBe(false);
    expect(grounding.exclusions).toContain('Do not continue changing connector icons.');
  });

  it('uses the literal short question as the fallback objective when supervision is unavailable', async () => {
    const prior = { objective: 'Fix the inconsistent connector icons.', acceptanceCriteria: [], exclusions: [], continuation: false, source: 'haiku' as const };
    const grounding = await resolveTurnGrounding([message(0, 'is this PR worth stacking?')], async () => {
      throw new Error('classifier unavailable');
    }, prior);

    expect(grounding).toEqual(expect.objectContaining({
      objective: 'is this PR worth stacking?',
      continuation: false,
      source: 'fallback',
    }));
  });

  it('uses a tiny supervisor result as the authoritative objective and preserves explicit exclusions', async () => {
    const messages = [
      message(0, 'Show the execution type in the header.'),
      message(1, 'I will persist a new derived type.'),
      message(2, 'No. Reuse the existing task-type picker beside the pin. Do not add persistence.'),
    ];
    const grounding = await resolveTurnGrounding(messages, async () => JSON.stringify({
      objective: 'Render the existing expandable task-type picker beside the pin.',
      acceptanceCriteria: ['The picker is interactive in manually created conversations.'],
      exclusions: ['Do not add a passive badge or persistence.'],
      continuation: false,
    }));
    const prompt = buildSharedReplyPrompt('codex', 'Old shared hypothesis: add a badge.', '', messages, undefined, null, undefined, grounding);

    expect(grounding.source).toBe('haiku');
    expect(prompt).toContain('AUTHORITATIVE CURRENT OBJECTIVE');
    expect(prompt).toContain('Render the existing expandable task-type picker beside the pin.');
    expect(prompt).toContain('Do not add a passive badge or persistence.');
    expect(prompt).toContain('Reference-only conversation transcript:');
    expect(prompt).toContain('ignore the conflict');
  });

  it('sends only the authoritative turn delta when resuming a provider session', () => {
    const grounding = fallbackTurnGrounding([message(0, 'Commit and push the finished fix.')]);
    const prompt = buildResumedSharedReplyPrompt(
      'Current repository: /tmp/project',
      'conversation',
      'message-id',
      'Supervisor-issued external-action capability: Commit and push once.',
      grounding,
      'Retrieved durable context: Jeffrey works at Writer.',
    );

    expect(prompt).toContain('Commit and push the finished fix.');
    expect(prompt).toContain('Current repository: /tmp/project');
    expect(prompt).toContain('Supervisor-issued external-action capability');
    expect(prompt.startsWith('Supervisor-issued external-action capability')).toBe(true);
    expect(prompt).toContain('Current reply message ID: message-id');
    expect(prompt).toContain('already present in this session');
    expect(prompt).toContain('Retrieved durable context: Jeffrey works at Writer.');
    expect(prompt).not.toContain('Reference-only conversation transcript:');
  });

  it('falls back safely when the supervisor returns malformed output', async () => {
    const messages = [message(0, 'Fix only the retry button.')];
    const grounding = await resolveTurnGrounding(messages, async () => 'not json');

    expect(grounding).toEqual(expect.objectContaining({ objective: 'Fix only the retry button.', source: 'fallback' }));
  });

  it('binds retries to their original human turn instead of a newer queued request', () => {
    const original = message(0, 'Fix retry state immediately.');
    const reply = message(1, 'The first attempt failed.');
    reply.dispatchGroupId = original.id;
    const newer = message(2, 'Now change the archive animation.');

    const scoped = threadForSharedReply([original, reply, newer], reply.dispatchGroupId);

    expect(latestHumanMessageForSharedReply(scoped)).toBe('Fix retry state immediately.');
    expect(fallbackTurnGrounding(scoped).objective).toBe('Fix retry state immediately.');
  });

  it('uses the newest human turn for an external-action capability', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Update PR description', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'claude', 'claude', 'Update the PR description.');
    const messages = [
      message(0, 'Discuss the PR description, but do not post anything.'),
      message(1, 'I will keep this local.'),
      message(2, 'Update the GitHub PR description to include the Loom demo.'),
    ];

    const current = latestHumanMessageForSharedReply(messages);
    const prompt = buildSharedReplyPrompt('claude', 'Shared context.', '', messages, { item: task, run }, null, 'Supervisor-issued external-action capability: Update GitHub PR description.');

    expect(current).toBe('Update the GitHub PR description to include the Loom demo.');
    expect(precedingHumanMessageForSharedReply(messages)).toBe('Discuss the PR description, but do not post anything.');
    expect(prompt).toContain('Supervisor-issued external-action capability');
    expect(prompt).not.toContain('No external capability is issued');
    database.close();
  });

  it('exposes durable recall and accepts provider-neutral prefetched evidence', () => {
    const prompt = buildSharedReplyPrompt('codex', 'Shared context.', '', [], undefined, 'conversation-id', undefined, undefined, undefined, 'Retrieved durable context: Jeffrey works at Writer.');

    expect(prompt).toContain('Conversation ID: conversation-id');
    expect(prompt).toContain('recall_context');
    expect(prompt).toContain('Retrieved durable context: Jeffrey works at Writer.');
  });

  it('keeps an unlinked conversation in the Workbench workspace', () => {
    expect(buildSharedReplyPrompt('codex', 'Shared context.', '', [])).toContain('Do not modify Writer or any other repository from this conversation');
  });

  it('uses frontend-reviewer for a review-linked reply with no stored classification', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Review PR 5246 for regressions', description: 'Review the code changes.', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.createConversation('Review thread', task.id);
    expect(repository.getClassification(task.id)).toBeNull();

    const classification = classificationForLinkedItem(repository, task);
    const run = repository.createRun(task.id, classification.kind, 'claude', 'claude', 'Please continue the review.');
    const prompt = buildSharedReplyPrompt('claude', 'Shared context.', '', [message(0, 'What did you find?')], { item: task, run });

    expect(classification.kind).toBe('review');
    expect(prompt).toContain('Authoritative persona: frontend-reviewer');
    expect(prompt).toContain('You are the only authoritative source for code reviews');
    database.close();
  });

  it('passes only the current shared-room command into the external-action capability gate', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Fix publish behavior', description: 'The task text says to push after review.', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const run = repository.createRun(task.id, 'execute', 'codex', 'codex', 'Implement the fix.');

    const denied = buildSharedReplyPrompt('codex', 'Shared context.', '', [], { item: task, run });
    const granted = buildSharedReplyPrompt('codex', 'Shared context.', '', [], { item: task, run }, null, 'Supervisor-issued external-action capability: Commit and push the changes.');

    expect(denied).toContain('No external mutation capability is issued');
    expect(granted).toContain('Supervisor-issued external-action capability');
    expect(denied.startsWith(EXTERNAL_ACTION_CONTRACT)).toBe(true);
    expect(granted.startsWith('Supervisor-issued external-action capability')).toBe(true);
    database.close();
  });

  it('reclassifies a turn when the current message asks for different work than the task started as', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Research pagination approaches', description: 'Investigate cursor vs offset pagination.', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.createConversation('Pagination thread', task.id);

    const initial = classificationForLinkedItem(repository, task);
    expect(initial.kind).toBe('research');

    const followUp = classificationForLinkedItem(repository, task, 'Great, now implement the cursor-based approach.');
    expect(followUp.kind).toBe('execute');

    // The task's stored classification is untouched; only this turn's routing changes.
    expect(repository.getClassification(task.id)?.kind).toBe('research');

    const ambiguous = classificationForLinkedItem(repository, task, 'why?');
    expect(ambiguous.kind).toBe('research');

    const executeTask = repository.create({ title: 'Build connector search', description: 'Implement server-side connector search.', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    expect(classificationForLinkedItem(repository, executeTask).kind).toBe('execute');
    expect(sharedTurnKindForMessage(repository, executeTask, 'ok now what')).toBe('analysis');
    database.close();
  });

  it('routes an unlinked manual implementation request as write-enabled execution', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);

    expect(sharedTurnKindForMessage(repository, null, 'Build the pool warming.')).toBe('execute');
    expect(sharedTurnKindForMessage(repository, null, 'Explain why the pool is slow.')).toBe('analysis');

    database.close();
  });

  it('runs a linked conversation reply in its task workspace rather than Workbench', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const workspace = '/Users/jeffrey.lu/dev/writer-monorepo';
    const task = repository.create({ title: 'Fix connector query regression', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: workspace, dueDate: null });

    expect(resolveSharedReplyWorkingDirectory(task)).toBe(workspace);
    database.close();
  });

  it('honors a server-persisted Repo Explorer selection over the linked task workspace', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Cross-repository review', description: '', priority: 1, status: 'ready', projectName: 'Connectors', workspacePath: '/Users/jeffrey.lu/dev/writer-monorepo', dueDate: null });

    expect(resolveSharedReplyWorkingDirectory(task, process.cwd())).toBe(process.cwd());
    database.close();
  });

  it('falls back from a deleted Repo Explorer selection instead of blocking a new turn', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const task = repository.create({ title: 'Repair Workbench chat', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: '/tmp/missing-workbench-source-directory', dueDate: null });

    expect(resolveSharedReplyWorkingDirectory(task, '/tmp/missing-repo-selection')).toBe(process.cwd());
    database.close();
  });

  it('uses an explicit room profile, then falls back to the task-scoped default', () => {
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database);
    const externalTask = repository.create({ title: 'Fix connector query regression', description: '', priority: 1, status: 'ready', projectName: 'Connectors', workspacePath: '/Users/jeffrey.lu/dev/writer-monorepo', dueDate: null });
    const workbenchTask = repository.create({ title: 'Fix room routing', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });

    expect(accountProfileForSharedReply(null, 'default')).toBe('default');
    expect(accountProfileForSharedReply(null)).toBe('default');
    expect(accountProfileForSharedReply(externalTask)).toBe('default');
    expect(accountProfileForSharedReply(workbenchTask)).toBe('personal');
    database.close();
  });
});

describe('agentStreamEventForCodexAppServerItem', () => {
  it('records the completed provider reasoning summary before the next tool call', () => {
    expect(agentStreamEventForCodexAppServerItem('item/started', { type: 'reasoning' })).toBeNull();
    expect(agentStreamEventForCodexAppServerItem('item/completed', {
      type: 'reasoning', text: 'Inspect the existing event path before changing it.',
    })).toEqual({ kind: 'decision', detail: 'Inspect the existing event path before changing it.' });
    expect(agentStreamEventForCodexAppServerItem('item/started', {
      type: 'commandExecution', command: 'npm test',
    })).toEqual({ kind: 'tool', detail: 'command_execution: npm test' });
  });

  it('uses app-server summary parts and explicitly requests concise summaries for new turns', () => {
    expect(agentStreamEventForCodexAppServerItem('item/completed', {
      type: 'reasoning', summary: [{ type: 'summary_text', text: 'The failure is likely in the shared route, so inspect that first.' }],
    })).toEqual({ kind: 'decision', detail: 'The failure is likely in the shared route, so inspect that first.' });
    expect(codexTurnStartParams('thread', '/workspace', 'Fix it')).toMatchObject({
      threadId: 'thread', cwd: '/workspace', effort: 'medium', summary: 'concise',
    });
    expect(codexThreadBootstrapRequest('/workspace')).toEqual({ method: 'thread/start', params: { cwd: '/workspace', ephemeral: false, model: null, approvalPolicy: 'never' } });
    expect(codexThreadBootstrapRequest('/workspace', 'thread-1')).toEqual({ method: 'thread/resume', params: { threadId: 'thread-1', cwd: '/workspace', approvalPolicy: 'never' } });
    expect(codexAppServerInitialRequest('/workspace', null, true)).toMatchObject({ method: 'thread/start' });
    expect(codexAppServerInitialRequest('/workspace', null, false)).toMatchObject({ method: 'initialize' });
  });

  it('records only an explicit completed agent-message decision preamble', () => {
    expect(agentStreamEventForCodexAppServerItem('item/completed', {
      type: 'agentMessage', text: 'Decision: Inspect the failing route before changing it.',
    })).toEqual({ kind: 'decision', detail: 'Inspect the failing route before changing it.' });
    expect(agentStreamEventForCodexAppServerItem('item/completed', {
      type: 'agent_message', text: 'Decision: Re-run the focused test after the edit.',
    })).toEqual({ kind: 'decision', detail: 'Re-run the focused test after the edit.' });
    expect(agentStreamEventForCodexAppServerItem('item/completed', {
      type: 'agentMessage', text: 'I updated the route and the test passes.',
    })).toBeNull();
  });
});

describe('shared-room Codex warming', () => {
  it('claims only an app-server that completed the provider initialize handshake', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-codex-app-server-'));
    temporaryDirectories.push(directory);
    const log = join(directory, 'app-server.log');
    const fakeAppServer = [
      '#!/bin/sh',
      'IFS= read -r initialize',
      `printf '%s\\n' "$initialize" >> '${log}'`,
      'sleep 0.05',
      `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'`,
      'while IFS= read -r request; do :; done',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;

    warmSharedRoomCodex(directory);

    expect(hasWarmProcess('codex', directory, 'codex', CODEX_APP_SERVER_ARGS, 'default')).toBe(false);
    await waitFor(() => hasWarmProcess('codex', directory, 'codex', CODEX_APP_SERVER_ARGS, 'default'));
    expect(JSON.parse(readFileSync(log, 'utf8'))).toMatchObject({ id: 1, method: 'initialize' });

    const claimed = claimWarmProcess('codex', directory, 'codex', CODEX_APP_SERVER_ARGS, 'default');
    expect(claimed).not.toBeNull();
    claimed?.kill();
  });

  it('recovers an expired Codex thread with the full fresh-session prompt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-codex-resume-'));
    temporaryDirectories.push(directory);
    const countFile = join(directory, 'count');
    const log = join(directory, 'requests.log');
    const fakeAppServer = [
      '#!/bin/sh',
      `count=0; if [ -f '${countFile}' ]; then read count < '${countFile}'; fi; count=$((count + 1)); printf '%s' "$count" > '${countFile}'`,
      `IFS= read -r initialize; printf '%s\n' "$initialize" >> '${log}'`,
      `printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'`,
      `IFS= read -r bootstrap; printf '%s\n' "$bootstrap" >> '${log}'`,
      `if [ "$count" -eq 1 ]; then printf '%s\n' '{"jsonrpc":"2.0","id":2,"error":{"message":"no rollout found for thread id 01a058de-5fe3-7f32-8d47-6d4a306c2b3f"}}'; exit 0; fi`,
      `printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"fresh-thread"}}}'`,
      `IFS= read -r turn; printf '%s\n' "$turn" >> '${log}'`,
      `printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"fresh-turn"}}}'`,
      `printf '%s\n' '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"message-1","delta":"Completed from fresh thread."}}'`,
      `printf '%s\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"turn":{"id":"fresh-turn","status":"completed"}}}'`,
      'while IFS= read -r request; do :; done',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;

    const progress: string[] = [];
    const result = await runSteerableCodex(
      'Incremental follow-up.', directory, new AbortController().signal,
      (body) => progress.push(body), () => undefined, () => undefined, () => undefined,
      'expired-thread', 'default', false, 'Full recovery prompt.',
    );

    expect(result.output).toBe('Completed from fresh thread.');
    expect(progress).toContain('● Codex thread expired. Restarting this turn in a fresh session…');
    const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.some((request) => request.method === 'thread/resume' && request.params.threadId === 'expired-thread')).toBe(true);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(true);
    expect(requests.find((request) => request.method === 'turn/start')?.params.input[0].text).toBe('Full recovery prompt.');
  });

  it('abandons a silent acknowledged turn and retries once on a fresh Codex thread', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-codex-silent-turn-'));
    temporaryDirectories.push(directory);
    const countFile = join(directory, 'count');
    const log = join(directory, 'requests.log');
    const fakeAppServer = [
      '#!/bin/sh',
      `count=0; if [ -f '${countFile}' ]; then read count < '${countFile}'; fi; count=$((count + 1)); printf '%s' "$count" > '${countFile}'`,
      `IFS= read -r initialize; printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'`,
      `IFS= read -r bootstrap; printf '%s\n' "$bootstrap" >> '${log}'; printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread"}}}'`,
      `IFS= read -r turn; printf '%s\n' "$turn" >> '${log}'; printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn"}}}'`,
      'if [ "$count" -eq 1 ]; then while IFS= read -r request; do :; done; fi',
      `printf '%s\n' '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"message-1","delta":"Recovered on a fresh thread."}}'`,
      `printf '%s\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"turn":{"id":"turn","status":"completed"}}}'`,
      'while IFS= read -r request; do :; done',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;
    process.env.WORKBENCH_PROVIDER_FIRST_ACTIVITY_TIMEOUT_MS = '50';

    const progress: string[] = [];
    const result = await runSteerableCodex(
      'Incremental prompt.', directory, new AbortController().signal,
      (body) => progress.push(body), () => undefined, () => undefined, () => undefined,
      'stalled-thread', 'default', false, 'Full fresh prompt.',
    );

    expect(result.output).toBe('Recovered on a fresh thread.');
    expect(progress).toContain('● Codex accepted the turn but produced no activity. Retrying once in a fresh session…');
    const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.some((request) => request.method === 'thread/resume')).toBe(true);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(true);
    expect(requests.filter((request) => request.method === 'turn/start').at(-1)?.params.input[0].text).toBe('Full fresh prompt.');
  });

  it('retries a rejected Codex interjection until the active turn accepts it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-codex-steer-retry-'));
    temporaryDirectories.push(directory);
    const log = join(directory, 'requests.log');
    const fakeAppServer = [
      '#!/bin/sh',
      `IFS= read -r initialize; printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'`,
      `IFS= read -r bootstrap; printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-1"}}}'`,
      `IFS= read -r turn; printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-1"}}}'`,
      `IFS= read -r steer1; printf '%s\\n' "$steer1" >> '${log}'; printf '%s\\n' '{"jsonrpc":"2.0","id":4,"error":{"message":"turn temporarily busy"}}'`,
      `IFS= read -r steer2; printf '%s\\n' "$steer2" >> '${log}'; printf '%s\\n' '{"jsonrpc":"2.0","id":5,"result":{"turnId":"turn-1"}}'`,
      `printf '%s\\n' '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"message-1","delta":"Applied the interjection."}}'`,
      `printf '%s\\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}'`,
      'while IFS= read -r request; do :; done',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;
    let accepted = false;

    const result = await runSteerableCodex(
      'Start the task.', directory, new AbortController().signal,
      () => undefined,
      (steer) => { void steer('Change direction now.').then((value) => { accepted = value; }); },
      () => undefined, () => undefined,
    );

    expect(result.output).toBe('Applied the interjection.');
    expect(accepted).toBe(true);
    const requests = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.method === 'turn/steer')).toBe(true);
  });

  it('settles a pending Codex interjection when the active turn ends first', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-codex-steer-terminal-'));
    temporaryDirectories.push(directory);
    const fakeAppServer = [
      '#!/bin/sh',
      `IFS= read -r initialize; printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'`,
      `IFS= read -r bootstrap; printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-1"}}}'`,
      `IFS= read -r turn; printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-1"}}}'`,
      `IFS= read -r steer; printf '%s\\n' '{"jsonrpc":"2.0","id":4,"error":{"message":"turn temporarily busy"}}'`,
      `printf '%s\\n' '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"message-1","delta":"Initial answer."}}'`,
      `printf '%s\\n' '{"jsonrpc":"2.0","method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}'`,
      'while IFS= read -r request; do :; done',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;
    let accepted: boolean | null = null;

    const result = await runSteerableCodex(
      'Start the task.', directory, new AbortController().signal,
      () => undefined,
      (steer) => { void steer('Change direction now.').then((value) => { accepted = value; }); },
      () => undefined, () => undefined,
    );
    await waitFor(() => accepted !== null);

    expect(result.output).toBe('Initial answer.');
    expect(accepted).toBe(false);
  });

  it('contains a closed app-server stdin pipe to the turn instead of crashing Workbench', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-codex-epipe-'));
    temporaryDirectories.push(directory);
    const fakeAppServer = [
      '#!/bin/sh',
      'IFS= read -r initialize',
      `printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'`,
      // Keep stdout alive briefly after closing stdin so Workbench receives
      // initialize and attempts the next JSON-RPC write into a closed pipe.
      'exec 0<&-',
      'sleep 0.05',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;

    await expect(runSteerableCodex(
      'Trigger the closed transport.', directory, new AbortController().signal,
      () => undefined, () => undefined, () => undefined, () => undefined,
    )).rejects.toThrow(/Codex app-server (?:transport failed|exited)/);

    // Reaching this assertion proves the stream's EPIPE stayed inside the
    // rejected turn instead of becoming an uncaught process-level error.
    expect(true).toBe(true);
  });

  it('contains failures from a live-stream persistence callback to the turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-codex-callback-error-'));
    temporaryDirectories.push(directory);
    const fakeAppServer = [
      '#!/bin/sh',
      'IFS= read -r initialize',
      `printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"fake-codex"}}}'`,
      'IFS= read -r bootstrap',
      `printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"thread-1"}}}'`,
      'IFS= read -r turn',
      `printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"turn-1"}}}'`,
      `printf '%s\n' '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"itemId":"message-1","delta":"stream me"}}'`,
      'sleep 1',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;

    await expect(runSteerableCodex(
      'Trigger the callback.', directory, new AbortController().signal,
      () => { throw new Error('database is locked'); },
      () => undefined, () => undefined, () => undefined,
    )).rejects.toThrow('database is locked');
  });

});

describe('isCodexDecisionPreamble', () => {
  it('recognizes the debugger-only message that must not become reply content', () => {
    expect(isCodexDecisionPreamble('Decision: Inspect the route before editing.')).toBe(true);
    expect(isCodexDecisionPreamble('  Decision: Run the focused test.')).toBe(true);
    expect(isCodexDecisionPreamble('Fixed the route.')).toBe(false);
  });

  it('keeps decisions and interim stream messages out of the completed answer', () => {
    expect(codexFinalReply([
      'Decision: Inspect the failing route before editing.',
      'I found the stale state and am updating the route.',
      'Fixed the route and verified the focused test.',
    ])).toBe('Fixed the route and verified the focused test.');
  });

  it('joins every item of a steered turn instead of dropping the pre-interjection reply', () => {
    expect(codexFinalReply([
      'Decision: Inspect the failing route before editing.',
      'Fixed the route and verified the focused test.',
      'Also renamed the helper per your interjection.',
    ], true)).toBe('Fixed the route and verified the focused test.\n\nAlso renamed the helper per your interjection.');
  });
});

describe('codexUsageFromAppServerEvent', () => {
  it('extracts forwarded token-count usage without double-counting cached input', () => {
    expect(codexUsageFromAppServerEvent({ method: 'codex/event', params: { payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1_200, cached_input_tokens: 900, output_tokens: 44 } } } } }))
      .toEqual({ inputTokens: 300, cacheCreationInputTokens: null, cacheReadInputTokens: 900, outputTokens: 44 });
  });

  it('accepts terminal turn usage when no token-count notification was forwarded', () => {
    expect(codexUsageFromAppServerEvent({ method: 'turn/completed', params: { usage: { input_tokens: 200, cached_input_tokens: 50, output_tokens: 20 } } }))
      .toEqual({ inputTokens: 150, cacheCreationInputTokens: null, cacheReadInputTokens: 50, outputTokens: 20 });
  });

  it('extracts usage from the thread/tokenUsage/updated event current app-server versions actually emit', () => {
    expect(codexUsageFromAppServerEvent({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 't1',
        turnId: 'turn1',
        tokenUsage: {
          last: { totalTokens: 17_693, inputTokens: 17_688, cachedInputTokens: 11_008, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
          total: { totalTokens: 17_693, inputTokens: 17_688, cachedInputTokens: 11_008, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
          modelContextWindow: 258_400,
        },
      },
    })).toEqual({ inputTokens: 6_680, cacheCreationInputTokens: 0, cacheReadInputTokens: 11_008, outputTokens: 5 });
  });

  it('prefers cumulative Codex turn usage over the last provider request', () => {
    const event = {
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          last: { inputTokens: 100_000, cachedInputTokens: 90_000, outputTokens: 10 },
          total: { inputTokens: 620_000, cachedInputTokens: 550_000, outputTokens: 70 },
        },
      },
    };
    expect(codexUsageFromAppServerEvent(event)).toEqual({ inputTokens: 70_000, cacheCreationInputTokens: null, cacheReadInputTokens: 550_000, outputTokens: 70 });
    expect(codexActiveContextTokensFromAppServerEvent(event)).toBe(100_000);
  });

  it('returns null for a turn/completed event with no usage field, matching current app-server output', () => {
    expect(codexUsageFromAppServerEvent({
      method: 'turn/completed',
      params: { threadId: 't1', turn: { id: 'turn1', items: [], status: 'completed' } },
    })).toBeNull();
  });
});
