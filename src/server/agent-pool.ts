import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Warm process pool for the ephemeral lane (research, reviews, short room
 * answers, one-shot execute work) — see f762adb1. Coding conversations never
 * draw from this: they resume a specific --resume sessionId that a generic
 * pre-warmed process cannot hold, and are excluded by callers before they
 * ever reach claim()/warm().
 *
 * A pooled process is pre-spawned with its full command+args (including cwd,
 * model and MCP config) so provider boot and MCP init happen before a task
 * arrives. A claimed process runs exactly one task and is never returned to
 * the pool — this avoids cross-task context bleeding through a reused
 * process. Idle entries are evicted after IDLE_TTL_MS so an unclaimed warm
 * process doesn't sit around indefinitely.
 */

export interface PooledProcess {
  command: string;
  args: string[];
  child: ChildProcessWithoutNullStreams;
  createdAt: number;
  ready: boolean;
}

const IDLE_TTL_MS = 5 * 60_000;
const MAX_IDLE_PER_KEY = 1;

const idleByKey = new Map<string, PooledProcess[]>();

export function poolKey(agent: string, cwd: string, identity = ''): string {
  return `${agent}:${cwd}:${identity}`;
}

function isAlive(entry: PooledProcess): boolean {
  return entry.child.exitCode === null && entry.child.signalCode === null;
}

function argsMatch(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Takes a matching idle process out of the pool, or returns null if none is warm and ready. */
export function claimWarmProcess(agent: string, cwd: string, command: string, args: string[], identity = ''): ChildProcessWithoutNullStreams | null {
  const key = poolKey(agent, cwd, identity);
  const bucket = idleByKey.get(key);
  if (!bucket?.length) return null;
  const index = bucket.findIndex((entry) => entry.ready && isAlive(entry) && entry.command === command && argsMatch(entry.args, args));
  if (index === -1) return null;
  const [entry] = bucket.splice(index, 1);
  return entry.child;
}

/** True when a matching warm process is already idle and waiting to be claimed. */
export function hasWarmProcess(agent: string, cwd: string, command: string, args: string[], identity = ''): boolean {
  const bucket = idleByKey.get(poolKey(agent, cwd, identity));
  return Boolean(bucket?.some((entry) => entry.ready && isAlive(entry) && entry.command === command && argsMatch(entry.args, args)));
}

/** True when a matching process is either ready or still completing its provider handshake. */
export function hasPooledProcess(agent: string, cwd: string, command: string, args: string[], identity = ''): boolean {
  const bucket = idleByKey.get(poolKey(agent, cwd, identity));
  return Boolean(bucket?.some((entry) => isAlive(entry) && entry.command === command && argsMatch(entry.args, args)));
}

/** Adds a pre-spawned, not-yet-claimed process to the pool for its (agent, cwd) key. */
export function warmProcess(agent: string, cwd: string, command: string, args: string[], child: ChildProcessWithoutNullStreams, ready: Promise<void> | null = null, identity = ''): void {
  const key = poolKey(agent, cwd, identity);
  const bucket = idleByKey.get(key) ?? [];
  sweepBucket(bucket);
  if (bucket.length >= MAX_IDLE_PER_KEY) {
    try { child.kill('SIGTERM'); } catch { /* already exiting */ }
    return;
  }
  const entry: PooledProcess = { command, args, child, createdAt: Date.now(), ready: !ready };
  bucket.push(entry);
  idleByKey.set(key, bucket);
  if (ready) {
    void ready.then(() => { entry.ready = true; }).catch(() => {
      const index = bucket.indexOf(entry);
      if (index >= 0) bucket.splice(index, 1);
      try { child.kill('SIGTERM'); } catch { /* already exiting */ }
      if (bucket.length === 0) idleByKey.delete(key);
    });
  }
}

function sweepBucket(bucket: PooledProcess[]): void {
  const now = Date.now();
  for (let index = bucket.length - 1; index >= 0; index -= 1) {
    const entry = bucket[index];
    if (isAlive(entry) && now - entry.createdAt < IDLE_TTL_MS) continue;
    if (isAlive(entry)) { try { entry.child.kill('SIGTERM'); } catch { /* already exiting */ } }
    bucket.splice(index, 1);
  }
}

export function sweepIdlePool(): void {
  for (const [key, bucket] of idleByKey) {
    sweepBucket(bucket);
    if (bucket.length === 0) idleByKey.delete(key);
  }
}

export function idlePoolSizeForTest(agent: string, cwd: string, identity = ''): number {
  return idleByKey.get(poolKey(agent, cwd, identity))?.length ?? 0;
}

export function resetPoolForTest(): void {
  for (const bucket of idleByKey.values()) {
    for (const entry of bucket) { try { entry.child.kill('SIGTERM'); } catch { /* already exiting */ } }
  }
  idleByKey.clear();
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startPoolSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdlePool, 60_000);
  sweepTimer.unref();
}
