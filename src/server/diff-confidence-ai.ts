import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export type DiffConfidenceBlock = { key: string; lines: string[] };
export type DiffConfidenceAssessment = { confidence: number; reasoning: string };

const SYSTEM_PROMPT = `You are reviewing a code diff. For every supplied changed block, estimate how likely the block is to be correct in its local context. Return only minified JSON in this exact form: {"assessments":{"block-key":{"confidence":0,"reasoning":"brief visible-code rationale"}}}. Every supplied key must appear exactly once. Confidence is an integer from 0 to 100 and reasoning is a concise sentence. This is an AI assessment, not a claim of calibrated probability. Base it on visible code only; do not invent context.`;

/** Keyed by block content hash, not block key or batch identity, so the same
 * change surfaced from a different conversation window (or a different mix of
 * sibling blocks) reads the cached score instead of re-spawning the model. */
const cache = new Map<string, Promise<DiffConfidenceAssessment>>();

function hashBlock(block: DiffConfidenceBlock): string {
  return createHash('sha256').update(JSON.stringify(block.lines)).digest('hex');
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
    const assessment = value as { confidence?: unknown; reasoning?: unknown };
    if (typeof assessment.confidence !== 'number' || !Number.isInteger(assessment.confidence) || assessment.confidence < 0 || assessment.confidence > 100 || typeof assessment.reasoning !== 'string' || !assessment.reasoning.trim()) throw new Error('AI diff assessment omitted or invalidated a block score.');
    assessments[key] = { confidence: assessment.confidence, reasoning: assessment.reasoning.trim() };
  }
  return assessments;
}

function runAssessment(blocks: DiffConfidenceBlock[]): Promise<Record<string, DiffConfidenceAssessment>> {
  const keys = blocks.map((block) => block.key);
  const prompt = `${SYSTEM_PROMPT}\n\nBlocks:\n${JSON.stringify(blocks)}`;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', 'haiku', '--effort', 'low', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--no-chrome', '--output-format', 'json', '--system-prompt', SYSTEM_PROMPT], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(stderr.trim() || 'AI diff assessment failed.')); return; }
      try { resolve(parseDiffConfidenceAssessment(stdout, keys)); }
      catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.end(prompt);
  });
}

/** Reads the per-block cache first; only blocks whose content hash misses are
 * sent to the model, in a single batched spawn, and each result is cached
 * individually so future requests — from any conversation window — can reuse
 * it regardless of what else is batched alongside it. */
export function assessDiffBlocks(blocks: DiffConfidenceBlock[]): Promise<Record<string, DiffConfidenceAssessment>> {
  const hashes = new Map(blocks.map((block) => [block.key, hashBlock(block)] as const));
  const uncached = blocks.filter((block) => !cache.has(hashes.get(block.key)!));
  const entries = new Map<string, Promise<DiffConfidenceAssessment>>();
  for (const block of blocks) {
    const hash = hashes.get(block.key)!;
    if (cache.has(hash)) entries.set(block.key, cache.get(hash)!);
  }
  if (uncached.length > 0) {
    const batch = runAssessment(uncached);
    for (const block of uncached) {
      const hash = hashes.get(block.key)!;
      const single = batch.then((result) => result[block.key]);
      cache.set(hash, single);
      void single.catch(() => cache.delete(hash));
      entries.set(block.key, single);
    }
  }
  return Promise.all([...entries].map(([blockKey, assessment]) => assessment.then((value) => [blockKey, value] as const)))
    .then((pairs) => Object.fromEntries(pairs));
}
