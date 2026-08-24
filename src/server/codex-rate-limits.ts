import { spawn } from 'node:child_process';

export interface CodexRateLimit {
  usedPercent: number;
  resetsAt: string | null;
  windowDurationMins: number | null;
  planType: string | null;
}

const CACHE_TTL_MS = 60_000;
let cached: { value: CodexRateLimit | null; fetchedAt: number } | null = null;
let inFlight: Promise<CodexRateLimit | null> | null = null;

/**
 * The Codex app-server is the account authority for Codex usage, but its rate-limit
 * window only moves over hours, so a fresh `codex app-server --stdio` subprocess per
 * request (previously spawned on every Insights load, twice a minute via polling) is
 * pure overhead. Cache the result for a short TTL and de-dupe concurrent callers onto
 * a single in-flight spawn.
 */
export async function readCodexRateLimit(): Promise<CodexRateLimit | null> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = fetchCodexRateLimit().then((value) => {
    cached = { value, fetchedAt: Date.now() };
    inFlight = null;
    return value;
  });
  return inFlight;
}

async function fetchCodexRateLimit(): Promise<CodexRateLimit | null> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let requestedRateLimit = false;
    let settled = false;
    const finish = (value: CodexRateLimit | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 2_500);

    child.on('error', () => finish(null));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (message.id === 1 && !requestedRateLimit) {
          requestedRateLimit = true;
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: null })}\n`);
        }
        if (message.id === 2) finish(parseCodexRateLimit(message.result));
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'workbench', version: '1' }, capabilities: {} } })}\n`);
  });
}

export function parseCodexRateLimit(result: unknown): CodexRateLimit | null {
  if (!result || typeof result !== 'object') return null;
  const rateLimits = (result as Record<string, unknown>).rateLimits;
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const primary = (rateLimits as Record<string, unknown>).primary;
  if (!primary || typeof primary !== 'object') return null;
  const usedPercent = (primary as Record<string, unknown>).usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  const resetsAt = (primary as Record<string, unknown>).resetsAt;
  const windowDurationMins = (primary as Record<string, unknown>).windowDurationMins;
  const planType = (rateLimits as Record<string, unknown>).planType;
  return {
    usedPercent,
    resetsAt: typeof resetsAt === 'number' ? new Date(resetsAt * 1_000).toISOString() : null,
    windowDurationMins: typeof windowDurationMins === 'number' ? windowDurationMins : null,
    planType: typeof planType === 'string' ? planType : null,
  };
}
