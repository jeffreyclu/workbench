import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  awaitTurn,
  ensureSession,
  interrupt,
  readAgentSessionStatus,
  reattachAll,
  resolveSessionTurnFromLog,
  sendTurn,
  submitTurn,
  type AgentSessionEvent,
} from './agent-session.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { fakeAgentDirectory } from './test-fake-agent.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENV_KEYS = ['PATH', 'CLAUDE_BIN', 'WORKBENCH_AGENT_SESSIONS_DIR', 'WORKBENCH_AGENT_SESSION_IDLE_MS', 'WORKBENCH_PROVIDER_FIRST_ACTIVITY_TIMEOUT_MS'] as const;

/**
 * A stream-json Claude stand-in. It records every spawn's argv, answers each
 * user message with assistant + result events, crashes on "crash", stays
 * silent on "hang" until interrupted, and answers "slow" after a delay.
 * Output uses writeSync so a line written right before exit is not lost.
 */
function fakeClaudeSource(spawnsPath: string): string {
  return `
import { appendFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(spawnsPath)}, JSON.stringify({ pid: process.pid, args }) + '\\n');
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const sessionId = flag('--session-id') ?? flag('--resume');
const emit = (event) => writeSync(1, JSON.stringify({ ...event, session_id: sessionId }) + '\\n');
let turn = 0;
let hanging = false;
let initialized = false;
const reply = () => {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply ' + turn + ' from ' + process.pid }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'reply ' + turn });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } });
    if (message.request.subtype === 'interrupt' && hanging) {
      hanging = false;
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' });
    }
    return;
  }
  const text = message.message.content;
  turn += 1;
  if (text.includes('hang')) { hanging = true; return; }
  if (!initialized) { initialized = true; emit({ type: 'system', subtype: 'init' }); }
  if (text.includes('crash')) process.exit(3);
  if (text.includes('slow')) setTimeout(reply, 400);
  else reply();
});
`;
}

/** Plays the previous Workbench runtime: runs one client session, then exits. */
function restartClientSource(): string {
  return `
import { openDatabase } from ${JSON.stringify(join(REPOSITORY_ROOT, 'src/server/database.ts'))};
import { ensureSession, sendTurn, submitTurn } from ${JSON.stringify(join(REPOSITORY_ROOT, 'src/server/agent-session.ts'))};
const [databasePath, conversationId, mode] = process.argv.slice(2);
const database = openDatabase(databasePath);
const session = await ensureSession(database, { conversationId, agent: 'claude', cwd: process.cwd() });
const first = await sendTurn(database, session, { prompt: 'one' });
const second = mode === 'submit' ? await submitTurn(database, session, { prompt: 'slow two' }) : null;
database.close();
console.log(JSON.stringify({ hostPid: session.hostPid, pid: session.pid, firstTurnId: first.turnId, second }));
`;
}

function processAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((wait) => setTimeout(wait, 25));
  }
}

function readEventsFile(path: string): AgentSessionEvent[] {
  const buffer = readFileSync(path);
  const events: AgentSessionEvent[] = [];
  let start = 0;
  for (let newline = buffer.indexOf(0x0a); newline >= 0; newline = buffer.indexOf(0x0a, start)) {
    events.push({ offset: start, endOffset: newline + 1, ...JSON.parse(buffer.subarray(start, newline).toString('utf8')) });
    start = newline + 1;
  }
  return events;
}

function assistantText(events: AgentSessionEvent[]): string {
  return events
    .filter((event) => event.source === 'provider' && (event.event as { type?: string })?.type === 'assistant')
    .map((event) => (event.event as { message: { content: Array<{ text: string }> } }).message.content[0].text)
    .join('\n');
}

describe('agent session host', () => {
  let root: string;
  let fakeDirectory: string;
  let spawnsPath: string;
  let databasePath: string;
  let database: WorkbenchDatabase;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  const spawns = (): Array<{ pid: number; args: string[] }> => existsSync(spawnsPath)
    ? readFileSync(spawnsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const session = (conversationId: string) => ensureSession(database, { conversationId, agent: 'claude', cwd: root });
  const row = (conversationId: string) => database.prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? AND agent = ?').get(conversationId, 'claude') as Record<string, unknown>;

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    root = mkdtempSync(join(tmpdir(), 'workbench-agent-session-'));
    spawnsPath = join(root, 'spawns.jsonl');
    const fakeClaude = join(root, 'fake-claude.mjs');
    writeFileSync(fakeClaude, fakeClaudeSource(spawnsPath));
    fakeDirectory = fakeAgentDirectory('exit 1', `exec "${process.execPath}" "${fakeClaude}" "$@"`).directory;
    process.env.CLAUDE_BIN = join(fakeDirectory, 'claude');
    process.env.WORKBENCH_AGENT_SESSIONS_DIR = join(root, 'agent-sessions');
    databasePath = join(root, 'workbench.db');
    database = openDatabase(databasePath);
  });

  afterEach(() => {
    const sessionsDirectory = join(root, 'agent-sessions');
    for (const conversationId of existsSync(sessionsDirectory) ? readdirSync(sessionsDirectory) : []) {
      const status = readAgentSessionStatus({ conversationId, agent: 'claude' });
      if (status && processAlive(status.hostPid)) process.kill(-status.hostPid, 'SIGKILL');
    }
    database.close();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeDirectory, { recursive: true, force: true });
  });

  it('runs three turns on one provider PID and records them on disk', async () => {
    const handle = await session('conversation-a');
    const results = [];
    for (const prompt of ['first', 'second', 'third']) results.push(await sendTurn(database, handle, { prompt }));

    expect(results.map((result) => result.status)).toEqual(['completed', 'completed', 'completed']);
    expect(spawns()).toHaveLength(1);
    const [{ pid, args }] = spawns();
    expect(results.map((result) => assistantText(result.events))).toEqual([`reply 1 from ${pid}`, `reply 2 from ${pid}`, `reply 3 from ${pid}`]);
    expect(args.slice(0, 4)).toEqual(['--session-id', handle.providerSessionId, '--permission-prompts', 'none']);

    const status = readAgentSessionStatus(handle)!;
    expect(status).toMatchObject({ pid, state: 'idle', currentTurnId: null, providerSessionId: handle.providerSessionId, providerSessionEstablished: true });
    expect(status.eventOffset).toBe(readFileSync(handle.eventsPath).length);
    expect(Date.parse(status.heartbeatAt)).not.toBeNaN();
    expect(row('conversation-a')).toMatchObject({ provider_session_id: handle.providerSessionId, state: 'idle', last_event_offset: results[2].nextOffset });
  });

  it('keeps the host and its provider alive across a server restart', async () => {
    const restartClient = join(root, 'restart-client.mts');
    writeFileSync(restartClient, restartClientSource());
    const previousRuntime = await new Promise<string>((resolveRun, rejectRun) => {
      execFile(process.execPath, ['--import', 'tsx', restartClient, databasePath, 'conversation-b', 'turn'], { cwd: REPOSITORY_ROOT, env: process.env, timeout: 20_000 }, (error, stdout, stderr) => {
        if (error) rejectRun(new Error(`${error.message}\n${stderr}`));
        else resolveRun(stdout);
      });
    });
    const before = JSON.parse(previousRuntime.trim().split('\n').at(-1)!) as { hostPid: number; pid: number };
    expect(processAlive(before.hostPid)).toBe(true);
    expect(processAlive(before.pid)).toBe(true);

    const [attached] = await reattachAll(database);
    expect(attached).toMatchObject({ conversationId: 'conversation-b', hostPid: before.hostPid, pid: before.pid, reused: true });
    const next = await sendTurn(database, attached, { prompt: 'after restart' });
    expect(next.status).toBe('completed');
    expect(assistantText(next.events)).toBe(`reply 2 from ${before.pid}`);
    expect(spawns()).toHaveLength(1);
  }, 30_000);

  it('resumes reading from the saved offset after a restart with no lost or duplicated events', async () => {
    const restartClient = join(root, 'restart-client.mts');
    writeFileSync(restartClient, restartClientSource());
    const previousRuntime = await new Promise<string>((resolveRun, rejectRun) => {
      execFile(process.execPath, ['--import', 'tsx', restartClient, databasePath, 'conversation-c', 'submit'], { cwd: REPOSITORY_ROOT, env: process.env, timeout: 20_000 }, (error, stdout, stderr) => {
        if (error) rejectRun(new Error(`${error.message}\n${stderr}`));
        else resolveRun(stdout);
      });
    });
    const before = JSON.parse(previousRuntime.trim().split('\n').at(-1)!) as { firstTurnId: string; second: { turnId: string; startOffset: number } };

    // The previous runtime consumed exactly through turn one's terminal record.
    const saved = row('conversation-c').last_event_offset as number;
    const firstTerminal = readEventsFile(join(root, 'agent-sessions', 'conversation-c', 'claude', 'events.jsonl'))
      .find((event) => event.type === 'turn_terminal' && event.turnId === before.firstTurnId)!;
    expect(saved).toBe(firstTerminal.endOffset);
    expect(saved).toBe(before.second.startOffset);

    const [attached] = await reattachAll(database);
    const delivered: AgentSessionEvent[] = [];
    const result = await awaitTurn(database, attached, { fromOffset: saved, turnId: before.second.turnId, onEvent: (event) => delivered.push(event) });
    expect(result.status).toBe('completed');
    expect(assistantText(result.events)).toMatch(/^reply 2 from /);

    const onDisk = readEventsFile(attached.eventsPath).filter((event) => event.offset >= saved && event.offset < result.nextOffset);
    expect(delivered.map((event) => event.offset)).toEqual(onDisk.map((event) => event.offset));
    expect(delivered[0].offset).toBe(saved);
    for (let index = 1; index < delivered.length; index += 1) expect(delivered[index].offset).toBe(delivered[index - 1].endOffset);
    expect(new Set(delivered.map((event) => event.offset)).size).toBe(delivered.length);
    expect(delivered.at(-1)).toMatchObject({ type: 'turn_terminal', status: 'completed' });
    expect(row('conversation-c').last_event_offset).toBe(result.nextOffset);
  }, 30_000);

  it('reads a turn as finished, active, or unsent from the log rather than from the host busy state', async () => {
    const handle = await session('conversation-log');
    const key = { conversationId: 'conversation-log', agent: 'claude' as const };
    const ours = (turnId: string) => turnId.startsWith('mine#');
    expect(resolveSessionTurnFromLog(key, ours, 0)).toEqual({ kind: 'unsent' });

    // Finished while nobody was reading: the host is idle, the log still has the terminal.
    const done = await sendTurn(database, handle, { prompt: 'one', turnId: 'mine#1' });
    expect(readAgentSessionStatus(key)?.state).toBe('idle');
    expect(resolveSessionTurnFromLog(key, ours, done.nextOffset)).toMatchObject({ kind: 'finished', turnId: 'mine#1', terminal: { type: 'turn_terminal', status: 'completed' } });
    expect(resolveSessionTurnFromLog(key, (turnId) => turnId === 'other#1', 0)).toEqual({ kind: 'unsent' });

    const accepted = await submitTurn(database, handle, { prompt: 'slow two', turnId: 'mine#2' });
    expect(resolveSessionTurnFromLog(key, ours, 0)).toEqual({ kind: 'active', turnId: 'mine#2', startOffset: accepted.startOffset });
    await awaitTurn(database, handle, { fromOffset: accepted.startOffset, turnId: 'mine#2' });
    expect(resolveSessionTurnFromLog(key, ours, 0)).toMatchObject({ kind: 'finished', turnId: 'mine#2' });
  }, 30_000);

  it('respawns a crashed CLI with --resume and keeps serving turns', async () => {
    const handle = await session('conversation-d');
    const crashed = await sendTurn(database, handle, { prompt: 'crash now' });
    expect(crashed).toMatchObject({ status: 'failed', reason: 'provider_exited' });

    await waitFor(() => spawns().length === 2);
    const [first, second] = spawns();
    expect(first.args.slice(0, 2)).toEqual(['--session-id', handle.providerSessionId]);
    expect(second.args.slice(0, 2)).toEqual(['--resume', handle.providerSessionId]);

    const after = await sendTurn(database, handle, { prompt: 'after respawn' });
    expect(after.status).toBe('completed');
    expect(assistantText(after.events)).toBe(`reply 1 from ${second.pid}`);
    expect(readAgentSessionStatus(handle)).toMatchObject({ pid: second.pid, respawns: 1, state: 'idle', hostPid: handle.hostPid });
  });

  it('interrupts a running turn and serves the next one on the same PID', async () => {
    const handle = await session('conversation-e');
    const accepted = await submitTurn(database, handle, { prompt: 'hang please' });
    await waitFor(() => readAgentSessionStatus(handle)?.state === 'turn');
    expect(await interrupt(handle)).toEqual({ interrupted: true });
    const interrupted = await awaitTurn(database, handle, { fromOffset: accepted.startOffset, turnId: accepted.turnId });
    expect(interrupted.status).toBe('interrupted');

    const next = await sendTurn(database, handle, { prompt: 'next' });
    expect(next.status).toBe('completed');
    expect(spawns()).toHaveLength(1);
  });

  it('fails a hung turn with the provider first-activity timeout', async () => {
    process.env.WORKBENCH_PROVIDER_FIRST_ACTIVITY_TIMEOUT_MS = '300';
    const handle = await session('conversation-f');
    const hung = await sendTurn(database, handle, { prompt: 'hang forever' });
    expect(hung).toMatchObject({ status: 'failed', reason: 'first_activity_timeout' });
    expect(hung.events.some((event) => event.type === 'turn_timeout')).toBe(true);
  });

  it('stops an idle session, keeps its provider session id, and resumes on the next message', async () => {
    process.env.WORKBENCH_AGENT_SESSION_IDLE_MS = '1500';
    const handle = await session('conversation-g');
    await sendTurn(database, handle, { prompt: 'before idle' });
    await waitFor(() => !processAlive(handle.hostPid), 8_000);
    expect(readAgentSessionStatus(handle)).toMatchObject({ state: 'stopped', stopReason: 'idle', providerSessionId: handle.providerSessionId });
    expect(row('conversation-g').provider_session_id).toBe(handle.providerSessionId);

    const resumed = await session('conversation-g');
    expect(resumed.reused).toBe(false);
    const after = await sendTurn(database, resumed, { prompt: 'after idle' });
    expect(after.status).toBe('completed');
    expect(spawns().map((spawned) => spawned.args.slice(0, 2))).toEqual([
      ['--session-id', handle.providerSessionId],
      ['--resume', handle.providerSessionId],
    ]);
  }, 15_000);

  it('rejects a request from another protocol version', async () => {
    const handle = await session('conversation-h');
    const response = await new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
      const socket = createConnection(handle.socketPath, () => socket.write(`${JSON.stringify({ v: 0, id: 7, type: 'status' })}\n`));
      socket.on('error', rejectResponse);
      socket.on('data', (chunk) => {
        socket.destroy();
        resolveResponse(JSON.parse(chunk.toString('utf8').split('\n')[0]));
      });
    });
    expect(response).toMatchObject({ v: 1, id: 7, ok: false, error: { code: 'protocol_mismatch', hostVersion: 1 } });
  });
});
