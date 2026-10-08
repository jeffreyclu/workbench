// Detached session host: keeps one provider CLI alive for one (conversation,
// agent) pair across Workbench server restarts. Started by agent-session.ts the
// same way managed-command.ts starts its worker: detached, unref'd, and
// observable only through files on disk and a Unix socket.
//
// Files (paths come from the spec written by the client):
// - events.jsonl: append-only. Every provider stdout line plus host lifecycle
//   records. Byte offsets are the cursor, so a reader that saved an offset
//   resumes with nothing lost or duplicated.
// - status.json: pid, provider session id, state, current turn, event offset,
//   heartbeat. Rewritten atomically.
//
// Socket requests are newline-delimited JSON carrying `v`. A host answers a
// request from any other protocol version with `protocol_mismatch`, so a newer
// runtime can detect an older host and replace it.
//
// MCP reconnect needs no handling here: the persistent-sessions spike showed
// both Claude and the Codex app-server reconnect to a restarted Workbench MCP
// server on their own (docs/persistent-sessions-spike.md).
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { clearInterval, clearTimeout, setImmediate, setInterval, setTimeout } from 'node:timers';

const PROTOCOL_VERSION = 1;
const RESPAWN_DELAY_MS = 200;
const RESPAWN_WINDOW_MS = 60_000;
const MAX_RESPAWNS_PER_WINDOW = 3;
const MAX_TAIL_WAIT_MS = 30_000;
const STOP_GRACE_MS = 2_000;

const [specPath] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const timeouts = spec.timeouts;
const now = () => new Date().toISOString();

const status = {
  protocolVersion: PROTOCOL_VERSION,
  conversationId: spec.conversationId,
  agent: spec.agent,
  hostPid: process.pid,
  pid: null,
  providerSessionId: spec.providerSessionId,
  providerSessionEstablished: Boolean(spec.resume && spec.providerSessionId),
  state: 'idle',
  currentTurnId: null,
  eventOffset: 0,
  socketPath: spec.socketPath,
  startedAt: now(),
  heartbeatAt: now(),
  stoppedAt: null,
  stopReason: null,
  respawns: 0,
};

function writeStatus() {
  status.heartbeatAt = now();
  status.eventOffset = eventOffset;
  const temporary = `${spec.statusPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(status, null, 2));
  renameSync(temporary, spec.statusPath);
}

// ---- Event log -------------------------------------------------------------

const eventsFd = openSync(spec.eventsPath, 'a');
let eventOffset = fstatSync(eventsFd).size;
// A previous host killed mid-write can leave a partial final line. Terminate it
// so the next record starts on its own line; readers skip unparsable lines.
if (eventOffset > 0) {
  const last = Buffer.alloc(1);
  const reader = openSync(spec.eventsPath, 'r');
  readSync(reader, last, 0, 1, eventOffset - 1);
  closeSync(reader);
  if (last[0] !== 0x0a) { writeSync(eventsFd, '\n'); eventOffset += 1; }
}
const tailWaiters = new Set();

function append(record) {
  const line = `${JSON.stringify({ at: now(), ...record })}\n`;
  writeSync(eventsFd, line);
  eventOffset += Buffer.byteLength(line);
  for (const wake of tailWaiters) wake();
  tailWaiters.clear();
}

function readEvents(offset, maxBytes) {
  const end = eventOffset;
  if (!Number.isInteger(offset) || offset < 0 || offset > end) throw hostError('bad_offset', `Offset ${offset} is outside the event log (0-${end}).`);
  if (offset === end) return { events: [], nextOffset: end };
  let length = Math.min(end - offset, maxBytes);
  let buffer;
  for (;;) {
    buffer = Buffer.alloc(length);
    const reader = openSync(spec.eventsPath, 'r');
    readSync(reader, buffer, 0, length, offset);
    closeSync(reader);
    // A single record larger than maxBytes still has to be returned whole.
    if (buffer.lastIndexOf(0x0a) >= 0 || length === end - offset) break;
    length = Math.min(end - offset, length * 2);
  }
  const events = [];
  let start = 0;
  for (let newline = buffer.indexOf(0x0a); newline >= 0; newline = buffer.indexOf(0x0a, start)) {
    const text = buffer.subarray(start, newline).toString('utf8');
    try { events.push({ offset: offset + start, endOffset: offset + newline + 1, ...JSON.parse(text) }); } catch { /* skip a torn line */ }
    start = newline + 1;
  }
  return { events, nextOffset: offset + start };
}

async function tail(offset, waitMs, maxBytes) {
  if (offset === eventOffset && waitMs > 0 && !stopping) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { tailWaiters.delete(wake); resolve(); }, Math.min(waitMs, MAX_TAIL_WAIT_MS));
      const wake = () => { clearTimeout(timer); resolve(); };
      tailWaiters.add(wake);
    });
  }
  return readEvents(offset, maxBytes ?? 4_000_000);
}

// ---- Provider process ------------------------------------------------------

let child = null;
let stdoutBuffer = '';
let stderrTail = '';
let stopping = false;
let currentTurn = null;
let currentModel = spec.model ?? null;
let codexReady = false;
let rpcId = 0;
const rpcHandlers = new Map();
const crashTimes = [];

function hostError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function writeChild(message) {
  if (!child || child.stdin.destroyed) return false;
  child.stdin.write(`${JSON.stringify(message)}\n`);
  return true;
}

function rpc(method, params, onResponse) {
  const id = ++rpcId;
  if (onResponse) rpcHandlers.set(id, onResponse);
  writeChild({ jsonrpc: '2.0', id, method, params });
}

function spawnProvider() {
  if (spec.provider === 'claude' && !status.providerSessionId) status.providerSessionId = randomUUID();
  const resume = Boolean(status.providerSessionEstablished && status.providerSessionId);
  // Claude takes a pre-assigned session id, so even a crash before its first
  // reply leaves an id Workbench already knows. Session flags go first because
  // commandFor ends with the variadic --add-dir.
  const sessionArgs = spec.provider === 'claude'
    ? (resume ? ['--resume', status.providerSessionId] : ['--session-id', status.providerSessionId])
    : [];
  const spawned = spawn(spec.launch.command, [...sessionArgs, ...spec.launch.args], {
    cwd: spec.cwd,
    env: process.env,
    // Not detached: the provider shares the host's process group, so stopping
    // the group can never orphan it.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = spawned;
  stdoutBuffer = '';
  stderrTail = '';
  codexReady = false;
  rpcHandlers.clear();
  status.pid = spawned.pid ?? null;
  spawned.stdin.on('error', () => { /* the close handler reports the exit */ });
  spawned.stdout.on('data', (chunk) => { if (spawned === child) onStdout(chunk.toString('utf8')); });
  spawned.stderr.on('data', (chunk) => {
    appendFileSync(spec.stderrPath, chunk);
    stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4_000);
  });
  spawned.once('error', (error) => {
    stderrTail = `${stderrTail}${error.message}`.slice(-4_000);
    onProviderExit(spawned, null, null);
  });
  spawned.once('close', (code, signal) => onProviderExit(spawned, code, signal));
  append({ source: 'host', type: 'provider_spawned', turnId: currentTurn?.id ?? null, pid: status.pid, resume, providerSessionId: status.providerSessionId });
  writeStatus();
  if (spec.provider === 'codex') bootstrapCodex(resume);
}

function bootstrapCodex(resume) {
  rpc('initialize', spec.codex.initializeParams, (response) => {
    if (response.error) return failProvider(`Codex initialize failed: ${response.error.message ?? 'unknown error'}`);
    writeChild({ jsonrpc: '2.0', method: 'initialized' });
    const start = () => rpc(spec.codex.threadStart.method, spec.codex.threadStart.params, onThread);
    const onThread = (thread) => {
      if (thread.error) return failProvider(`Codex ${spec.codex.threadStart.method} failed: ${thread.error.message ?? 'unknown error'}`);
      status.providerSessionId = thread.result?.thread?.id ?? status.providerSessionId;
      status.providerSessionEstablished = Boolean(status.providerSessionId);
      codexReady = true;
      writeStatus();
      if (currentTurn && !currentTurn.dispatched) startCodexTurn(currentTurn);
    };
    if (!resume) return start();
    rpc('thread/resume', { ...spec.codex.threadResumeParams, threadId: status.providerSessionId }, (resumed) => {
      if (!resumed.error) return onThread(resumed);
      append({ source: 'host', type: 'provider_session_reset', turnId: currentTurn?.id ?? null, previousProviderSessionId: status.providerSessionId, reason: resumed.error.message ?? null });
      status.providerSessionId = null;
      status.providerSessionEstablished = false;
      start();
    });
  });
}

function failProvider(message) {
  stderrTail = `${stderrTail}${message}`.slice(-4_000);
  appendFileSync(spec.stderrPath, `${message}\n`);
  if (child) child.kill('SIGTERM');
}

function onStdout(text) {
  stdoutBuffer += text;
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop() ?? '';
  for (const line of lines) if (line.trim()) onProviderLine(line);
}

function onProviderLine(line) {
  let event = null;
  try { event = JSON.parse(line); } catch { /* logged raw below */ }
  append({ source: 'provider', turnId: currentTurn?.id ?? null, ...(event === null ? { raw: line } : { event }) });
  if (currentTurn) watchdogActivity();
  if (!event || typeof event !== 'object') return;
  if (spec.provider === 'claude') onClaudeEvent(event);
  else onCodexEvent(event);
}

function onClaudeEvent(event) {
  if (!status.providerSessionEstablished && event.session_id && event.session_id === status.providerSessionId) {
    status.providerSessionEstablished = true;
    writeStatus();
  }
  if (event.type === 'result' && currentTurn) {
    finishTurn(currentTurn.interruptRequested ? 'interrupted' : event.is_error ? 'failed' : 'completed', event.is_error ? (event.subtype ?? null) : null);
  }
}

function onCodexEvent(event) {
  if (event.id !== undefined && !event.method && rpcHandlers.has(event.id)) {
    const handler = rpcHandlers.get(event.id);
    rpcHandlers.delete(event.id);
    handler(event);
    return;
  }
  if (!currentTurn) return;
  if (event.method === 'turn/started') currentTurn.providerTurnId = event.params?.turn?.id ?? currentTurn.providerTurnId;
  if (event.method === 'turn/completed') {
    const turnStatus = event.params?.turn?.status;
    finishTurn(turnStatus === 'interrupted' ? 'interrupted' : turnStatus === 'completed' ? 'completed' : 'failed', turnStatus === 'failed' ? (event.params?.turn?.error?.message ?? null) : null);
  }
}

function onProviderExit(proc, code, signal) {
  if (proc !== child) return;
  if (stdoutBuffer.trim()) onProviderLine(stdoutBuffer);
  child = null;
  status.pid = null;
  codexReady = false;
  rpcHandlers.clear();
  append({ source: 'host', type: 'provider_exited', turnId: currentTurn?.id ?? null, code, signal, stderrTail: stderrTail.slice(-1_000) || null });
  if (currentTurn) finishTurn(currentTurn.interruptRequested && !currentTurn.timeoutReason ? 'interrupted' : 'failed', 'provider_exited');
  if (stopping) return finalizeStop();
  if (spec.provider === 'claude' && /no conversation found with session id/i.test(stderrTail)) {
    append({ source: 'host', type: 'provider_session_reset', turnId: null, previousProviderSessionId: status.providerSessionId, reason: 'missing_provider_session' });
    status.providerSessionId = randomUUID();
    status.providerSessionEstablished = false;
  }
  if (!proc.killedByHost) {
    const cutoff = Date.now() - RESPAWN_WINDOW_MS;
    crashTimes.push(Date.now());
    while (crashTimes.length && crashTimes[0] < cutoff) crashTimes.shift();
    if (crashTimes.length > MAX_RESPAWNS_PER_WINDOW) {
      append({ source: 'host', type: 'respawn_limit', turnId: null, crashes: crashTimes.length, windowMs: RESPAWN_WINDOW_MS });
      return shutdown('crash_loop');
    }
  }
  status.respawns += 1;
  writeStatus();
  // Respawn with --resume / thread/resume so the conversation keeps its context.
  setTimeout(() => { if (!stopping && !child) spawnProvider(); }, RESPAWN_DELAY_MS);
}

// ---- Turns -----------------------------------------------------------------

// Mirrors ProviderTurnWatchdog (provider-turn-watchdog.ts): the first-activity
// window opens when a turn is accepted, and every provider line re-arms the
// idle window. The client passes providerTurnTimeouts() in the spec.
let watchdogTimer = null;
let interruptTimer = null;
let idleStopTimer = null;

function armWatchdog(reason, delayMs) {
  clearTimeout(watchdogTimer);
  watchdogTimer = null;
  if (!currentTurn || !Number.isFinite(delayMs) || delayMs <= 0) return;
  const turn = currentTurn;
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null;
    if (currentTurn !== turn) return;
    turn.timeoutReason = reason;
    append({ source: 'host', type: 'turn_timeout', turnId: turn.id, reason });
    interrupt(`${reason}_timeout`);
  }, delayMs);
}

function watchdogActivity() {
  if (!currentTurn?.timeoutReason) armWatchdog('idle_activity', timeouts.idleActivityMs);
}

function armIdleStop() {
  clearTimeout(idleStopTimer);
  idleStopTimer = null;
  if (stopping || currentTurn || !(timeouts.idleStopMs > 0)) return;
  idleStopTimer = setTimeout(() => shutdown('idle'), timeouts.idleStopMs);
}

function sendTurn(request) {
  if (stopping) throw hostError('stopped', 'The session host is stopping.');
  if (currentTurn) throw hostError('busy', `Turn ${currentTurn.id} is still running.`);
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw hostError('bad_request', 'send-turn requires a prompt.');
  const turn = {
    id: typeof request.turnId === 'string' && request.turnId ? request.turnId : randomUUID(),
    prompt: request.prompt,
    model: request.model ?? null,
    effort: request.effort ?? null,
    cwd: request.cwd ?? null,
    providerTurnId: null,
    dispatched: false,
    interruptRequested: false,
    timeoutReason: null,
  };
  const startOffset = eventOffset;
  clearTimeout(idleStopTimer);
  currentTurn = turn;
  status.state = 'turn';
  status.currentTurnId = turn.id;
  append({ source: 'host', type: 'turn_started', turnId: turn.id, prompt: turn.prompt, model: turn.model, effort: turn.effort, cwd: turn.cwd });
  armWatchdog('first_activity', timeouts.firstActivityMs);
  if (!child) spawnProvider();
  if (spec.provider === 'claude') startClaudeTurn(turn);
  else if (codexReady) startCodexTurn(turn);
  writeStatus();
  return { turnId: turn.id, startOffset };
}

function startClaudeTurn(turn) {
  // Claude's cwd is fixed at process start; only the model can change per turn.
  if (turn.model && turn.model !== currentModel) {
    writeChild({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'set_model', model: turn.model } });
    currentModel = turn.model;
  }
  writeChild({ type: 'user', message: { role: 'user', content: turn.prompt } });
  turn.dispatched = true;
}

function startCodexTurn(turn) {
  turn.dispatched = true;
  const params = {
    ...spec.codex.turnStartTemplate,
    threadId: status.providerSessionId,
    input: [{ type: 'text', text: turn.prompt, text_elements: [] }],
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.effort ? { effort: turn.effort } : {}),
    ...(turn.cwd ? { cwd: turn.cwd } : {}),
  };
  rpc('turn/start', params, (response) => {
    if (currentTurn !== turn) return;
    if (response.error) return finishTurn('failed', response.error.message ?? 'turn/start failed');
    turn.providerTurnId = turn.providerTurnId ?? response.result?.turn?.id ?? null;
  });
}

function finishTurn(turnStatus, reason) {
  const turn = currentTurn;
  if (!turn) return;
  currentTurn = null;
  clearTimeout(watchdogTimer);
  clearTimeout(interruptTimer);
  watchdogTimer = null;
  interruptTimer = null;
  const timedOut = Boolean(turn.timeoutReason);
  append({
    source: 'host',
    type: 'turn_terminal',
    turnId: turn.id,
    status: timedOut ? 'failed' : turnStatus,
    reason: timedOut ? `${turn.timeoutReason}_timeout` : reason ?? null,
  });
  status.state = stopping ? 'stopped' : 'idle';
  status.currentTurnId = null;
  writeStatus();
  armIdleStop();
}

function interrupt(reason) {
  const turn = currentTurn;
  if (!turn) return { interrupted: false };
  turn.interruptRequested = true;
  append({ source: 'host', type: 'interrupt_requested', turnId: turn.id, reason });
  if (!turn.dispatched) {
    finishTurn('interrupted', reason);
    return { interrupted: true };
  }
  if (spec.provider === 'claude') {
    writeChild({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  } else if (turn.providerTurnId) {
    rpc('turn/interrupt', { threadId: status.providerSessionId, turnId: turn.providerTurnId });
  }
  // A provider that ignores the interrupt is restarted; the respawn resumes
  // the same provider session.
  clearTimeout(interruptTimer);
  interruptTimer = setTimeout(() => {
    if (currentTurn !== turn) return;
    finishTurn('interrupted', 'interrupt_unacknowledged');
    if (child) { child.killedByHost = true; child.kill('SIGTERM'); }
  }, timeouts.interruptGraceMs);
  return { interrupted: true };
}

// ---- Lifecycle -------------------------------------------------------------

let stopReason = null;

function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  stopReason = reason;
  clearTimeout(idleStopTimer);
  if (currentTurn) finishTurn('interrupted', `session_${reason}`);
  if (!child) return finalizeStop();
  const proc = child;
  proc.killedByHost = true;
  // Closing stdin lets the CLI flush and exit on its own before a signal.
  proc.stdin.end();
  setTimeout(() => { if (child === proc) proc.kill('SIGTERM'); }, STOP_GRACE_MS).unref();
  setTimeout(() => { if (child === proc) proc.kill('SIGKILL'); }, STOP_GRACE_MS * 2).unref();
}

let finalized = false;
function finalizeStop() {
  if (finalized) return;
  finalized = true;
  clearInterval(heartbeat);
  append({ source: 'host', type: 'stopped', turnId: null, reason: stopReason });
  status.state = 'stopped';
  status.stopReason = stopReason;
  status.stoppedAt = now();
  status.pid = null;
  status.currentTurnId = null;
  writeStatus();
  for (const wake of tailWaiters) wake();
  server.close();
  for (const socket of connections) socket.end();
  try { unlinkSync(spec.socketPath); } catch { /* already removed */ }
  closeSync(eventsFd);
  setTimeout(() => process.exit(0), 50);
}

// ---- Socket ----------------------------------------------------------------

const connections = new Set();

function respond(socket, id, payload) {
  if (!socket.destroyed) socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id: id ?? null, ...payload })}\n`);
}

async function handle(socket, line) {
  let message;
  try { message = JSON.parse(line); } catch {
    return respond(socket, null, { ok: false, error: { code: 'bad_request', message: 'Request is not JSON.' } });
  }
  if (message.v !== PROTOCOL_VERSION) {
    return respond(socket, message.id, { ok: false, error: { code: 'protocol_mismatch', message: `Session host speaks protocol ${PROTOCOL_VERSION}; request used ${message.v}.`, hostVersion: PROTOCOL_VERSION } });
  }
  try {
    let result;
    switch (message.type) {
      case 'status': result = { ...status, eventOffset }; break;
      case 'send-turn': result = sendTurn(message); break;
      case 'interrupt': result = interrupt('requested'); break;
      case 'stop':
        respond(socket, message.id, { ok: true, result: { stopping: true } });
        setImmediate(() => shutdown('requested'));
        return;
      case 'tail': result = await tail(message.offset ?? 0, message.waitMs ?? 0, message.maxBytes); break;
      default: throw hostError('bad_request', `Unknown request type ${message.type}.`);
    }
    respond(socket, message.id, { ok: true, result });
  } catch (error) {
    respond(socket, message.id, { ok: false, error: { code: error.code ?? 'host_error', message: error.message } });
  }
}

const server = createServer((socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
  socket.on('error', () => { /* the client went away */ });
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) void handle(socket, line);
  });
});

process.once('SIGTERM', () => shutdown('signal'));
process.once('SIGINT', () => shutdown('signal'));
process.on('SIGHUP', () => { /* detached: a closing terminal is not a stop */ });
process.on('uncaughtException', (error) => {
  try { appendFileSync(spec.stderrPath, `[session-host] ${error.stack ?? error.message}\n`); } catch { /* best effort */ }
  status.state = 'stopped';
  status.stopReason = 'host_error';
  status.stoppedAt = now();
  try { writeStatus(); } catch { /* best effort */ }
  process.exit(1);
});

writeStatus();
const heartbeat = setInterval(writeStatus, timeouts.heartbeatMs);
try { unlinkSync(spec.socketPath); } catch { /* no stale socket */ }
server.listen(spec.socketPath, () => {
  chmodSync(spec.socketPath, 0o600);
  spawnProvider();
  armIdleStop();
});
