import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { findTmuxTarget, resolveSession, tailSession, type AttachIo, type ResolvedSession } from '../../scripts/attach-session.js';
import { openDatabase } from './database.js';

const root = join(process.cwd(), 'data', '.attach-session-test');
const previousSessions = process.env.WORKBENCH_AGENT_SESSIONS_DIR;

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previousSessions === undefined) delete process.env.WORKBENCH_AGENT_SESSIONS_DIR;
  else process.env.WORKBENCH_AGENT_SESSIONS_DIR = previousSessions;
});

describe('attach-session', () => {
  it('resolves an exact id or unique title substring and rejects ambiguity', () => {
    mkdirSync(root, { recursive: true });
    const path = join(root, 'workbench.db');
    const migrated = openDatabase(path);
    migrated.prepare("INSERT INTO shared_conversations (id, title, created_at, updated_at) VALUES ('c1', 'Alpha terminal', '2026-10-08', '2026-10-08'), ('c2', 'Alpha second', '2026-10-08', '2026-10-08')").run();
    const insert = migrated.prepare("INSERT INTO agent_sessions (conversation_id, agent, account_profile, cwd, profile, state, socket_path, started_at, last_active_at) VALUES (?, ?, 'default', '.', 'standard', 'idle', ?, '2026-10-08', '2026-10-08')");
    insert.run('c1', 'claude', '/one.sock');
    insert.run('c2', 'codex', '/two.sock');
    migrated.close();

    const database = new DatabaseSync(path, { readOnly: true });
    expect(resolveSession(database, 'c1', null)).toMatchObject({ conversationId: 'c1', agent: 'claude' });
    expect(resolveSession(database, 'second', null)).toMatchObject({ conversationId: 'c2', agent: 'codex' });
    expect(() => resolveSession(database, 'Alpha', null)).toThrow('ambiguous');
    database.close();
  });

  it('finds the tmux pane that owns the session host ancestor', () => {
    expect(findTmuxTarget(40, '10\twork:2.1\n20\tother:0.0', new Map([[40, 30], [30, 10], [10, 1]]))).toBe('work:2.1');
    expect(findTmuxTarget(40, '20\tother:0.0', new Map([[40, 30], [30, 10]]))).toBeNull();
  });

  it('prints the same rendered lines as the terminal panel in once mode', async () => {
    process.env.WORKBENCH_AGENT_SESSIONS_DIR = join(root, 'sessions');
    const session: ResolvedSession = { conversationId: 'c1', agent: 'claude', title: 'Alpha', lastActiveAt: '2026-10-08' };
    const directory = join(process.env.WORKBENCH_AGENT_SESSIONS_DIR, 'c1', 'claude');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'events.jsonl'), [
      { at: '2026-10-08', source: 'host', type: 'turn_started', turnId: 't1', prompt: 'hello' },
      { at: '2026-10-08', source: 'provider', turnId: 't1', raw: 'answer' },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
    let output = '';
    const io: AttachIo = {
      stdout: { write: (value) => { output += String(value); return true; } },
      stderr: { write: () => true },
      run: () => ({ status: 1, stdout: '' }),
      wait: async () => {},
    };
    await tailSession(session, true, io);
    expect(output).toBe('> hello\nanswer\n');
  });
});
