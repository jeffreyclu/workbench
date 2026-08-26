import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export type DiffConfidenceBlock = { key: string; lines: string[] };
export type DiffConfidenceAssessment = { confidence: number; reasoning: string };

const SYSTEM_PROMPT = `You are reviewing a code diff. For every supplied changed block, estimate how likely the block is to be correct in its local context. Return only minified JSON in this exact form: {"assessments":{"block-key":{"confidence":0,"reasoning":"brief visible-code rationale"}}}. Every supplied key must appear exactly once. Confidence is an integer from 0 to 100 and reasoning is a concise sentence. This is an AI assessment, not a claim of calibrated probability. Base it on visible code only; do not invent context.`;
const cache = new Map<string, Promise<Record<string, DiffConfidenceAssessment>>>();

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

export function assessDiffBlocks(blocks: DiffConfidenceBlock[]): Promise<Record<string, DiffConfidenceAssessment>> {
  const key = createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
  const existing = cache.get(key);
  if (existing) return existing;
  const assessment = runAssessment(blocks);
  cache.set(key, assessment);
  void assessment.catch(() => cache.delete(key));
  return assessment;
}
