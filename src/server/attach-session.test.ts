import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSession, tailSession, type AttachIo, type ResolvedSession } from '../../scripts/attach-session.js';
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

  it('opens a conversation-named tmux window that tails the session instead of selecting the host pane', () => {
    mkdirSync(root, { recursive: true });
    const databasePath = join(root, 'workbench.db');
    const database = openDatabase(databasePath);
    database.prepare("INSERT INTO shared_conversations (id, title, created_at, updated_at) VALUES ('c1', 'Alpha terminal', '2026-10-08', '2026-10-08')").run();
    database.prepare("INSERT INTO agent_sessions (conversation_id, agent, account_profile, cwd, profile, state, socket_path, started_at, last_active_at) VALUES ('c1', 'claude', 'default', '.', 'standard', 'idle', '/one.sock', '2026-10-08', '2026-10-08')").run();
    database.close();

    const bin = join(root, 'bin');
    const argsPath = join(root, 'tmux-args.txt');
    mkdirSync(bin);
    const tmuxPath = join(bin, 'tmux');
    writeFileSync(tmuxPath, [
      '#!/bin/sh',
      "printf '%s ' \"$@\" >> \"$TMUX_ARGS_FILE\"",
      "printf '\\n' >> \"$TMUX_ARGS_FILE\"",
      'case "$1" in',
      "  -V) echo 'tmux 3.4' ;;",
      "  display-message) echo 'work' ;;",
      'esac',
    ].join('\n'));
    chmodSync(tmuxPath, 0o755);

    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/attach-session.ts', 'c1', 'claude'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_PATH: databasePath, PATH: `${bin}:${process.env.PATH}`, TMUX: '/tmp/tmux-1/default,1,0', TMUX_ARGS_FILE: argsPath },
    });

    expect(result.status).toBe(0);
    const commands = readFileSync(argsPath, 'utf8');
    expect(commands).toContain('new-window -t work -n conversation-c1 env -u TMUX npm run session:attach -- c1 claude');
    expect(commands).not.toContain('select-pane');
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
