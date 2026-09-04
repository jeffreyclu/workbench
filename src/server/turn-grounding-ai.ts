import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AiProviderChoice } from '../shared/ai-providers.js';
import { completeWithPalmyra } from './providers/palmyra.js';
import { resolveAiProvider } from './providers/provider-choice.js';

const IDLE_SHUTDOWN_MS = 5 * 60_000;
const CLASSIFIER_TIMEOUT_MS = 8_000;
const RESPONSE_EDITOR_TIMEOUT_MS = 30_000;
const WARMUP_TIMEOUT_MS = 20_000;
const SYSTEM_PROMPT = `You are Workbench's conversation supervisor. Every request starts with a MODE line. Follow only that mode.

MODE: GROUND
Convert a conversation into the one authoritative objective the coding agent must execute now.

Rules:
- The newest user correction overrides every conflicting earlier request, plan, hypothesis, implementation, and agent claim.
- A newest message beginning with "no", "not that", "that's not", "instead", or equivalent rejects the immediately preceding proposal. Never carry the rejected deliverable into the objective unless the correction explicitly retains it.
- If the newest user message is a continuation such as "continue", "do it", "build that", or "fix it", resolve it to the most recent concrete unresolved user request. Never use an agent's exploratory narration as the objective.
- Preserve exact scope, named locations, and named existing UI controls. Do not invent architecture, persistence, schema, migrations, or adjacent cleanup unless the user requested it.
- Acceptance criteria must describe observable completion. Exclusions must name tempting but conflicting work that should not be done.
- Set continuation=true only when the newest message is shorthand that cannot stand as a concrete instruction by itself. A concrete correction is not a continuation.
- Keep the objective compact and executable. Do not include analysis or a plan.

Return exactly one JSON object and nothing else:
{"objective":string,"acceptanceCriteria":string[],"exclusions":string[],"continuation":boolean}

MODE: EDIT
Rewrite an agent's draft before Jeffrey sees it.

Rules:
- Return exactly one paragraph on one line. Never use a blank line, list, heading, preamble, or closing remark.
- Use exactly this order: Problem: ... Solution: ... Context: ...
- Use plain English. Replace specialist shorthand with ordinary words unless an exact command, file, URL, error, or code name is necessary.
- Keep the whole response at or below 120 words.
- Preserve concrete outcomes, changed files, verification, URLs, and blockers. Do not invent facts or improve the claimed verification.
- State what is still unverified when the draft says it was not checked.
- Output only the edited response.`;

type Pending = { prompt: string; resolve: (output: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null; timeoutMs: number };
type SupervisorPool = {
  label: string;
  worker: ChildProcessWithoutNullStreams | null;
  active: Pending | null;
  buffer: string;
  queue: Pending[];
  idleTimer: ReturnType<typeof setTimeout> | null;
};
const groundingPool: SupervisorPool = { label: 'turn-grounding classifier', worker: null, active: null, buffer: '', queue: [], idleTimer: null };
const responseEditorPool: SupervisorPool = { label: 'response editor', worker: null, active: null, buffer: '', queue: [], idleTimer: null };

function settle(pending: Pending, error?: Error, output?: string): void {
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = null;
  if (error) pending.reject(error);
  else pending.resolve(output ?? '');
}

function stop(pool: SupervisorPool, error: Error): void {
  if (pool.idleTimer) clearTimeout(pool.idleTimer);
  pool.idleTimer = null;
  const child = pool.worker;
  pool.worker = null;
  pool.buffer = '';
  try { child?.kill('SIGTERM'); } catch { /* already stopped */ }
  if (pool.active) { settle(pool.active, error); pool.active = null; }
  while (pool.queue.length) settle(pool.queue.shift()!, error);
}

function scheduleIdleShutdown(pool: SupervisorPool): void {
  if (pool.active || pool.queue.length || !pool.worker) return;
  if (pool.idleTimer) clearTimeout(pool.idleTimer);
  pool.idleTimer = setTimeout(() => stop(pool, new Error(`Haiku ${pool.label} shut down while idle.`)), IDLE_SHUTDOWN_MS);
  pool.idleTimer.unref();
}

function dispatch(pool: SupervisorPool): void {
  if (!pool.worker || pool.active || pool.queue.length === 0) { scheduleIdleShutdown(pool); return; }
  if (pool.idleTimer) clearTimeout(pool.idleTimer);
  pool.idleTimer = null;
  pool.active = pool.queue.shift()!;
  const pending = pool.active;
  pending.timer = setTimeout(() => {
    if (pool.active !== pending) return;
    pool.active = null;
    try { pool.worker?.kill('SIGTERM'); } catch { /* already stopped */ }
    pool.worker = null;
    pool.buffer = '';
    settle(pending, new Error(`Haiku ${pool.label} timed out after ${pending.timeoutMs / 1_000}s.`));
    if (pool.queue.length) ensureWorker(pool);
    dispatch(pool);
  }, pending.timeoutMs);
  pending.timer.unref();
  pool.worker.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: pending.prompt } })}\n`);
}

function ensureWorker(pool: SupervisorPool): ChildProcessWithoutNullStreams {
  if (pool.worker && pool.worker.exitCode === null && !pool.worker.killed) return pool.worker;
  const classifier = pool.worker = spawn('claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPT,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  classifier.stdout.setEncoding('utf8');
  classifier.stdout.on('data', (chunk: string) => {
    pool.buffer += chunk;
    for (;;) {
      const newline = pool.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = pool.buffer.slice(0, newline); pool.buffer = pool.buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (event.type !== 'result' || !pool.active) continue;
        const pending = pool.active; pool.active = null;
        if (event.is_error || typeof event.result !== 'string') settle(pending, new Error(`Haiku ${pool.label} failed.`));
        else settle(pending, undefined, event.result);
        dispatch(pool);
      } catch { /* Ignore non-terminal stream records. */ }
    }
  });
  const stopClassifier = (error: Error) => {
    if (pool.worker === classifier) stop(pool, error);
  };
  classifier.once('exit', () => stopClassifier(new Error(`Haiku ${pool.label} stopped unexpectedly.`)));
  classifier.once('error', stopClassifier);
  classifier.stdin.on('error', stopClassifier);
  return classifier;
}

function runWithClaude(pool: SupervisorPool, prompt: string, timeoutMs: number): Promise<string> {
  ensureWorker(pool);
  return new Promise((resolve, reject) => {
    const pending: Pending = { prompt, resolve, reject, timer: null, timeoutMs };
    pool.queue.push(pending);
    dispatch(pool);
  });
}

/** One tiny, tool-free model call shared by every agent answering the same user
 * turn. The conversation's provider selector decides who answers it; Palmyra is
 * one HTTP round trip against the same system prompt, and a failed Palmyra turn
 * falls back to the resident Haiku classifier rather than losing the grounding,
 * because the caller's only alternative is an ungrounded turn. */
export function groundTurn(prompt: string, timeoutMs = CLASSIFIER_TIMEOUT_MS, provider: AiProviderChoice | null = null, accountProfile?: string): Promise<string> {
  const request = `MODE: GROUND\n\n${prompt}`;
  if (resolveAiProvider(provider, accountProfile) !== 'palmyra') return runWithClaude(groundingPool, request, timeoutMs);
  return completeWithPalmyra({
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: request }],
    maxTokens: 800,
    timeoutMs,
  }).catch((error: unknown) => {
    console.warn(`[palmyra] turn grounding fell back to the Claude classifier: ${error instanceof Error ? error.message : String(error)}`);
    return runWithClaude(groundingPool, request, timeoutMs);
  });
}

export function editFinalResponseWithSupervisor(prompt: string, timeoutMs = RESPONSE_EDITOR_TIMEOUT_MS): Promise<string> {
  return runWithClaude(responseEditorPool, `MODE: EDIT\n\n${prompt}`, timeoutMs);
}

/** Pay the one-time CLI/model handshake during server startup, off the request path. */
export function warmTurnGroundingClassifier(): void {
  if (resolveAiProvider('auto') !== 'palmyra') {
    void groundTurn('Warm-up only. Return {"objective":"ready","acceptanceCriteria":[],"exclusions":[],"continuation":false}.', WARMUP_TIMEOUT_MS).catch(() => {});
  }
  void editFinalResponseWithSupervisor('User request or task:\nWarm the editor.\n\nAgent draft:\nNo user-facing response.', WARMUP_TIMEOUT_MS).catch(() => {});
}

export function shutdownTurnGroundingClassifier(): void {
  stop(groundingPool, new Error('Turn-grounding classifier stopped during runtime shutdown.'));
  stop(responseEditorPool, new Error('Response editor stopped during runtime shutdown.'));
}
