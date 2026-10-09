import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interrupt, readAgentSessionStatus, readSessionEventsFromFile, type AgentSessionEvent, type AgentSessionKey } from '../src/server/agent-session.js';
import { terminalLinesFor } from '../src/server/agent-session-terminal.js';

type Agent = AgentSessionKey['agent'];

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://127.0.0.1:5180';
const POLL_MS = 100;
const USAGE = `Usage: workbench <claude|codex> [--new] [--conversation <id>] [--title <text>] [--account <profile>] [--url <http://host:port>]

Runs the agent through Workbench's session host. Typed lines are posted as Jeffrey messages;
the reply streams here and in the Workbench conversation.
Ctrl-C interrupts the current turn. A second Ctrl-C, Ctrl-C while idle, or "exit" detaches and leaves the session running.`;

export interface LauncherOptions {
  agent: Agent;
  cwd: string;
  baseUrl: string;
  token: string | null;
  databasePath: string;
  conversationId: string | null;
  forceNew: boolean;
  title: string | null;
  accountProfile: string | null;
}

export interface LauncherIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  input: Readable;
  /** Subscribes to a process-level interrupt (SIGINT); returns the unsubscribe. */
  onInterrupt(listener: () => void): () => void;
  api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  wait(ms: number): Promise<void>;
}

/** WORKBENCH_TOKEN from the environment, else from the checkout's .env (the file the runtime reads). */
export function readToken(env: NodeJS.ProcessEnv, root = REPOSITORY_ROOT): string | null {
  const fromEnv = env.WORKBENCH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return null;
  const line = readFileSync(envPath, 'utf8').split('\n').find((candidate) => /^\s*WORKBENCH_TOKEN\s*=/.test(candidate));
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  return value || null;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): LauncherOptions {
  const [agent, ...rest] = argv;
  if (agent !== 'claude' && agent !== 'codex') throw new Error(USAGE);
  const options: LauncherOptions = {
    agent,
    // The shim and `npm run wb` both run in the checkout; these name the directory the user typed it in.
    cwd: resolve(env.WORKBENCH_LAUNCH_CWD || (env.npm_lifecycle_event && env.INIT_CWD ? env.INIT_CWD : process.cwd())),
    baseUrl: (env.WORKBENCH_URL?.trim() || DEFAULT_URL).replace(/\/+$/, ''),
    token: readToken(env),
    databasePath: resolve(env.DATABASE_PATH?.trim() || join(REPOSITORY_ROOT, 'data/workbench.db')),
    conversationId: null,
    forceNew: false,
    title: null,
    accountProfile: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = () => {
      const next = rest[++index];
      if (!next) throw new Error(`${flag} needs a value.\n${USAGE}`);
      return next;
    };
    if (flag === '--new') options.forceNew = true;
    else if (flag === '--conversation') options.conversationId = value();
    else if (flag === '--title') options.title = value();
    else if (flag === '--account') options.accountProfile = value();
    else if (flag === '--url') options.baseUrl = value().replace(/\/+$/, '');
    else throw new Error(`Unknown argument ${flag}.\n${USAGE}`);
  }
  return options;
}

interface ConversationRow { id: string; title: string }

/** The newest live conversation whose session for this agent was started in this directory. */
function findConversation(database: DatabaseSync, options: LauncherOptions): ConversationRow | null {
  const row = options.conversationId
    ? database.prepare('SELECT id, title FROM shared_conversations WHERE id = ? AND deleted_at IS NULL').get(options.conversationId)
    : options.forceNew ? undefined : database.prepare(`
      SELECT conversations.id, conversations.title
      FROM agent_sessions sessions
      JOIN shared_conversations conversations ON conversations.id = sessions.conversation_id
      WHERE sessions.agent = ? AND sessions.cwd = ? AND conversations.archived_at IS NULL AND conversations.deleted_at IS NULL
      ORDER BY sessions.last_active_at DESC LIMIT 1
    `).get(options.agent, options.cwd);
  if (options.conversationId && !row) throw new Error(`No conversation ${options.conversationId}.`);
  return (row as ConversationRow | undefined) ?? null;
}

/**
 * Pins the conversation's working directory to the terminal's. The server reads
 * this row when it starts the session host, so the host (and the provider CLI)
 * runs where the terminal is. The Repo Explorer endpoint only accepts sibling
 * repositories of the server, so this writes the same row it does.
 */
function selectWorkspace(database: DatabaseSync, conversationId: string, cwd: string): void {
  database.prepare(`INSERT INTO shared_conversation_workspace_selection (conversation_id, workspace_path, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET workspace_path = excluded.workspace_path, updated_at = excluded.updated_at`)
    .run(conversationId, cwd, new Date().toISOString());
}

function firstPromptTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

export async function runLauncher(options: LauncherOptions, io: LauncherIo): Promise<void> {
  const { agent } = options;
  await io.api('GET', '/api/health').catch((error: unknown) => {
    throw new Error(`Workbench is not reachable at ${options.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const database = new DatabaseSync(options.databasePath);
  database.exec('PRAGMA busy_timeout = 5000');

  let key: AgentSessionKey | null = null;
  let offset = 0;
  let openTurnId: string | null = null;
  let interrupting = false;
  let midLine = false;
  let detached = false;
  let inputEnded = false;
  let unfinished = 0;

  const apply = (event: AgentSessionEvent) => {
    if (event.source !== 'host') return;
    if (event.type === 'turn_started') openTurnId = event.turnId;
    if (event.type === 'turn_terminal' && event.turnId === openTurnId) {
      openTurnId = null;
      interrupting = false;
    }
  };
  const attach = (conversationId: string, replay: boolean) => {
    key = { conversationId, agent };
    offset = 0;
    // Existing history is skipped, not replayed; only the open-turn state is recovered from it.
    if (!replay) return;
    for (;;) {
      const batch = readSessionEventsFromFile(key, offset);
      batch.events.forEach(apply);
      if (batch.nextOffset <= offset) break;
      offset = batch.nextOffset;
    }
  };

  const existing = findConversation(database, options);
  if (existing) {
    selectWorkspace(database, existing.id, options.cwd);
    attach(existing.id, true);
    io.stdout.write(`Resuming ${agent} conversation "${existing.title}" (${existing.id}) in ${options.cwd}\n`);
    if (openTurnId) io.stdout.write('A turn is already running; its output follows.\n');
  } else {
    io.stdout.write(`New ${agent} conversation in ${options.cwd} starts with your first prompt.\n`);
  }

  // The renderer follows streamed deltas with the finished assistant text; on a terminal that
  // would print the same answer twice, so a text line that repeats what just streamed is dropped.
  let streamed = '';
  const print = (kind: string, text: string) => {
    if (kind === 'delta') {
      streamed += text;
      io.stdout.write(text);
      midLine = !text.endsWith('\n');
      return;
    }
    const repeat = kind === 'text' && streamed.trim() !== '' && streamed.trim().endsWith(text.trim());
    streamed = '';
    if (repeat) return;
    if (midLine) io.stdout.write('\n');
    io.stdout.write(`${text}\n`);
    midLine = false;
  };

  // The host logs the whole prompt the server built (guardrails, context, transcript). The terminal
  // shows what was typed; a turn that did not come from this launcher gets its first line.
  const typed: string[] = [];
  const echoPrompt = (prompt: string) => {
    const mine = [...typed].reverse().find((text) => prompt.includes(text));
    if (mine) return `> ${mine}`;
    const first = prompt.split('\n', 1)[0];
    return `> ${first.length > 160 ? `${first.slice(0, 159)}\u2026` : first}`;
  };

  const pump = async () => {
    while (!detached) {
      if (key) {
        const batch = readSessionEventsFromFile(key, offset);
        for (const event of batch.events) {
          apply(event);
          if (event.source === 'host' && event.type === 'turn_started') {
            print('host', echoPrompt(String(event.prompt ?? '')));
            continue;
          }
          for (const line of terminalLinesFor(agent, event)) print(line.kind, line.text);
        }
        if (batch.nextOffset > offset) {
          offset = batch.nextOffset;
          continue;
        }
      }
      if (inputEnded && unfinished === 0 && !openTurnId) return;
      await io.wait(POLL_MS);
    }
  };

  const post = async (prompt: string) => {
    typed.push(prompt);
    if (!key) {
      const created = await io.api('POST', '/api/shared/conversations', { title: options.title ?? firstPromptTitle(prompt) }) as { conversation: { id: string } };
      selectWorkspace(database, created.conversation.id, options.cwd);
      attach(created.conversation.id, false);
    }
    await io.api('POST', '/api/shared/messages', {
      conversationId: key!.conversationId,
      body: prompt,
      dispatchTo: agent,
      ...(options.accountProfile ? { accountProfile: options.accountProfile } : {}),
    });
  };

  const cancelOpenTurn = async (turnId: string) => {
    // The reply id is the turn id minus its "#attempt" suffix. The API cancel marks the reply
    // canceled and interrupts the host; the host interrupt is the fallback when the reply is gone.
    try {
      await io.api('POST', `/api/shared/messages/${turnId.split('#')[0]}/cancel`);
    } catch {
      const status = key ? readAgentSessionStatus(key) : null;
      if (status) await interrupt({ socketPath: status.socketPath }).catch(() => { /* host already gone */ });
    }
  };

  let finish!: () => void;
  const detachRequested = new Promise<void>((done) => { finish = done; });
  const detach = () => { detached = true; finish(); };

  const onInterrupt = () => {
    if (!openTurnId || interrupting) {
      detach();
      return;
    }
    interrupting = true;
    print('host', '^C interrupting the current turn (Ctrl-C again detaches)');
    void cancelOpenTurn(openTurnId);
  };

  const reader = createInterface({ input: io.input, output: io.stdout as NodeJS.WritableStream, prompt: '' });
  reader.on('SIGINT', onInterrupt);
  const unsubscribe = io.onInterrupt(onInterrupt);
  let queue: Promise<void> = Promise.resolve();
  reader.on('line', (raw) => {
    const text = raw.trim();
    if (!text) return;
    if (/^(exit|\/exit|\.exit)$/i.test(text)) {
      detach();
      return;
    }
    unfinished += 1;
    queue = queue.then(() => post(text)).catch((error: unknown) => {
      io.stderr.write(`Could not send: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => { unfinished -= 1; });
  });
  reader.on('close', () => { inputEnded = true; });

  try {
    await Promise.race([pump(), detachRequested]);
  } finally {
    detached = true;
    unsubscribe();
    reader.close();
    database.close();
  }
  io.stdout.write(`${midLine ? '\n' : ''}Detached. The ${agent} session keeps running${key ? ` (conversation ${(key as AgentSessionKey).conversationId})` : ''}.\n`);
}

export function defaultIo(options: LauncherOptions): LauncherIo {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    input: process.stdin,
    onInterrupt(listener) {
      process.on('SIGINT', listener);
      return () => process.off('SIGINT', listener);
    },
    async api(method, path, body) {
      const response = await fetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
      try { return JSON.parse(text); } catch { return text; }
    },
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runLauncher(options, defaultIo(options));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
