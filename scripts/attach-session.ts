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

function processParents(io: AttachIo): Map<number, number> {
  const result = io.run('ps', ['-axo', 'pid=,ppid=']);
  if (result.status !== 0) return new Map();
  return new Map(result.stdout.trim().split('\n').flatMap((line) => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && Number.isInteger(parent) ? [[pid, parent] as const] : [];
  }));
}

export function findTmuxTarget(hostPid: number, panes: string, parents: Map<number, number>): string | null {
  const paneByPid = new Map<number, string>();
  for (const line of panes.trim().split('\n')) {
    const [pidText, target] = line.split('\t');
    const pid = Number(pidText);
    if (Number.isInteger(pid) && target) paneByPid.set(pid, target);
  }
  for (let pid: number | undefined = hostPid; pid && pid > 1; pid = parents.get(pid)) {
    const target = paneByPid.get(pid);
    if (target) return target;
  }
  return null;
}

function attachTmux(session: ResolvedSession, io: AttachIo): boolean {
  const status = readAgentSessionStatus(session);
  if (!status || io.run('tmux', ['-V']).status !== 0) return false;
  const panes = io.run('tmux', ['list-panes', '-a', '-F', '#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}']);
  if (panes.status !== 0) return false;
  const target = findTmuxTarget(status.hostPid, panes.stdout, processParents(io));
  if (!target) return false;
  const sessionTarget = target.split(':', 1)[0];
  if (io.run('tmux', ['select-window', '-t', target]).status !== 0 || io.run('tmux', ['select-pane', '-t', target]).status !== 0) {
    throw new Error(`tmux could not select ${target}.`);
  }
  const command = process.env.TMUX ? 'switch-client' : 'attach-session';
  const attached = io.run('tmux', [command, '-t', sessionTarget]);
  if (attached.status !== 0) throw new Error(`tmux ${command} failed for ${sessionTarget}.`);
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
