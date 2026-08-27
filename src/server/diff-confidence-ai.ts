import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkbenchDatabase } from './database.js';
import { publishRealtimeDiffConfidence } from './realtime.js';

export type DiffConfidenceBlock = { key: string; lines: string[] };
export type DiffConfidenceAssessment = { risk: number | null; reasoning: string };

const SYSTEM_PROMPT = `Return only minified JSON: [{"key":"...","risk":0,"reasoning":"brief"}]. Score every supplied code-diff block 0–100 for review priority: 0 comment/test/format-only, 25 local and reversible, 50 unverified control flow or validation, 70 shared API/auth/data, 90 security, migration, or silent data loss. Every key exactly once. Reasoning: plain English, at most eight words. No analysis or invented context.`;

/** Keyed by block content hash, not block key or batch identity, so the same
 * change surfaced from a different conversation window (or a different mix of
 * sibling blocks) reads the cached score instead of re-spawning the model.
 * Scores are persisted to the diff_confidence_cache table so they survive
 * process restarts; this in-memory map only de-dupes concurrent in-flight
 * requests for the same hash within a single process before either has
 * written its result to the database. */
const inFlight = new Map<string, Promise<DiffConfidenceAssessment>>();

function hashBlock(block: DiffConfidenceBlock): string {
  return createHash('sha256').update(JSON.stringify(block.lines)).digest('hex');
}

function readCached(database: WorkbenchDatabase, hash: string): DiffConfidenceAssessment | undefined {
  const row = database.prepare('SELECT risk, reasoning FROM diff_confidence_cache WHERE hash = ?').get(hash) as { risk: number; reasoning: string } | undefined;
  return row ? { risk: row.risk, reasoning: row.reasoning } : undefined;
}

function writeCached(database: WorkbenchDatabase, hash: string, assessment: DiffConfidenceAssessment): void {
  if (assessment.risk === null) return;
  database.prepare('INSERT OR REPLACE INTO diff_confidence_cache (hash, risk, reasoning, created_at) VALUES (?, ?, ?, ?)')
    .run(hash, assessment.risk, assessment.reasoning, new Date().toISOString());
}

export function parseDiffConfidenceAssessment(output: string, keys: string[]): Record<string, DiffConfidenceAssessment> {
  let candidate = output;
  try {
    const envelope = JSON.parse(output) as { result?: unknown };
    if (typeof envelope.result === 'string') candidate = envelope.result;
  } catch {
    // The model can return raw JSON instead of the CLI's JSON envelope.
  }
  const json = candidate.match(/\[[\s\S]*\]/)?.[0];
  if (!json) throw new Error('AI diff assessment returned no JSON.');
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) throw new Error('AI diff assessment returned an invalid shape.');
  const source = new Map<string, unknown>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('AI diff assessment returned an invalid shape.');
    const { key } = entry as { key?: unknown };
    if (typeof key !== 'string') throw new Error('AI diff assessment returned an invalid shape.');
    source.set(key, entry);
  }
  const assessments: Record<string, DiffConfidenceAssessment> = {};
  for (const key of keys) {
    const value = source.get(key);
    if (!value || typeof value !== 'object') throw new Error('AI diff assessment omitted or invalidated a block score.');
    const assessment = value as { risk?: unknown; reasoning?: unknown };
    if (typeof assessment.risk !== 'number' || !Number.isInteger(assessment.risk) || assessment.risk < 0 || assessment.risk > 100 || typeof assessment.reasoning !== 'string' || !assessment.reasoning.trim()) throw new Error('AI diff assessment omitted or invalidated a block score.');
    assessments[key] = { risk: assessment.risk, reasoning: assessment.reasoning.trim() };
  }
  return assessments;
}

type PendingAssessment = {
  blocks: DiffConfidenceBlock[];
  resolve: (value: Record<string, DiffConfidenceAssessment>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

type ScorerWorker = {
  scorer: ChildProcessWithoutNullStreams;
  outputBuffer: string;
  active: PendingAssessment | null;
};

const workers = new Set<ScorerWorker>();
const queue: PendingAssessment[] = [];
let idleShutdown: ReturnType<typeof setTimeout> | null = null;
// Haiku returns a small file's assessment in roughly 5–9 seconds, but a
// legitimate multi-block file can take longer. Twelve seconds turned every
// block in those files into an unavailable marker even though the scorer was
// healthy. Keep the UI responsive through its pending state, but allow one
// bounded assessment turn to complete before declaring the scorer unavailable.
const SCORER_TIMEOUT_MS = 25_000;
const SCORER_IDLE_SHUTDOWN_MS = 30_000;
// Four bounded Haiku workers keep a multi-file review responsive without
// borrowing either of the foreground Codex/Claude task slots.
const SCORER_POOL_SIZE = 4;

function recycleWorker(worker: ScorerWorker): void {
  if (!workers.delete(worker)) return;
  worker.outputBuffer = '';
  try { worker.scorer.kill('SIGTERM'); } catch { /* already stopped */ }
}

function scheduleIdleShutdown(): void {
  if (queue.length || [...workers].some((worker) => worker.active)) return;
  if (idleShutdown) clearTimeout(idleShutdown);
  idleShutdown = setTimeout(() => { for (const worker of [...workers]) recycleWorker(worker); }, SCORER_IDLE_SHUTDOWN_MS);
  idleShutdown.unref();
}

/** Two independent warm workers let separate diff blocks complete in parallel.
 * Each is recycled after one turn so prior file text cannot accumulate in a
 * Claude session and slow later files. */
function startWorker(): ScorerWorker {
  const scorer = spawn('claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPT,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const worker: ScorerWorker = { scorer, outputBuffer: '', active: null };
  workers.add(worker);
  (scorer.stdout as unknown as { setEncoding?: (encoding: string) => void }).setEncoding?.('utf8');
  scorer.stdout.on('data', (chunk: string) => {
    worker.outputBuffer += chunk;
    for (;;) {
      const newline = worker.outputBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = worker.outputBuffer.slice(0, newline); worker.outputBuffer = worker.outputBuffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (event.type !== 'result' || !worker.active) continue;
        const pending = worker.active; worker.active = null;
        if (pending.timeout) clearTimeout(pending.timeout);
        if (event.is_error || typeof event.result !== 'string') pending.reject(new Error('AI diff assessment failed.'));
        else {
          try {
            const assessments = parseDiffConfidenceAssessment(event.result, pending.blocks.map((block) => block.key));
            publishRealtimeDiffConfidence(assessments);
            pending.resolve(assessments);
          }
          catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
        }
        recycleWorker(worker);
        // Replace a retired worker immediately so the next visible file does
        // not pay CLI startup before its first streamed chunk.
        ensureWarmWorkers();
        dispatchNext();
      } catch { /* Ignore non-result stream events. */ }
    }
  });
  const stopWorker = (error: Error) => {
    if (!workers.has(worker)) return;
    recycleWorker(worker);
    if (worker.active) { if (worker.active.timeout) clearTimeout(worker.active.timeout); worker.active.reject(error); worker.active = null; }
    dispatchNext();
  };
  scorer.once('exit', () => stopWorker(new Error('AI diff scorer stopped unexpectedly.')));
  scorer.once('error', stopWorker);
  scorer.stdin.on('error', stopWorker);
  return worker;
}

function ensureWarmWorkers(): void {
  while (workers.size < SCORER_POOL_SIZE) startWorker();
}

function dispatchNext(): void {
  if (queue.length === 0) { scheduleIdleShutdown(); return; }
  if (idleShutdown) clearTimeout(idleShutdown);
  idleShutdown = null;
  ensureWarmWorkers();
  for (const worker of workers) {
    if (worker.active || queue.length === 0) continue;
    const pending = worker.active = queue.shift()!;
    pending.timeout = setTimeout(() => {
      if (worker.active !== pending) return;
      worker.active = null;
      pending.reject(new Error(`AI diff scorer timed out after ${SCORER_TIMEOUT_MS / 1_000} seconds.`));
      recycleWorker(worker);
      dispatchNext();
    }, SCORER_TIMEOUT_MS);
    pending.timeout.unref();
    // The rubric is already the system prompt. Sending it again used to double
    // every uncached request's input and delayed the first score unnecessarily.
    worker.scorer.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: `Blocks:\n${JSON.stringify(pending.blocks)}` } })}\n`);
  }
}

function runAssessment(blocks: DiffConfidenceBlock[]): Promise<Record<string, DiffConfidenceAssessment>> {
  ensureWarmWorkers();
  return new Promise((resolve, reject) => {
    queue.push({ blocks, resolve, reject, timeout: null });
    dispatchNext();
  });
}

function trivialAssessment(block: DiffConfidenceBlock): DiffConfidenceAssessment | null {
  const changed = block.lines.filter((line) => line.startsWith('+') || line.startsWith('-'))
    .map((line) => line.slice(1).trim());
  if (!changed.length || !changed.every((line) => !line || /^(?:\/\/|\/\*|\*|\*\/|#)/.test(line))) return null;
  return { risk: 0, reasoning: 'Comment-only change; it cannot alter runtime behavior.' };
}

/** The review surface must remain usable when the optional Haiku scorer is
 * unavailable. This is intentionally not cached: a later refresh can replace
 * the conservative placeholder with an AI score. */
function unavailableAssessment(): DiffConfidenceAssessment {
  return { risk: null, reasoning: 'AI assessment unavailable; review this changed block.' };
}

/** Reads the per-block cache first; only blocks whose content hash misses are
 * sent to the model, in a single batched spawn, and each result is persisted
 * to the database individually so future requests — from any conversation
 * window, or after a restart — can reuse it regardless of what else is
 * batched alongside it. */
export function assessDiffBlocks(database: WorkbenchDatabase, blocks: DiffConfidenceBlock[]): Promise<Record<string, DiffConfidenceAssessment>> {
  const hashes = new Map(blocks.map((block) => [block.key, hashBlock(block)] as const));
  const entries = new Map<string, Promise<DiffConfidenceAssessment>>();
  const uncached: DiffConfidenceBlock[] = [];
  for (const block of blocks) {
    const hash = hashes.get(block.key)!;
    const cached = readCached(database, hash);
    if (cached) { entries.set(block.key, Promise.resolve(cached)); continue; }
    const trivial = trivialAssessment(block);
    if (trivial) { writeCached(database, hash, trivial); entries.set(block.key, Promise.resolve(trivial)); continue; }
    if (inFlight.has(hash)) { entries.set(block.key, inFlight.get(hash)!); continue; }
    uncached.push(block);
  }
  if (uncached.length > 0) {
    for (let index = 0; index < uncached.length; index += 3) {
      const chunk = uncached.slice(index, index + 3);
      const batch = runAssessment(chunk);
      for (const block of chunk) {
        const hash = hashes.get(block.key)!;
        const single = batch.then((result) => {
          const assessment = result[block.key];
          writeCached(database, hash, assessment);
          return assessment;
        });
        inFlight.set(hash, single);
        void single.finally(() => inFlight.delete(hash)).catch(() => {});
        entries.set(block.key, single);
      }
    }
  }
  return Promise.all([...entries].map(([blockKey, assessment]) => assessment
    .then((value) => [blockKey, value] as const)
    .catch(() => [blockKey, unavailableAssessment()] as const)))
    .then((pairs) => Object.fromEntries(pairs));
}

/** Start the dedicated scorer during server boot, before a reviewer opens a
 * diff. It remains idle and does no scoring until the first real request. */
export function warmDiffConfidenceModel(): void {
  ensureWarmWorkers();
  scheduleIdleShutdown();
}

/** Runtime promotion must reap this process; otherwise an old release can
 * retain a Claude session and contend with a real agent turn indefinitely. */
export function shutdownDiffConfidenceModel(): void {
  if (idleShutdown) clearTimeout(idleShutdown);
  idleShutdown = null;
  const error = new Error('AI diff scorer stopped during runtime shutdown.');
  for (const worker of [...workers]) {
    if (worker.active?.timeout) clearTimeout(worker.active.timeout);
    worker.active?.reject(error);
    worker.active = null;
    recycleWorker(worker);
  }
  while (queue.length) queue.shift()!.reject(error);
}
