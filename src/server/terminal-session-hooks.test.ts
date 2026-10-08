import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { e2eRuntimeCapabilities } from './runtime-capabilities.js';
import { WORKBENCH_RUN_WORKTREE_ROOT } from './run-worktree.js';
import { applyTerminalHookEvent, syncTerminalSessions, type TerminalHookPayload } from './terminal-session-sync.js';

const SESSION = '8aa1d225-c20d-4235-9dbd-9a1881353e21';
const event = (name: TerminalHookPayload['hook_event_name'], extra: Partial<TerminalHookPayload> = {}): TerminalHookPayload =>
  ({ provider: 'claude', hook_event_name: name, session_id: SESSION, cwd: '/Users/jeffrey.lu/dev/workbench', ...extra });

describe('Claude Code hook bridge', () => {
  let database: WorkbenchDatabase;
  beforeEach(() => { database = openDatabase(':memory:'); });
  afterEach(() => { database.close(); });

  const conversations = () => database.prepare('SELECT id, title, claude_session_id FROM shared_conversations').all() as Array<{ id: string; title: string; claude_session_id: string }>;
  const messages = (id: string) => database.prepare('SELECT author, body FROM shared_messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(id) as Array<{ author: string; body: string }>;

  it('creates one conversation per session and titles it from the first prompt', () => {
    database.prepare("INSERT INTO projects (id, name, key, created_at, updated_at) VALUES ('p1', 'Workbench', 'workbench', 'now', 'now')").run();
    applyTerminalHookEvent(database, event('SessionStart'));
    applyTerminalHookEvent(database, event('SessionStart'));
    expect(conversations()).toHaveLength(1);
    expect(conversations()[0]).toMatchObject({ title: 'Terminal session', claude_session_id: SESSION });

    applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'p-1', prompt: 'Fix the flaky test\nplease' }));
    expect(conversations()[0].title).toBe('Fix the flaky test');
    const [marker] = messages(conversations()[0].id);
    expect(marker.author).toBe('system');
    expect(marker.body).toContain('Project: Workbench.');
  });

  it('appends the prompt and the reply once, however often the hook retries', () => {
    const prompt = event('UserPromptSubmit', { prompt_id: 'p-1', prompt: 'Say hi' });
    const stop = event('Stop', { prompt_id: 'p-1', last_assistant_message: 'Hi.' });
    for (const payload of [prompt, prompt, stop, stop]) applyTerminalHookEvent(database, payload);
    expect(conversations()).toHaveLength(1);
    expect(messages(conversations()[0].id).slice(1)).toEqual([{ author: 'jeffrey', body: 'Say hi' }, { author: 'claude', body: 'Hi.' }]);

    applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'p-2', prompt: 'Again' }));
    expect(messages(conversations()[0].id)).toHaveLength(4);
  });

  it('skips Workbench runs, managed worktrees, and sessions Workbench owns', () => {
    const sdk = applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'a', prompt: 'x', entrypoint: 'sdk-cli' }));
    expect(sdk).toEqual({ status: 'skipped', reason: 'workbench run' });

    const worktree = applyTerminalHookEvent(database, { ...event('UserPromptSubmit', { prompt_id: 'a', prompt: 'x' }), session_id: 'wt', cwd: `${WORKBENCH_RUN_WORKTREE_ROOT}/repo/run` });
    expect(worktree).toEqual({ status: 'skipped', reason: 'workbench worktree' });

    database.prepare("INSERT INTO shared_conversations (id, title, claude_session_id, created_at, updated_at) VALUES ('c1', 'Room', 'owned', 'now', 'now')").run();
    const owned = applyTerminalHookEvent(database, { ...event('UserPromptSubmit', { prompt_id: 'a', prompt: 'x' }), session_id: 'owned' });
    expect(owned).toEqual({ status: 'skipped', reason: 'workbench session' });
    expect(conversations()).toHaveLength(1);
  });

  it('drops Workbench-resumed turns on a session that is already a terminal conversation', () => {
    applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'p-1', prompt: 'From the terminal' }));
    applyTerminalHookEvent(database, event('Stop', { prompt_id: 'p-1', last_assistant_message: 'Terminal reply' }));
    const resumedPrompt = applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'p-2', prompt: 'Full Workbench prompt', entrypoint: 'sdk-cli' }));
    const resumedStop = applyTerminalHookEvent(database, event('Stop', { prompt_id: 'p-2', last_assistant_message: 'Workbench reply', entrypoint: 'sdk-cli' }));
    expect(resumedPrompt).toEqual({ status: 'skipped', reason: 'workbench run' });
    expect(resumedStop).toEqual({ status: 'skipped', reason: 'workbench run' });
    expect(messages(conversations()[0].id).slice(1)).toEqual([{ author: 'jeffrey', body: 'From the terminal' }, { author: 'claude', body: 'Terminal reply' }]);
  });

  it('ignores harness-injected prompts such as task notifications', () => {
    applyTerminalHookEvent(database, event('SessionStart'));
    const injected = applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'n-1', prompt: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }));
    expect(injected.status).toBe('applied');
    expect(conversations()[0].title).toBe('Terminal session');
    applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'p-1', prompt: 'Real question' }));
    expect(conversations()[0].title).toBe('Real question');
    expect(messages(conversations()[0].id).slice(1)).toEqual([{ author: 'jeffrey', body: 'Real question' }]);
  });

  it('does not resurrect a deleted conversation', () => {
    applyTerminalHookEvent(database, event('SessionStart'));
    database.prepare("UPDATE shared_conversations SET deleted_at = 'now'").run();
    expect(applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'p', prompt: 'hi' }))).toMatchObject({ status: 'skipped' });
  });

  it('adopts a conversation the transcript sync created and stops the transcript import', async () => {
    database.prepare("INSERT INTO shared_conversations (id, title, created_at, updated_at) VALUES ('imported', 'From file', 'now', 'now')").run();
    database.prepare(`INSERT INTO terminal_session_imports (transcript_path, provider, session_id, status, conversation_id, byte_offset, import_since, created_at, updated_at)
      VALUES ('/t.jsonl', 'claude', ?, 'terminal', 'imported', 10, 'now', 'now', 'now')`).run(SESSION);
    const result = applyTerminalHookEvent(database, event('UserPromptSubmit', { prompt_id: 'p', prompt: 'hi' }));
    expect(result).toMatchObject({ status: 'applied', conversationId: 'imported', created: false });
    expect(conversations()).toHaveLength(1);
    expect(database.prepare('SELECT status, skip_reason FROM terminal_session_imports').get()).toEqual({ status: 'skipped', skip_reason: 'hook bridge' });
    await expect(syncTerminalSessions(database, { claudeProjectsRoot: '/nonexistent', codexSessionsRoot: '/nonexistent' })).resolves.toEqual({ createdConversationIds: [], updatedConversationIds: [] });
  });

  describe('POST /api/terminal-sessions/events', () => {
    let server: Server;
    let url: string;
    beforeEach(async () => {
      server = createApp(database, e2eRuntimeCapabilities).listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test port.');
      url = `http://127.0.0.1:${address.port}/api/terminal-sessions/events`;
    });
    afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    it('accepts a loopback hook and stores the turn', async () => {
      expect((await post(event('UserPromptSubmit', { prompt_id: 'p', prompt: 'hi' }))).status).toBe(200);
      expect(conversations()).toHaveLength(1);
    });

    it('rejects forwarded (non-loopback) callers and malformed bodies', async () => {
      // A forwarded request is no longer a direct loopback caller, so the app's
      // auth gate answers 401 before the route's own 403 can; both reject it.
      expect([401, 403]).toContain((await post(event('SessionStart'), { 'x-forwarded-for': '203.0.113.9' })).status);
      expect(conversations()).toHaveLength(0);
      expect((await post({ provider: 'claude', hook_event_name: 'Nope', session_id: 'x' })).status).toBe(400);
    });
  });
});
