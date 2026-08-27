import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WorkbenchDatabase } from './database.js';

export type DiffConfidenceBlock = { key: string; lines: string[] };
export type DiffConfidenceAssessment = { risk: number; reasoning: string };

const SYSTEM_PROMPT = `You are triaging a code diff for review priority, not grading correctness. For every supplied changed block, assign a risk score: how bad is it if this block turns out to be wrong, weighted by how likely that is to go undetected. Do NOT score based on whether the syntax or types look right — that is a prerequisite, not a signal. Score based on:
1. Unverifiable context dependency (the dominant driver): does correctness depend on a caller, config, schema, or invariant NOT visible in this diff? If so, that pushes risk up regardless of how clean the visible code looks.
2. Blast radius: shared/exported symbol, public API, auth/authz, persisted data or migrations, versus a local/private helper.
3. Reversibility: would a mistake here be obvious and cheap to catch and revert, or silent and hard to detect (data corruption, race condition, security hole)?
Only syntactically broken code should score above 90 on that basis alone; otherwise being syntactically fine does not by itself justify a low score.
Bands: 0-19 trivial (comments, copy, formatting, tests, no runtime behavior change), 20-39 low (localized, obvious and cheap to revert if wrong), 40-59 moderate (touches control flow, validation, or error handling with some unverifiable assumption), 60-79 elevated (meaningful blast radius or a real unverifiable dependency), 80-100 high (security, auth, data mutation/migration, or silent-failure potential).
You will receive the changed blocks as a JSON array; evaluate each array item against the rubric independently. Return only minified JSON as an array in this exact form: [{"key":"block-key","risk":0,"reasoning":"one short plain-English sentence, max ~20 words, a developer can skim in one glance"}]. Write reasoning like you are telling a teammate the one thing to watch out for, not citing the rubric: name the concrete risk in plain terms (e.g. "assumes the caller already validated input" or "touches shared auth logic with no visible test"), never the words "driver", "blast radius", or "unverifiable context dependency" themselves. Every supplied key must appear exactly once, in any order. Risk is an integer from 0 to 100. This is an AI assessment, not a claim of calibrated probability. Base it on visible code only; do not invent context.`;

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
};

let worker: ChildProcessWithoutNullStreams | null = null;
let outputBuffer = '';
let active: PendingAssessment | null = null;
const queue: PendingAssessment[] = [];

/** A pre-started stream-json worker removes CLI boot overhead. It is recycled
 * after every assessment: Claude's stream protocol otherwise retains prior
 * file diffs as chat history, making each later file slower than the last. */
function ensureWorker(): ChildProcessWithoutNullStreams {
  if (worker && !worker.killed && worker.exitCode == null) return worker;
  worker = spawn('claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPT,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  (worker.stdout as unknown as { setEncoding?: (encoding: string) => void }).setEncoding?.('utf8');
  worker.stdout.on('data', (chunk: string) => {
    outputBuffer += chunk;
    for (;;) {
      const newline = outputBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = outputBuffer.slice(0, newline); outputBuffer = outputBuffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (event.type !== 'result' || !active) continue;
        const pending = active; active = null;
        if (event.is_error || typeof event.result !== 'string') pending.reject(new Error('AI diff assessment failed.'));
        else {
          try { pending.resolve(parseDiffConfidenceAssessment(event.result, pending.blocks.map((block) => block.key))); }
          catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
        }
        recycleWorker();
        ensureWorker();
        dispatchNext();
      } catch { /* Ignore non-result stream events. */ }
    }
  });
  const stopWorker = (error: Error) => {
    worker = null; outputBuffer = '';
    if (active) { active.reject(error); active = null; }
    while (queue.length) queue.shift()!.reject(error);
  };
  worker.once('exit', () => stopWorker(new Error('AI diff scorer stopped unexpectedly.')));
  worker.once('error', stopWorker);
  worker.stdin.on('error', stopWorker);
  return worker;
}

function dispatchNext(): void {
  if (active || queue.length === 0) return;
  const scorer = ensureWorker();
  active = queue.shift()!;
  // The rubric is already the system prompt. Sending it again used to double
  // every uncached request's input and delayed the first score unnecessarily.
  scorer.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Blocks:\n${JSON.stringify(active.blocks)}` }] } })}\n`);
}

function recycleWorker(): void {
  const scorer = worker;
  worker = null;
  outputBuffer = '';
  if (!scorer) return;
  // This is an intentional turnover after a completed response, not a scorer
  // failure. Detach failure handlers before terminating the consumed session
  // so queued work is claimed by the already-restarting clean worker.
  scorer.removeAllListeners('exit');
  scorer.removeAllListeners('error');
  scorer.stdin.removeAllListeners('error');
  scorer.stdout.removeAllListeners('data');
  try { scorer.kill('SIGTERM'); } catch { /* already stopped */ }
}

function runAssessment(blocks: DiffConfidenceBlock[]): Promise<Record<string, DiffConfidenceAssessment>> {
  ensureWorker();
  return new Promise((resolve, reject) => {
    queue.push({ blocks, resolve, reject });
    dispatchNext();
  });
}

function trivialAssessment(block: DiffConfidenceBlock): DiffConfidenceAssessment | null {
  const changed = block.lines.filter((line) => line.startsWith('+') || line.startsWith('-'))
    .map((line) => line.slice(1).trim());
  if (!changed.length || !changed.every((line) => !line || /^(?:\/\/|\/\*|\*|\*\/|#)/.test(line))) return null;
  return { risk: 0, reasoning: 'Comment-only change; it cannot alter runtime behavior.' };
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
    const batch = runAssessment(uncached);
    for (const block of uncached) {
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
  return Promise.all([...entries].map(([blockKey, assessment]) => assessment.then((value) => [blockKey, value] as const)))
    .then((pairs) => Object.fromEntries(pairs));
}

/** Start the dedicated scorer during server boot, before a reviewer opens a
 * diff. It remains idle and does no scoring until the first real request. */
export function warmDiffConfidenceModel(): void {
  ensureWorker();
}
