import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedMessage } from '../shared/contracts.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { claimWarmProcess, hasWarmProcess, resetPoolForTest } from './agent-pool.js';
import { accountProfileForSharedReply, agentStreamEventForCodexAppServerItem, buildSharedReplyPrompt, classificationForLinkedItem, codexAppServerInitialRequest, codexFinalReply, codexThreadBootstrapRequest, codexTurnStartParams, compactConversationHistory, compactKeyPoints, compactSharedBrief, hasUntrackedContinuationClaim, isCodexDecisionPreamble, isMissingClaudeSessionError, latestHumanMessageForSharedReply, memoryQueryForSharedReply, precedingHumanMessageForSharedReply, resolveSharedReplyWorkingDirectory, sharedTurnKindForMessage, warmSharedRoomCodex } from './shared-room.js';

const originalPath = process.env.PATH;
const temporaryDirectories: string[] = [];

afterEach(() => {
  resetPoolForTest();
  process.env.PATH = originalPath;
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

  it('caps the scoped brief and relies on retrieved memory for older detail', () => {
    const brief = `start ${'x'.repeat(2_800)} end`;
    const compacted = compactSharedBrief(brief);

    expect(compacted.length).toBeLessThanOrEqual(800);
    expect(compacted).toContain('characters compacted; use retrieved memory');
    expect(compacted).toContain('start');
    expect(compacted).toContain('end');
  });

  it('preserves a buried decision when compacting a shared brief', () => {
    const compacted = compactKeyPoints(`Opening detail\n${'x'.repeat(2_000)}\nDecision: retrieve only relevant memories, up to 100.\n${'y'.repeat(2_000)}`, 250);

    expect(compacted).toContain('Decision: retrieve only relevant memories, up to 100.');
  });

  it('grounds a short follow-up retrieval query in the preceding user decision', () => {
    const messages = [
      message(0, 'Cut prompt tokens, but do not lose durable decisions.'),
      message(1, 'I found the shared-room history budget is 3,000 characters.'),
      message(2, 'Yes, do it.'),
    ];

    expect(memoryQueryForSharedReply(messages)).toBe('Cut prompt tokens, but do not lose durable decisions.\nYes, do it.');
  });

  it('does not contaminate a standalone question with an unrelated prior control turn', () => {
    const messages = [
      message(0, 'Approve the Workbench preview.'),
      message(1, 'That preview is now live.'),
      message(2, 'What are my hobbies?'),
    ];

    expect(memoryQueryForSharedReply(messages)).toBe('What are my hobbies?');
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
    const prompt = buildSharedReplyPrompt('claude', 'Shared context.', '', messages, { item: task, run }, [], null, current);

    expect(current).toBe('Update the GitHub PR description to include the Loom demo.');
    expect(precedingHumanMessageForSharedReply(messages)).toBe('Discuss the PR description, but do not post anything.');
    expect(prompt).toContain('Supervisor-issued external-action capability');
    expect(prompt).not.toContain('No external capability is issued');
    database.close();
  });

  it('injects only memory matches that clear the query-relative relevance threshold', () => {
    const retrieved = Array.from({ length: 9 }, (_, index) => ({
      source: 'message', title: `Memory ${index + 1}`, body: `Detail ${index + 1}`, createdAt: '2026-08-25T00:00:00.000Z', score: index < 3 ? 0.03 - index * 0.001 : 0.01,
    }));

    const prompt = buildSharedReplyPrompt('codex', 'Shared context.', '', [], undefined, retrieved);

    expect(prompt).toContain('Retrieved memory (5 relevant matches');
    expect(prompt).toContain('Memory 5');
    expect(prompt).not.toContain('Memory 6');
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
    const granted = buildSharedReplyPrompt('codex', 'Shared context.', '', [], { item: task, run }, [], null, 'Commit and push the changes.');

    expect(denied).toContain('No external capability is issued');
    expect(granted).toContain('Supervisor-issued capability');
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
      `printf '%s\\n' \"$initialize\" >> '${log}'`,
      'sleep 0.05',
      `printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"fake-codex\"}}}'`,
      'while IFS= read -r request; do :; done',
    ].join('\n');
    writeFileSync(join(directory, 'codex'), fakeAppServer);
    chmodSync(join(directory, 'codex'), 0o755);
    process.env.PATH = directory;

    warmSharedRoomCodex(directory);

    expect(hasWarmProcess('codex', directory, 'codex', ['app-server', '--stdio'], 'default')).toBe(false);
    await waitFor(() => hasWarmProcess('codex', directory, 'codex', ['app-server', '--stdio'], 'default'));
    expect(JSON.parse(readFileSync(log, 'utf8'))).toMatchObject({ id: 1, method: 'initialize' });

    const claimed = claimWarmProcess('codex', directory, 'codex', ['app-server', '--stdio'], 'default');
    expect(claimed).not.toBeNull();
    claimed?.kill();
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
