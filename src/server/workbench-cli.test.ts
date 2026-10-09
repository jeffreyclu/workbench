import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, readToken, runLauncher, type LauncherIo, type LauncherOptions } from '../../scripts/workbench-cli.js';
import { ensureSession, interrupt, readAgentSessionStatus, submitTurn } from './agent-session.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { fakeAgentDirectory } from './test-fake-agent.js';

const ENV_KEYS = ['PATH', 'CLAUDE_BIN', 'WORKBENCH_AGENT_SESSIONS_DIR'] as const;

/** Streams three text deltas 150ms apart before it finishes; "hang" stays silent until interrupted. */
function fakeClaudeSource(spawnsPath: string): string {
  return `
import { appendFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(spawnsPath)}, JSON.stringify({ pid: process.pid, args }) + '\\n');
const emit = (event) => writeSync(1, JSON.stringify(event) + '\\n');
const delta = (text) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
let hanging = false;
let initialized = false;
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
  if (!initialized) { initialized = true; emit({ type: 'system', subtype: 'init' }); }
  if (message.message.content.includes('hang')) { hanging = true; delta('thinking '); return; }
  const parts = ['Hello ', 'from ', 'pid ' + process.pid + '.'];
  parts.forEach((part, index) => setTimeout(() => delta(part), 150 * (index + 1)));
  setTimeout(() => {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: parts.join('') }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: parts.join('') });
  }, 150 * (parts.length + 1));
});
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

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((wait) => setTimeout(wait, 20));
  }
}

describe('workbench launcher', () => {
  let root: string;
  let fakeDirectory: string;
  let spawnsPath: string;
  let database: WorkbenchDatabase;
  let options: LauncherOptions;
  let output: string;
  let input: PassThrough;
  let interruptListeners: Array<() => void>;
  let apiCalls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  const spawns = (): Array<{ pid: number }> => existsSync(spawnsPath)
    ? readFileSync(spawnsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const posted = () => apiCalls.filter((call) => call.method === 'POST' && call.path === '/api/shared/messages');
  const conversationId = () => (database.prepare('SELECT id FROM shared_conversations').all() as Array<{ id: string }>)[0].id;

  /** Stands in for the Workbench server: the same ensureSession + submitTurn the shared room runs on a dispatch. */
  function fakeServer(): LauncherIo['api'] {
    return async (method, path, body) => {
      const record = body as Record<string, unknown> | undefined;
      apiCalls.push({ method, path, body: record });
      if (path === '/api/health') return { ok: true };
      if (path === '/api/shared/conversations') {
        const id = randomUUID();
        database.prepare("INSERT INTO shared_conversations (id, title, created_at, updated_at) VALUES (?, ?, '2026-10-09', '2026-10-09')").run(id, String(record!.title));
        return { conversation: { id } };
      }
      const key = { conversationId: String(record?.conversationId ?? ''), agent: 'claude' as const };
      if (path === '/api/shared/messages') {
        const cwd = (database.prepare('SELECT workspace_path FROM shared_conversation_workspace_selection WHERE conversation_id = ?').get(key.conversationId) as { workspace_path: string }).workspace_path;
        const session = await ensureSession(database, { ...key, cwd });
        const replyId = randomUUID();
        await submitTurn(database, session, { prompt: String(record!.body), turnId: `${replyId}#1` });
        return { message: { id: randomUUID() }, replies: [{ id: replyId }] };
      }
      if (path.endsWith('/cancel')) {
        const status = readAgentSessionStatus({ conversationId: (database.prepare('SELECT conversation_id FROM agent_sessions').get() as { conversation_id: string }).conversation_id, agent: 'claude' })!;
        await interrupt({ socketPath: status.socketPath });
        return { message: { status: 'canceled' } };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    };
  }

  const io = (): LauncherIo => ({
    stdout: { write: (value) => { output += String(value); return true; } },
    stderr: { write: (value) => { output += `[stderr] ${String(value)}`; return true; } },
    input,
    onInterrupt: (listener) => {
      interruptListeners.push(listener);
      return () => { interruptListeners = interruptListeners.filter((candidate) => candidate !== listener); };
    },
    api: fakeServer(),
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    root = mkdtempSync(join(tmpdir(), 'workbench-cli-'));
    spawnsPath = join(root, 'spawns.jsonl');
    const fakeClaude = join(root, 'fake-claude.mjs');
    writeFileSync(fakeClaude, fakeClaudeSource(spawnsPath));
    fakeDirectory = fakeAgentDirectory('exit 1', `exec "${process.execPath}" "${fakeClaude}" "$@"`).directory;
    process.env.CLAUDE_BIN = join(fakeDirectory, 'claude');
    process.env.WORKBENCH_AGENT_SESSIONS_DIR = join(root, 'agent-sessions');
    mkdirSync(join(root, 'project'));
    database = openDatabase(join(root, 'workbench.db'));
    options = { agent: 'claude', cwd: join(root, 'project'), baseUrl: 'http://127.0.0.1:1', token: null, databasePath: join(root, 'workbench.db'), conversationId: null, forceNew: false, title: null, accountProfile: null };
    output = '';
    input = new PassThrough();
    interruptListeners = [];
    apiCalls = [];
  });

  afterEach(() => {
    const sessionsDirectory = join(root, 'agent-sessions');
    for (const id of existsSync(sessionsDirectory) ? readdirSync(sessionsDirectory) : []) {
      const status = readAgentSessionStatus({ conversationId: id, agent: 'claude' });
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

  it('posts each typed line as a Jeffrey message on one session and renders the partial text before the turn ends', async () => {
    const running = runLauncher(options, io());
    input.write('say hello slowly\n');
    await waitFor(() => output.includes('Hello '));
    // The first delta is on screen while the turn has no terminal record yet.
    expect(output).not.toContain('turn completed');
    await waitFor(() => output.split('turn completed').length === 2);
    input.write('and once more\n');
    await waitFor(() => output.split('turn completed').length === 3);
    input.end();
    await running;

    expect(posted().map((call) => call.body)).toEqual([
      { conversationId: conversationId(), body: 'say hello slowly', dispatchTo: 'claude' },
      { conversationId: conversationId(), body: 'and once more', dispatchTo: 'claude' },
    ]);
    expect(apiCalls.find((call) => call.path === '/api/shared/conversations')?.body).toEqual({ title: 'say hello slowly' });
    expect(database.prepare('SELECT workspace_path FROM shared_conversation_workspace_selection').get()).toMatchObject({ workspace_path: options.cwd });
    expect(database.prepare('SELECT cwd FROM agent_sessions').get()).toMatchObject({ cwd: options.cwd });

    const [{ pid }] = spawns();
    expect(spawns()).toHaveLength(1);
    expect(output.match(new RegExp(`Hello from pid ${pid}\\.`, 'g'))).toHaveLength(2);
    expect(output).toContain(`Hello from pid ${pid}.\n■ turn completed\n`);
    expect(output).toContain('> say hello slowly\n');
    expect(output).toContain('> and once more\n');
    expect(output).toContain('Detached.');
  });

  it('maps Ctrl-C to a turn interrupt, then detaches without stopping the session', async () => {
    const running = runLauncher(options, io());
    input.write('please hang\n');
    await waitFor(() => output.includes('> please hang') && interruptListeners.length > 0);

    interruptListeners[0]();
    await waitFor(() => output.includes('turn interrupted'));
    const cancel = apiCalls.find((call) => call.path.endsWith('/cancel'));
    expect(cancel?.method).toBe('POST');
    expect(cancel?.path).toMatch(/^\/api\/shared\/messages\/[0-9a-f-]{36}\/cancel$/);

    interruptListeners[0]();
    await running;
    const status = readAgentSessionStatus({ conversationId: conversationId(), agent: 'claude' })!;
    expect(status.state).toBe('idle');
    expect(processAlive(status.hostPid)).toBe(true);
    expect(processAlive(status.pid)).toBe(true);
    expect(spawns()).toHaveLength(1);
  });

  it('resumes the newest conversation for this directory and agent instead of creating another', async () => {
    const first = runLauncher(options, io());
    input.write('first\n');
    await waitFor(() => output.includes('turn completed'));
    input.end();
    await first;

    output = '';
    apiCalls = [];
    input = new PassThrough();
    const second = runLauncher(options, io());
    await waitFor(() => output.includes('Resuming claude conversation "first"'));
    input.write('again\n');
    await waitFor(() => output.includes('turn completed'));
    input.end();
    await second;

    expect(apiCalls.some((call) => call.path === '/api/shared/conversations')).toBe(false);
    expect(output).not.toContain('> first');
    expect(spawns()).toHaveLength(1);
  });
});

describe('workbench launcher arguments', () => {
  it('parses the agent and flags, and rejects anything else', () => {
    const env = { WORKBENCH_URL: 'http://127.0.0.1:9999/', WORKBENCH_TOKEN: 'secret', DATABASE_PATH: '/tmp/wb.db' };
    expect(parseArgs(['codex', '--new', '--title', 'T', '--account', 'work'], env)).toMatchObject({
      agent: 'codex', forceNew: true, title: 'T', accountProfile: 'work', baseUrl: 'http://127.0.0.1:9999', token: 'secret', databasePath: '/tmp/wb.db',
    });
    expect(() => parseArgs(['gemini'], env)).toThrow('Usage');
    expect(() => parseArgs(['claude', '--bogus'], env)).toThrow('Unknown argument');
  });

  it('uses the directory npm was invoked from, not the package root', () => {
    expect(parseArgs(['claude'], { npm_lifecycle_event: 'wb', INIT_CWD: '/work/repo' }).cwd).toBe('/work/repo');
    expect(parseArgs(['claude'], { INIT_CWD: '/work/repo' }).cwd).toBe(process.cwd());
    expect(parseArgs(['claude'], { WORKBENCH_LAUNCH_CWD: '/work/other', npm_lifecycle_event: 'wb', INIT_CWD: '/work/repo' }).cwd).toBe('/work/other');
  });

  it('reads the token from the environment first, then the checkout .env', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-cli-token-'));
    writeFileSync(join(directory, '.env'), 'PORT=1\nWORKBENCH_TOKEN="from-file"\n');
    expect(readToken({}, directory)).toBe('from-file');
    expect(readToken({ WORKBENCH_TOKEN: 'from-env' }, directory)).toBe('from-env');
    expect(readToken({}, join(directory, 'missing'))).toBeNull();
    rmSync(directory, { recursive: true, force: true });
  });
});
