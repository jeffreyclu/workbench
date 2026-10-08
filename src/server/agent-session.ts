import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACCOUNT_PROFILE } from '../shared/contracts.js';
import { agentEnvironmentForWorkspace, commandFor, type CliAgent, type ExecutionProfile } from './agent-runner.js';
import type { ExternalActionProcessGuard } from './external-action-command-guard.js';
import type { WorkbenchDatabase } from './database.js';
import { providerTurnTimeouts } from './provider-turn-watchdog.js';
import { codexAppServerInitialRequest, codexAppServerLaunch, codexThreadBootstrapRequest, codexTurnStartParams } from './shared-room.js';

/** Must match PROTOCOL_VERSION in agent-session-host.mjs. */
export const AGENT_SESSION_PROTOCOL_VERSION = 1;

export type AgentSessionState = 'idle' | 'turn' | 'stopped';
export type AgentTurnStatus = 'completed' | 'interrupted' | 'failed';

/** status.json, written by the host. */
export interface AgentSessionStatus {
  protocolVersion: number;
  conversationId: string;
  agent: CliAgent;
  hostPid: number;
  /** The provider CLI's PID; null between a crash and its respawn. */
  pid: number | null;
  providerSessionId: string | null;
  providerSessionEstablished: boolean;
  state: AgentSessionState;
  currentTurnId: string | null;
  eventOffset: number;
  socketPath: string;
  startedAt: string;
  heartbeatAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  respawns: number;
}

/** One events.jsonl record with its byte range in the file. */
export interface AgentSessionEvent {
  offset: number;
  endOffset: number;
  at: string;
  source: 'provider' | 'host';
  turnId: string | null;
  type?: string;
  event?: unknown;
  raw?: string;
  status?: AgentTurnStatus;
  reason?: string | null;
  [key: string]: unknown;
}

export interface AgentSessionKey {
  conversationId: string;
  agent: CliAgent;
}

export interface EnsureAgentSessionInput extends AgentSessionKey {
  cwd: string;
  accountProfile?: string;
  profile?: ExecutionProfile;
  model?: string | null;
  /** Persona and runner contract, sent once at session start (Claude --append-system-prompt, Codex developerInstructions). */
  systemPrompt?: string;
}

export interface AgentSessionHandle extends AgentSessionKey {
  directory: string;
  statusPath: string;
  eventsPath: string;
  socketPath: string;
  hostPid: number;
  pid: number | null;
  providerSessionId: string | null;
  /** True when an already-running host was reused. */
  reused: boolean;
}

export interface AgentTurnInput {
  prompt: string;
  turnId?: string;
  model?: string;
  effort?: string;
  cwd?: string;
}

export interface AgentTurnResult {
  turnId: string;
  status: AgentTurnStatus;
  reason: string | null;
  events: AgentSessionEvent[];
  /** Offset just past the turn's terminal record; also saved as last_event_offset. */
  nextOffset: number;
}

export class AgentSessionHostError extends Error {
  constructor(readonly code: string, message: string, readonly hostVersion?: number) {
    super(message);
    this.name = 'AgentSessionHostError';
  }
}

const HOST_PATH = fileURLToPath(new URL('./agent-session-host.mjs', import.meta.url));
const HOST_READY_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TAIL_WAIT_MS = 5_000;
/** One file read never exceeds this, so a long session streams in chunks instead of one huge frame. */
const MAX_FILE_READ_BYTES = 512 * 1024;

function configuredMs(name: string, fallback: number): number {
  const configured = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

function sessionsRoot(): string {
  const configured = process.env.WORKBENCH_AGENT_SESSIONS_DIR?.trim();
  if (configured) return resolve(configured);
  const databasePath = resolve(process.env.DATABASE_PATH?.trim() || './data/workbench.db');
  return join(dirname(databasePath), 'agent-sessions');
}

function pathsFor(key: AgentSessionKey) {
  if (!/^[A-Za-z0-9_-]+$/.test(key.conversationId)) throw new Error(`Invalid conversation id for an agent session: ${key.conversationId}`);
  if (key.agent !== 'claude' && key.agent !== 'codex') throw new Error(`Unsupported session agent: ${String(key.agent)}`);
  const directory = join(sessionsRoot(), key.conversationId, key.agent);
  return {
    directory,
    specPath: join(directory, 'spec.json'),
    statusPath: join(directory, 'status.json'),
    eventsPath: join(directory, 'events.jsonl'),
    stderrPath: join(directory, 'stderr.log'),
    // Unix socket paths are capped near 104 bytes, which a worktree data
    // directory already exceeds, so the socket lives under the temp directory.
    capabilityPath: join(directory, 'capability.json'),
    refusalsPath: join(directory, 'refusals.jsonl'),
    socketPath: join(tmpdir(), `wb-session-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}.sock`),
  };
}

/**
 * The session's external-action guard. The provider keeps one environment for
 * its whole life, so the capability file lives at a path that never changes;
 * each turn rewrites its contents (writeTurnCapability) and clears them after.
 */
export function sessionExternalActionGuard(key: AgentSessionKey): ExternalActionProcessGuard {
  const paths = pathsFor(key);
  mkdirSync(paths.directory, { recursive: true });
  if (!existsSync(paths.capabilityPath)) writeFileSync(paths.capabilityPath, '{}', { mode: 0o600 });
  if (!existsSync(paths.refusalsPath)) writeFileSync(paths.refusalsPath, '', { mode: 0o600 });
  return { capability: {}, capabilityFile: paths.capabilityPath, eventFile: paths.refusalsPath };
}

export function readAgentSessionStatus(key: AgentSessionKey): AgentSessionStatus | null {
  try {
    return JSON.parse(readFileSync(pathsFor(key).statusPath, 'utf8')) as AgentSessionStatus;
  } catch {
    return null;
  }
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

// ---- Socket protocol -------------------------------------------------------

function hostRequest<T>(socketPath: string, message: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(socketPath);
    let buffered = '';
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(value as T);
    };
    const timer = setTimeout(() => finish(new AgentSessionHostError('timeout', `Session host did not answer ${String(message.type)} within ${timeoutMs}ms.`)), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: AGENT_SESSION_PROTOCOL_VERSION, id: 1, ...message })}\n`));
    socket.on('error', (error) => finish(new AgentSessionHostError('unreachable', error.message)));
    socket.on('close', () => finish(new AgentSessionHostError('unreachable', 'Session host closed the connection without answering.')));
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffered.slice(0, newline)) as { v?: number; ok: boolean; result?: T; error?: { code: string; message: string; hostVersion?: number } };
        if (response.ok && response.v === AGENT_SESSION_PROTOCOL_VERSION) return finish(null, response.result);
        if (response.ok) return finish(new AgentSessionHostError('protocol_mismatch', `Session host answered with protocol ${String(response.v)}.`, response.v));
        finish(new AgentSessionHostError(response.error?.code ?? 'host_error', response.error?.message ?? 'Session host request failed.', response.error?.hostVersion));
      } catch (error) {
        finish(error as Error);
      }
    });
  });
}

async function liveStatus(status: AgentSessionStatus | null): Promise<AgentSessionStatus | null> {
  if (!status || status.state === 'stopped' || !processAlive(status.hostPid)) return null;
  return hostRequest<AgentSessionStatus>(status.socketPath, { type: 'status' }, 2_000);
}

/** Stops a host whose socket cannot be trusted (dead, hung, or older protocol). */
async function killHost(status: AgentSessionStatus): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32') process.kill(-status.hostPid, signal);
      else process.kill(status.hostPid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signalGroup('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (processAlive(status.hostPid) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 50));
  if (processAlive(status.hostPid)) signalGroup('SIGKILL');
}

// ---- Database --------------------------------------------------------------

interface AgentSessionRow {
  conversation_id: string;
  agent: CliAgent;
  provider_session_id: string | null;
  account_profile: string;
  cwd: string;
  model: string | null;
  profile: ExecutionProfile;
  state: AgentSessionState;
  socket_path: string;
  last_event_offset: number;
  started_at: string;
  last_active_at: string;
}

function readRow(database: WorkbenchDatabase, key: AgentSessionKey): AgentSessionRow | undefined {
  return database.prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? AND agent = ?').get(key.conversationId, key.agent) as AgentSessionRow | undefined;
}

/** Provider session ids are written only once the provider has the session, so a resume never names one it lacks. */
function syncRow(database: WorkbenchDatabase, key: AgentSessionKey, status: AgentSessionStatus, extra: { lastEventOffset?: number; touch?: boolean } = {}): void {
  const providerSessionId = status.providerSessionEstablished ? status.providerSessionId : null;
  database.prepare(`
    UPDATE agent_sessions
    SET provider_session_id = COALESCE(?, provider_session_id),
        state = ?,
        socket_path = ?,
        last_event_offset = COALESCE(?, last_event_offset),
        last_active_at = CASE WHEN ? THEN ? ELSE last_active_at END
    WHERE conversation_id = ? AND agent = ?
  `).run(providerSessionId, status.state, status.socketPath, extra.lastEventOffset ?? null, extra.touch ? 1 : 0, new Date().toISOString(), key.conversationId, key.agent);
}

// ---- Host launch -----------------------------------------------------------

/** Appends the persona after the runner contract Claude already receives. */
function withSystemPrompt(args: string[], systemPrompt: string | undefined): string[] {
  const flag = args.indexOf('--append-system-prompt');
  if (!systemPrompt || flag < 0) return args;
  const next = [...args];
  next[flag + 1] = `${args[flag + 1]}\n\n${systemPrompt}`;
  return next;
}

function launchFor(input: EnsureAgentSessionInput, accountProfile: string, profile: ExecutionProfile) {
  const guard = sessionExternalActionGuard(input);
  if (input.agent === 'claude') {
    const { command, args } = commandFor('claude', input.cwd, profile, input.model ?? undefined);
    return {
      env: agentEnvironmentForWorkspace('claude', accountProfile, input.cwd, guard),
      // The host adds --session-id or --resume ahead of these.
      launch: { command, args: ['--permission-prompts', 'none', ...withSystemPrompt(args, input.systemPrompt)] },
      codex: null,
    };
  }
  const { command, args, env } = codexAppServerLaunch(input.cwd, accountProfile, guard);
  const developerInstructions = input.systemPrompt ? { developerInstructions: input.systemPrompt } : {};
  const { threadId: _threadId, ...threadResumeParams } = { ...codexThreadBootstrapRequest(input.cwd, 'resume').params, ...developerInstructions } as Record<string, unknown>;
  const { threadId: _turnThreadId, input: _input, ...turnStartTemplate } = codexTurnStartParams('', input.cwd, '');
  return {
    env,
    launch: { command, args },
    codex: {
      initializeParams: codexAppServerInitialRequest(input.cwd, null, false).params,
      threadStart: (() => {
        const start = codexThreadBootstrapRequest(input.cwd);
        return { ...start, params: { ...start.params, ...developerInstructions } };
      })(),
      threadResumeParams,
      turnStartTemplate: { ...turnStartTemplate, ...(input.model ? { model: input.model } : {}) },
    },
  };
}

async function startHost(database: WorkbenchDatabase, input: EnsureAgentSessionInput, previous: AgentSessionStatus | null): Promise<AgentSessionStatus> {
  const paths = pathsFor(input);
  const accountProfile = input.accountProfile ?? DEFAULT_ACCOUNT_PROFILE;
  const profile = input.profile ?? 'standard';
  const row = readRow(database, input);
  // The database keeps the provider session across idle stops; status.json
  // covers a host that established one before the row was synced.
  const providerSessionId = row?.provider_session_id
    ?? (previous?.providerSessionEstablished ? previous.providerSessionId : null);
  const { env, launch, codex } = launchFor(input, accountProfile, profile);
  const spec = {
    conversationId: input.conversationId,
    agent: input.agent,
    provider: input.agent,
    cwd: input.cwd,
    model: input.model ?? null,
    providerSessionId,
    resume: Boolean(providerSessionId),
    socketPath: paths.socketPath,
    statusPath: paths.statusPath,
    eventsPath: paths.eventsPath,
    stderrPath: paths.stderrPath,
    launch,
    codex,
    timeouts: {
      ...providerTurnTimeouts(),
      idleStopMs: configuredMs('WORKBENCH_AGENT_SESSION_IDLE_MS', 30 * 60_000),
      interruptGraceMs: configuredMs('WORKBENCH_AGENT_SESSION_INTERRUPT_GRACE_MS', 10_000),
      steerSettleMs: configuredMs('WORKBENCH_AGENT_SESSION_STEER_SETTLE_MS', 1_500),
      heartbeatMs: configuredMs('WORKBENCH_AGENT_SESSION_HEARTBEAT_MS', 5_000),
    },
  };
  // The spec holds no credentials: the provider environment reaches the host
  // only through its process environment, never through a file.
  writeFileSync(paths.specPath, JSON.stringify(spec, null, 2), { mode: 0o600 });

  const startedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO agent_sessions (conversation_id, agent, provider_session_id, account_profile, cwd, model, profile, state, socket_path, last_event_offset, started_at, last_active_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?)
    ON CONFLICT (conversation_id, agent) DO UPDATE SET
      account_profile = excluded.account_profile,
      cwd = excluded.cwd,
      model = excluded.model,
      profile = excluded.profile,
      state = 'idle',
      socket_path = excluded.socket_path,
      started_at = excluded.started_at
  `).run(input.conversationId, input.agent, providerSessionId, accountProfile, input.cwd, input.model ?? null, profile, paths.socketPath, existsSync(paths.eventsPath) ? statSync(paths.eventsPath).size : 0, startedAt, startedAt);

  const host = spawn(process.execPath, [HOST_PATH, paths.specPath], {
    cwd: input.cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    host.once('spawn', resolveSpawn);
    host.once('error', rejectSpawn);
  });
  host.unref();

  const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const status = readAgentSessionStatus(input);
    if (status && status.hostPid === host.pid) {
      try {
        return await hostRequest<AgentSessionStatus>(status.socketPath, { type: 'status' }, 1_000);
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((wait) => setTimeout(wait, 25));
  }
  throw new Error(`Agent session host for ${input.conversationId}/${input.agent} did not become ready: ${lastError instanceof Error ? lastError.message : 'no status written'}`);
}

function handleFor(key: AgentSessionKey, status: AgentSessionStatus, reused: boolean): AgentSessionHandle {
  const paths = pathsFor(key);
  return {
    conversationId: key.conversationId,
    agent: key.agent,
    directory: paths.directory,
    statusPath: paths.statusPath,
    eventsPath: paths.eventsPath,
    socketPath: status.socketPath,
    hostPid: status.hostPid,
    pid: status.pid,
    providerSessionId: status.providerSessionId,
    reused,
  };
}

// ---- Public client ---------------------------------------------------------

/** Returns the live host for this (conversation, agent), starting or resuming one if needed. */
export async function ensureSession(database: WorkbenchDatabase, input: EnsureAgentSessionInput): Promise<AgentSessionHandle> {
  const paths = pathsFor(input);
  mkdirSync(paths.directory, { recursive: true });
  const previous = readAgentSessionStatus(input);
  try {
    const live = await liveStatus(previous);
    // Claude's cwd is fixed at process start, so a changed workspace binding
    // restarts the host; the provider session resumes in the new directory.
    if (live && readRow(database, input)?.cwd !== input.cwd && live.state !== 'turn') {
      await stopSession(database, { ...input, socketPath: live.socketPath });
    } else if (live) {
      syncRow(database, input, live);
      return handleFor(input, live, true);
    }
  } catch (error) {
    // An unreachable or older-protocol host is replaced; its provider session resumes.
    if (previous && processAlive(previous.hostPid)) await killHost(previous);
    if (!(error instanceof AgentSessionHostError)) throw error;
  }
  const started = await startHost(database, input, previous);
  syncRow(database, input, started);
  return handleFor(input, started, false);
}

/** Hands a turn to the host without waiting for it. Pair with awaitTurn. */
export async function submitTurn(database: WorkbenchDatabase, session: AgentSessionKey & { socketPath: string }, input: AgentTurnInput): Promise<{ turnId: string; startOffset: number }> {
  const accepted = await hostRequest<{ turnId: string; startOffset: number }>(session.socketPath, { type: 'send-turn', ...input });
  database.prepare("UPDATE agent_sessions SET state = 'turn', last_active_at = ? WHERE conversation_id = ? AND agent = ?")
    .run(new Date().toISOString(), session.conversationId, session.agent);
  return accepted;
}

/**
 * Reads events from `fromOffset` until `turnId` (or, without one, the next
 * turn) reaches its terminal record. Progress is saved as last_event_offset
 * after every batch, so a client that restarts resumes exactly where it stopped.
 */
export async function awaitTurn(
  database: WorkbenchDatabase,
  session: AgentSessionKey & { socketPath: string },
  options: { fromOffset: number; turnId?: string; onEvent?: (event: AgentSessionEvent) => void },
): Promise<AgentTurnResult> {
  let offset = options.fromOffset;
  let turnId = options.turnId ?? null;
  const events: AgentSessionEvent[] = [];
  for (;;) {
    const batch = await tail(session, offset, TAIL_WAIT_MS);
    let terminal: AgentSessionEvent | null = null;
    for (const event of batch.events) {
      if (!turnId && event.source === 'host' && event.type === 'turn_started' && event.turnId) turnId = event.turnId;
      if (!turnId || event.turnId !== turnId) continue;
      events.push(event);
      options.onEvent?.(event);
      if (event.source === 'host' && event.type === 'turn_terminal') {
        terminal = event;
        break;
      }
    }
    offset = terminal ? terminal.endOffset : batch.nextOffset;
    database.prepare('UPDATE agent_sessions SET last_event_offset = ? WHERE conversation_id = ? AND agent = ?')
      .run(offset, session.conversationId, session.agent);
    if (terminal && turnId) {
      const status = readAgentSessionStatus(session);
      if (status) syncRow(database, session, status, { touch: true });
      return { turnId, status: terminal.status ?? 'failed', reason: terminal.reason ?? null, events, nextOffset: offset };
    }
    if (batch.events.length === 0 && batch.hostGone) {
      throw new AgentSessionHostError('unreachable', `Session host for ${session.conversationId}/${session.agent} stopped before turn ${turnId ?? '(pending)'} finished.`);
    }
  }
}

/** Sends one turn and resolves on its terminal event. */
export async function sendTurn(
  database: WorkbenchDatabase,
  session: AgentSessionKey & { socketPath: string },
  input: AgentTurnInput,
  options: { onEvent?: (event: AgentSessionEvent) => void } = {},
): Promise<AgentTurnResult> {
  const accepted = await submitTurn(database, session, input);
  return awaitTurn(database, session, { fromOffset: accepted.startOffset, turnId: accepted.turnId, onEvent: options.onEvent });
}

export async function interrupt(session: { socketPath: string }): Promise<{ interrupted: boolean }> {
  return hostRequest(session.socketPath, { type: 'interrupt' });
}

/** Adds a user message to the running turn (stdin line for Claude, turn/steer for Codex). */
export async function steerTurn(session: { socketPath: string }, text: string): Promise<{ accepted: boolean; reason?: string }> {
  return hostRequest(session.socketPath, { type: 'steer', text });
}

/**
 * Ends the provider session so the next ensureSession starts a new one. Used
 * when a turn must not inherit the earlier transcript.
 */
export async function resetSession(database: WorkbenchDatabase, session: AgentSessionKey & { socketPath: string }): Promise<void> {
  await stopSession(database, session);
  database.prepare('UPDATE agent_sessions SET provider_session_id = NULL WHERE conversation_id = ? AND agent = ?').run(session.conversationId, session.agent);
  rmSync(pathsFor(session).statusPath, { force: true });
}

export async function stopSession(database: WorkbenchDatabase, session: AgentSessionKey & { socketPath: string }): Promise<void> {
  const status = readAgentSessionStatus(session);
  try {
    await hostRequest(session.socketPath, { type: 'stop' });
    const deadline = Date.now() + 10_000;
    while (status && processAlive(status.hostPid) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 50));
  } catch (error) {
    if (!(error instanceof AgentSessionHostError)) throw error;
  }
  if (status && processAlive(status.hostPid)) await killHost(status);
  const stopped = readAgentSessionStatus(session);
  if (stopped) syncRow(database, session, { ...stopped, state: 'stopped' });
}

/**
 * Events from `offset`, through the host when it is alive and from the file
 * when it is not. `hostGone` tells a waiting reader that no more will arrive.
 */
export async function tail(session: AgentSessionKey & { socketPath: string }, offset: number, waitMs = 0): Promise<{ events: AgentSessionEvent[]; nextOffset: number; hostGone: boolean }> {
  try {
    const result = await hostRequest<{ events: AgentSessionEvent[]; nextOffset: number }>(session.socketPath, { type: 'tail', offset, waitMs }, waitMs + REQUEST_TIMEOUT_MS);
    return { ...result, hostGone: false };
  } catch (error) {
    if (!(error instanceof AgentSessionHostError) || error.code !== 'unreachable') throw error;
    return { ...readEventsFromFile(pathsFor(session).eventsPath, offset), hostGone: true };
  }
}

/** Read-only view of the session log for the terminal panel and attach script: never touches the host. */
export function readSessionEventsFromFile(key: AgentSessionKey, offset: number): { events: AgentSessionEvent[]; nextOffset: number } {
  return readEventsFromFile(pathsFor(key).eventsPath, offset);
}

function readEventsFromFile(path: string, offset: number, limit = MAX_FILE_READ_BYTES): { events: AgentSessionEvent[]; nextOffset: number } {
  const size = existsSync(path) ? statSync(path).size : 0;
  if (offset >= size) return { events: [], nextOffset: Math.min(offset, size) };
  const buffer = Buffer.alloc(Math.min(size - offset, limit));
  const descriptor = openSync(path, 'r');
  try {
    readSync(descriptor, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(descriptor);
  }
  const events: AgentSessionEvent[] = [];
  let start = 0;
  for (let newline = buffer.indexOf(0x0a); newline >= 0; newline = buffer.indexOf(0x0a, start)) {
    try {
      events.push({ offset: offset + start, endOffset: offset + newline + 1, ...JSON.parse(buffer.subarray(start, newline).toString('utf8')) } as AgentSessionEvent);
    } catch { /* a torn line from a killed host */ }
    start = newline + 1;
  }
  // A single record larger than the chunk would otherwise stall the reader.
  if (start === 0 && buffer.length === limit && size - offset > limit) return readEventsFromFile(path, offset, limit * 4);
  return { events, nextOffset: offset + start };
}

/**
 * Boot-time recovery. Hosts outlive the server, so a new runtime adopts every
 * live one and marks the rest stopped. Their provider session ids stay, so the
 * next ensureSession resumes them.
 */
export async function reattachAll(database: WorkbenchDatabase): Promise<AgentSessionHandle[]> {
  const rows = database.prepare("SELECT conversation_id, agent FROM agent_sessions WHERE state != 'stopped'").all() as Array<Pick<AgentSessionRow, 'conversation_id' | 'agent'>>;
  const attached: AgentSessionHandle[] = [];
  for (const row of rows) {
    const key: AgentSessionKey = { conversationId: row.conversation_id, agent: row.agent };
    const status = readAgentSessionStatus(key);
    try {
      const live = await liveStatus(status);
      if (live) {
        syncRow(database, key, live);
        attached.push(handleFor(key, live, true));
        continue;
      }
    } catch {
      if (status && processAlive(status.hostPid)) await killHost(status);
    }
    if (status) syncRow(database, key, { ...status, state: 'stopped' });
    else database.prepare("UPDATE agent_sessions SET state = 'stopped' WHERE conversation_id = ? AND agent = ?").run(key.conversationId, key.agent);
  }
  return attached;
}
