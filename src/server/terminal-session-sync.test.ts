import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WORKBENCH_RUN_WORKTREE_ROOT } from './run-worktree.js';
import { isInjectedContext, startTerminalSessionSync, syncTerminalSessions } from './terminal-session-sync.js';

const NOW = Date.parse('2026-10-08T18:00:00.000Z');
const at = (minutes: number) => new Date(NOW - 60 * 60_000 + minutes * 60_000).toISOString();

const CLAUDE_SESSION = '11111111-1111-4111-8111-111111111111';
const CODEX_THREAD = '01a11bde-9aed-72f1-b5ac-b94985f9e8f6';

type Line = Record<string, unknown>;
const jsonl = (lines: Line[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join('');

function claudeLine(type: 'user' | 'assistant', content: unknown, minutes: number, extra: Line = {}): Line {
  return {
    type, sessionId: CLAUDE_SESSION, cwd: '/Users/jeffrey.lu/dev/workbench', entrypoint: 'cli', userType: 'external', isSidechain: false,
    timestamp: at(minutes), message: { role: type, content }, ...extra,
  };
}

function codexLine(type: string, payload: Line, minutes: number): Line {
  return { timestamp: at(minutes), type, payload };
}

const codexMeta = (originator = 'codex-tui', cwd = '/Users/jeffrey.lu/dev') =>
  codexLine('session_meta', { id: CODEX_THREAD, cwd, originator, cli_version: '0.161.0' }, 0);

function messages(database: WorkbenchDatabase, conversationId: string) {
  return database.prepare('SELECT author, body FROM shared_messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId) as Array<{ author: string; body: string }>;
}

function conversations(database: WorkbenchDatabase) {
  return database.prepare('SELECT id, title FROM shared_conversations ORDER BY created_at').all() as Array<{ id: string; title: string }>;
}

function streamEvents(database: WorkbenchDatabase, conversationId: string) {
  return database.prepare(`SELECT events.kind, events.detail FROM agent_stream_events events
    JOIN shared_messages messages ON messages.id = events.message_id
    WHERE messages.conversation_id = ? ORDER BY events.rowid`).all(conversationId);
}

describe('terminal session sync', () => {
  let directory: string;
  let claudeRoot: string;
  let codexRoot: string;
  let database: WorkbenchDatabase;
  let options: { claudeProjectsRoot: string; codexSessionsRoot: string; now: () => number; lookbackMs: number };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-terminal-sync-'));
    claudeRoot = join(directory, 'claude-projects');
    codexRoot = join(directory, 'codex-sessions');
    mkdirSync(join(claudeRoot, '-Users-jeffrey-lu-dev-workbench'), { recursive: true });
    mkdirSync(join(codexRoot, '2026', '10', '08'), { recursive: true });
    database = openDatabase(':memory:');
    options = { claudeProjectsRoot: claudeRoot, codexSessionsRoot: codexRoot, now: () => NOW, lookbackMs: 24 * 3_600_000 };
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const claudePath = (sessionId = CLAUDE_SESSION) => join(claudeRoot, '-Users-jeffrey-lu-dev-workbench', `${sessionId}.jsonl`);
  const codexPath = (threadId = CODEX_THREAD) => join(codexRoot, '2026', '10', '08', `rollout-2026-10-08T10-15-35-${threadId}.jsonl`);

  it('imports a terminal Claude Code session as one conversation with typed prompts and grouped replies', async () => {
    writeFileSync(claudePath(), jsonl([
      { type: 'queue-operation', operation: 'enqueue', timestamp: at(0), sessionId: CLAUDE_SESSION },
      claudeLine('user', '<command-message>clear</command-message>\n<command-name>/clear</command-name>\n<command-args></command-args>', 0),
      claudeLine('user', 'Why is the conversation list slow?', 1),
      claudeLine('assistant', [{ type: 'thinking', thinking: 'hidden' }], 2),
      claudeLine('assistant', [{ type: 'text', text: 'Checking the list query.' }], 2),
      claudeLine('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 3),
      claudeLine('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], 3),
      claudeLine('assistant', [{ type: 'text', text: 'Subagent noise.' }], 3, { isSidechain: true }),
      claudeLine('user', 'Caveat: injected', 3, { isMeta: true }),
      claudeLine('assistant', [{ type: 'text', text: 'The cursor scan is unindexed.' }], 4),
      claudeLine('user', [{ type: 'text', text: 'Add the index.' }], 5),
      claudeLine('assistant', [{ type: 'text', text: 'Added.' }], 6),
    ]));
    // Subagent transcripts sit under the parent session directory and are ignored.
    mkdirSync(join(claudeRoot, '-Users-jeffrey-lu-dev-workbench', CLAUDE_SESSION, 'subagents'), { recursive: true });
    writeFileSync(join(claudeRoot, '-Users-jeffrey-lu-dev-workbench', CLAUDE_SESSION, 'subagents', 'agent-1.jsonl'), jsonl([claudeLine('user', 'subagent prompt', 2)]));

    const result = await syncTerminalSessions(database, options);

    const [conversation] = conversations(database);
    expect(conversations(database)).toHaveLength(1);
    expect(result.createdConversationIds).toEqual([conversation.id]);
    expect(conversation.title).toBe('Why is the conversation list slow?');
    const imported = messages(database, conversation.id);
    expect(imported[0].author).toBe('system');
    expect(imported[0].body).toContain('terminal Claude Code session in `/Users/jeffrey.lu/dev/workbench`');
    expect(imported.slice(1)).toEqual([
      { author: 'jeffrey', body: 'Why is the conversation list slow?' },
      { author: 'claude', body: 'Checking the list query.\n\nThe cursor scan is unindexed.' },
      { author: 'jeffrey', body: 'Add the index.' },
      { author: 'claude', body: 'Added.' },
    ]);
  });

  it('imports a terminal Codex session, dropping injected context and retaining live activity', async () => {
    writeFileSync(codexPath(), jsonl([
      codexMeta(),
      codexLine('event_msg', { type: 'thread_settings_applied' }, 0),
      codexLine('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>x</permissions instructions>' }] }, 0),
      codexLine('response_item', { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '# AGENTS.md instructions for /Users/jeffrey.lu\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>' },
        { type: 'input_text', text: '<environment_context>\n  <cwd>/Users/jeffrey.lu</cwd>\n</environment_context>' },
      ] }, 1),
      codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'why is my computer slow' }] }, 2),
      codexLine('response_item', { type: 'reasoning', summary: [], encrypted_content: 'zzz' }, 3),
      codexLine('response_item', { type: 'custom_tool_call', name: 'exec', input: 'top' }, 3),
      codexLine('response_item', { type: 'custom_tool_call_output', output: 'cpu 99%' }, 3),
      codexLine('response_item', { type: 'function_call', name: 'shell', arguments: '{}' }, 3),
      codexLine('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Docker is using 12 GB.' }] }, 4),
    ]));

    await syncTerminalSessions(database, options);

    const [conversation] = conversations(database);
    expect(conversations(database)).toHaveLength(1);
    expect(conversation.title).toBe('why is my computer slow');
    expect(messages(database, conversation.id).slice(1)).toEqual([
      { author: 'jeffrey', body: 'why is my computer slow' },
      { author: 'codex', body: 'Docker is using 12 GB.' },
    ]);
    expect(streamEvents(database, conversation.id)).toEqual([
      { kind: 'decision', detail: 'Thinking: Thinking…' },
      { kind: 'tool', detail: 'exec: top' },
      { kind: 'tool', detail: 'Tool output: cpu 99%' },
      { kind: 'tool', detail: 'shell: {}' },
    ]);
  });

  it('streams a Codex rollout line by line and resumes after a restart without duplicates', async () => {
    writeFileSync(codexPath(), `${jsonl([codexMeta(), codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect the sync' }] }, 1)])}`);
    await syncTerminalSessions(database, options);
    const [conversation] = conversations(database);

    appendFileSync(codexPath(), jsonl([codexLine('response_item', { type: 'reasoning', summary: [{ text: 'Checking the importer.' }] }, 2)]));
    await syncTerminalSessions(database, options);
    expect(messages(database, conversation.id).at(-1)).toEqual({ author: 'codex', body: 'working… Thinking: Checking the importer.' });

    appendFileSync(codexPath(), jsonl([codexLine('response_item', { type: 'custom_tool_call', name: 'exec', input: 'rg token=secret' }, 3)]));
    await syncTerminalSessions(database, options);
    appendFileSync(codexPath(), jsonl([codexLine('response_item', { type: 'custom_tool_call_output', output: 'token=should-not-appear\nfound line' }, 4)]));
    await syncTerminalSessions(database, options);

    // A fresh sync call has no in-memory state. The saved byte offset keeps
    // the prior pending reply and its activity exactly once.
    await syncTerminalSessions(database, options);
    expect(streamEvents(database, conversation.id)).toEqual([
      { kind: 'decision', detail: 'Thinking: Checking the importer.' },
      { kind: 'tool', detail: 'exec: rg token=[redacted]' },
      { kind: 'tool', detail: 'Tool output: token=[redacted]\nfound line' },
    ]);

    appendFileSync(codexPath(), jsonl([codexLine('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The stream is live.' }] }, 5)]));
    await syncTerminalSessions(database, options);
    expect(messages(database, conversation.id).at(-1)).toEqual({ author: 'codex', body: 'The stream is live.' });
    expect(database.prepare("SELECT status FROM shared_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(conversation.id)).toEqual({ status: 'completed' });
  });

  it('imports nothing twice and continues a live session from where it stopped', async () => {
    writeFileSync(claudePath(), jsonl([
      claudeLine('user', 'First prompt', 1),
      claudeLine('assistant', [{ type: 'text', text: 'Working on it.' }], 2),
    ]));
    await syncTerminalSessions(database, options);
    const second = await syncTerminalSessions(database, options);
    expect(second).toEqual({ createdConversationIds: [], updatedConversationIds: [] });

    // The CLI is mid-write: a partial trailing line must wait for its newline.
    const partial = JSON.stringify(claudeLine('assistant', [{ type: 'text', text: 'Done.' }], 3));
    appendFileSync(claudePath(), partial.slice(0, 40));
    await syncTerminalSessions(database, options);
    appendFileSync(claudePath(), `${partial.slice(40)}\n${jsonl([claudeLine('user', 'Second prompt', 4)])}`);
    const third = await syncTerminalSessions(database, options);
    await syncTerminalSessions(database, options);

    const [conversation] = conversations(database);
    expect(conversations(database)).toHaveLength(1);
    expect(third.createdConversationIds).toEqual([]);
    expect(third.updatedConversationIds).toEqual([conversation.id]);
    expect(messages(database, conversation.id).slice(1)).toEqual([
      { author: 'jeffrey', body: 'First prompt' },
      { author: 'claude', body: 'Working on it.\n\nDone.' },
      { author: 'jeffrey', body: 'Second prompt' },
    ]);
  });

  it('skips transcripts that Workbench itself produced', async () => {
    const owned = '22222222-2222-4222-8222-222222222222';
    const worktree = '33333333-3333-4333-8333-333333333333';
    const headless = '44444444-4444-4444-8444-444444444444';
    database.prepare("INSERT INTO shared_conversations (id, title, claude_session_id, created_at, updated_at) VALUES ('c1', 'Workbench chat', ?, ?, ?)").run(owned, at(0), at(0));
    writeFileSync(claudePath(owned), jsonl([claudeLine('user', 'resumed by Workbench', 1)]));
    writeFileSync(claudePath(worktree), jsonl([claudeLine('user', 'run prompt', 1, { cwd: join(WORKBENCH_RUN_WORKTREE_ROOT, 'workbench-abc', 'run-1') })]));
    writeFileSync(claudePath(headless), jsonl([claudeLine('user', 'External-action guardrail: ...', 1, { entrypoint: 'sdk-cli' })]));
    writeFileSync(codexPath('01a11d55-75ba-7e90-a88e-c6906805e08c'), jsonl([
      codexMeta('workbench', '/Users/jeffrey.lu/dev/workbench'),
      codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'workbench turn' }] }, 1),
    ]));

    await syncTerminalSessions(database, options);

    expect(conversations(database).map((conversation) => conversation.title)).toEqual(['Workbench chat']);
    const reasons = database.prepare('SELECT session_id, skip_reason FROM terminal_session_imports ORDER BY session_id').all();
    expect(reasons).toEqual([
      { session_id: '01a11d55-75ba-7e90-a88e-c6906805e08c', skip_reason: 'workbench run' },
      { session_id: owned, skip_reason: 'workbench session' },
      { session_id: worktree, skip_reason: 'workbench worktree' },
      { session_id: headless, skip_reason: 'workbench run' },
    ]);
  });

  it('bounds the first import to the lookback window', async () => {
    const stale = '55555555-5555-4555-8555-555555555555';
    writeFileSync(claudePath(stale), jsonl([claudeLine('user', 'from last week', -7 * 24 * 60)]));
    const staleTime = new Date(NOW - 7 * 86_400_000);
    utimesSync(claudePath(stale), staleTime, staleTime);
    // A long-running session modified today only brings in today's turns.
    writeFileSync(claudePath(), jsonl([
      claudeLine('user', 'two days ago', -48 * 60),
      claudeLine('assistant', [{ type: 'text', text: 'old answer' }], -48 * 60 + 1),
      claudeLine('user', 'this afternoon', 10),
      claudeLine('assistant', [{ type: 'text', text: 'new answer' }], 11),
    ]));
    utimesSync(claudePath(), new Date(NOW), new Date(NOW));

    await syncTerminalSessions(database, options);

    const all = conversations(database);
    expect(all.map((conversation) => conversation.title)).toEqual(['this afternoon']);
    expect(messages(database, all[0].id).slice(1)).toEqual([
      { author: 'jeffrey', body: 'this afternoon' },
      { author: 'claude', body: 'new answer' },
    ]);
  });

  it('keeps an imported session in its conversation and stops when Jeffrey deletes it', async () => {
    writeFileSync(claudePath(), jsonl([claudeLine('user', 'First prompt', 1)]));
    await syncTerminalSessions(database, options);
    database.prepare('UPDATE shared_conversations SET deleted_at = ?').run(at(2));
    appendFileSync(claudePath(), jsonl([claudeLine('user', 'After delete', 3)]));

    await syncTerminalSessions(database, options);

    expect(conversations(database)).toHaveLength(1);
    expect(database.prepare('SELECT status, skip_reason FROM terminal_session_imports').get()).toEqual({ status: 'skipped', skip_reason: 'conversation deleted' });
  });

  it('treats only whole CLI-injected blocks as non-prompts', () => {
    expect(isInjectedContext('<environment_context>\n<cwd>/x</cwd>\n</environment_context>')).toBe(true);
    expect(isInjectedContext('[Request interrupted by user for tool use]')).toBe(true);
    expect(isInjectedContext('Why does <Button> render twice?')).toBe(false);
    expect(isInjectedContext('<div> is wrong here')).toBe(false);
  });

  it('runs passes from the monitor and reports changed conversations', async () => {
    const onChange = vi.fn();
    const monitor = startTerminalSessionSync(database, { ...options, watch: false, rescanMs: 60_000, onChange });
    try {
      await monitor.syncNow();
      writeFileSync(codexPath(), jsonl([
        codexMeta(),
        codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] }, 1),
      ]));
      await monitor.syncNow();
    } finally {
      monitor.stop();
    }
    const [conversation] = conversations(database);
    expect(onChange).toHaveBeenCalledWith({ createdConversationIds: [conversation.id], updatedConversationIds: [conversation.id] });
  });

  it('adds the import ledger when upgrading from migration 095', () => {
    const path = join(directory, 'workbench.db');
    const current = openDatabase(path);
    current.exec('DROP TABLE terminal_session_imports;');
    current.prepare("DELETE FROM schema_migrations WHERE id = '096_terminal_session_imports'").run();
    current.close();

    const upgraded = openDatabase(path);
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'terminal_session_imports'").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT id FROM schema_migrations WHERE id = '096_terminal_session_imports'").get()).toBeTruthy();
    upgraded.close();
  });
});
