import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAgentSessionStatus, readSessionEventsFromFile, type AgentSessionKey } from '../src/server/agent-session.js';
import { terminalLinesFor } from '../src/server/agent-session-terminal.js';
import type { TerminalLine } from '../src/shared/contracts.js';

type Agent = AgentSessionKey['agent'];

export interface ResolvedSession extends AgentSessionKey {
  title: string;
  lastActiveAt: string;
}

interface SessionRow {
  conversation_id: string;
  agent: Agent;
  title: string;
  last_active_at: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
}

export interface AttachIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  run(command: string, args: string[]): CommandResult;
  wait(ms: number): Promise<void>;
}

const defaultIo: AttachIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: args[0] === 'attach-session' || args[0] === 'switch-client' ? 'inherit' : 'pipe' });
    return { status: result.status, stdout: result.stdout || '' };
  },
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
};

function sessionRows(database: DatabaseSync, selector: string, agent: Agent | null): SessionRow[] {
  const parameters = agent ? [selector, agent] : [selector];
  const agentClause = agent ? 'AND sessions.agent = ?' : '';
  const exact = database.prepare(`
    SELECT sessions.conversation_id, sessions.agent, conversations.title, sessions.last_active_at
    FROM agent_sessions sessions
    JOIN shared_conversations conversations ON conversations.id = sessions.conversation_id
    WHERE sessions.conversation_id = ? ${agentClause}
    ORDER BY sessions.last_active_at DESC
  `).all(...parameters) as unknown as SessionRow[];
  if (exact.length) return exact;
  return database.prepare(`
    SELECT sessions.conversation_id, sessions.agent, conversations.title, sessions.last_active_at
    FROM agent_sessions sessions
    JOIN shared_conversations conversations ON conversations.id = sessions.conversation_id
    WHERE instr(lower(conversations.title), lower(?)) > 0 ${agentClause}
    ORDER BY sessions.last_active_at DESC
  `).all(...parameters) as unknown as SessionRow[];
}

export function resolveSession(database: DatabaseSync, selector: string, agent: Agent | null): ResolvedSession {
  const rows = sessionRows(database, selector, agent);
  if (rows.length === 0) throw new Error(`No ${agent ? `${agent} ` : ''}session matches "${selector}".`);
  if (rows.length > 1) {
    const choices = rows.map((row) => `${row.conversation_id} (${row.agent}, ${row.title})`).join('\n  ');
    throw new Error(`Session selector "${selector}" is ambiguous. Use a conversation id${agent ? '' : ' and agent'}:\n  ${choices}`);
  }
  const row = rows[0];
  return { conversationId: row.conversation_id, agent: row.agent, title: row.title, lastActiveAt: row.last_active_at };
}

function attachTmux(session: ResolvedSession, io: AttachIo): boolean {
  if (!process.env.TMUX || io.run('tmux', ['-V']).status !== 0) return false;
  const current = io.run('tmux', ['display-message', '-p', '#{session_name}']);
  const sessionTarget = current.stdout.trim();
  if (current.status !== 0 || !sessionTarget) return false;

  const windowName = `conversation-${session.conversationId}`;
  const windows = io.run('tmux', ['list-windows', '-t', sessionTarget, '-F', '#{window_name}\t#{window_id}']);
  if (windows.status !== 0) return false;
  const existing = windows.stdout.trim().split('\n').find((line) => line.split('\t', 1)[0] === windowName)?.split('\t')[1];
  if (existing) {
    if (io.run('tmux', ['select-window', '-t', existing]).status !== 0) throw new Error(`tmux could not select ${windowName}.`);
    return true;
  }

  const tailCommand = `env -u TMUX npm run session:attach -- ${session.conversationId} ${session.agent}`;
  if (io.run('tmux', ['new-window', '-t', sessionTarget, '-n', windowName, tailCommand]).status !== 0) {
    throw new Error(`tmux could not open ${windowName}.`);
  }
  return true;
}

function printLines(lines: TerminalLine[], io: AttachIo): void {
  for (const line of lines) io.stdout.write(`${line.text}${line.kind === 'delta' ? '' : '\n'}`);
}

export async function tailSession(session: ResolvedSession, once: boolean, io: AttachIo = defaultIo): Promise<void> {
  let offset = 0;
  for (;;) {
    const batch = readSessionEventsFromFile(session, offset);
    printLines(batch.events.flatMap((event) => terminalLinesFor(session.agent, event)), io);
    if (batch.nextOffset > offset) {
      offset = batch.nextOffset;
      continue;
    }
    if (once || readAgentSessionStatus(session)?.state === 'stopped') return;
    await io.wait(250);
  }
}

export async function runAttach(argv: string[], env: NodeJS.ProcessEnv = process.env, io: AttachIo = defaultIo): Promise<void> {
  const once = argv.includes('--once');
  const positional = argv.filter((value) => value !== '--once');
  const [selector, agentText] = positional;
  if (!selector || positional.length > 2 || (agentText && agentText !== 'claude' && agentText !== 'codex')) {
    throw new Error('Usage: npm run session:attach -- <conversationId|title substring> [claude|codex] [--once]');
  }
  const databasePath = resolve(env.DATABASE_PATH?.trim() || './data/workbench.db');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const session = resolveSession(database, selector, agentText as Agent | undefined ?? null);
    if (!once && attachTmux(session, io)) return;
    await tailSession(session, once, io);
  } finally {
    database.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  runAttach(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
