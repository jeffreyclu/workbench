import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { WorkbenchDatabase } from './database.js';

export type DiffConfidenceBlock = { key: string; lines: string[] };
export type DiffConfidenceAssessment = { risk: number; reasoning: string };

const SYSTEM_PROMPT = `You are triaging a code diff for review priority, not grading correctness. For every supplied changed block, assign a risk score: how bad is it if this block turns out to be wrong, weighted by how likely that is to go undetected. Do NOT score based on whether the syntax or types look right — that is a prerequisite, not a signal. Score based on:
1. Unverifiable context dependency (the dominant driver): does correctness depend on a caller, config, schema, or invariant NOT visible in this diff? If so, that pushes risk up regardless of how clean the visible code looks.
2. Blast radius: shared/exported symbol, public API, auth/authz, persisted data or migrations, versus a local/private helper.
3. Reversibility: would a mistake here be obvious and cheap to catch and revert, or silent and hard to detect (data corruption, race condition, security hole)?
Only syntactically broken code should score above 90 on that basis alone; otherwise being syntactically fine does not by itself justify a low score.
Bands: 0-19 trivial (comments, copy, formatting, tests, no runtime behavior change), 20-39 low (localized, obvious and cheap to revert if wrong), 40-59 moderate (touches control flow, validation, or error handling with some unverifiable assumption), 60-79 elevated (meaningful blast radius or a real unverifiable dependency), 80-100 high (security, auth, data mutation/migration, or silent-failure potential).
Return only minified JSON in this exact form: {"assessments":{"block-key":{"risk":0,"reasoning":"brief rationale naming which driver fired and, if driver 1 fired, exactly what unverifiable assumption it is flagging"}}}. Every supplied key must appear exactly once. Risk is an integer from 0 to 100. This is an AI assessment, not a claim of calibrated probability. Base it on visible code only; do not invent context.`;

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
  const json = candidate.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('AI diff assessment returned no JSON.');
  const parsed = JSON.parse(json) as { assessments?: unknown };
  if (!parsed.assessments || typeof parsed.assessments !== 'object' || Array.isArray(parsed.assessments)) throw new Error('AI diff assessment returned an invalid shape.');
  const source = parsed.assessments as Record<string, unknown>;
  const assessments: Record<string, DiffConfidenceAssessment> = {};
  for (const key of keys) {
    const value = source[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI diff assessment omitted or invalidated a block score.');
    const assessment = value as { risk?: unknown; reasoning?: unknown };
    if (typeof assessment.risk !== 'number' || !Number.isInteger(assessment.risk) || assessment.risk < 0 || assessment.risk > 100 || typeof assessment.reasoning !== 'string' || !assessment.reasoning.trim()) throw new Error('AI diff assessment omitted or invalidated a block score.');
    assessments[key] = { risk: assessment.risk, reasoning: assessment.reasoning.trim() };
  }
  return assessments;
}

function runAssessment(blocks: DiffConfidenceBlock[]): Promise<Record<string, DiffConfidenceAssessment>> {
  const keys = blocks.map((block) => block.key);
  const prompt = `${SYSTEM_PROMPT}\n\nBlocks:\n${JSON.stringify(blocks)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', 'haiku', '--effort', 'low', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--no-chrome', '--output-format', 'json', '--system-prompt', SYSTEM_PROMPT], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    // Pipes to the subprocess can drop mid-read (ECONNRESET/EPIPE); without an
    // 'error' listener on each stream, Node treats that as an uncaught
    // exception and crashes the whole server process instead of just this request.
    const settle = (error: Error | null, value?: Record<string, DiffConfidenceAssessment>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(value!);
    };
    child.stdin.on('error', (error) => settle(error instanceof Error ? error : new Error(String(error))));
    child.stdout.on('error', (error) => settle(error instanceof Error ? error : new Error(String(error))));
    child.stderr.on('error', (error) => settle(error instanceof Error ? error : new Error(String(error))));
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => settle(error));
    child.once('close', (code) => {
      if (code !== 0) { settle(new Error(stderr.trim() || `AI diff assessment failed (exit ${code}).`)); return; }
      try { settle(null, parseDiffConfidenceAssessment(stdout, keys)); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.end(prompt);
  });
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
