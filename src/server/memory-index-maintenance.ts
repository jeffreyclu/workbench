import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN_REFRESH_INTERVAL_MS = 30_000;
let child: ChildProcess | null = null;
let refreshAgain = false;
let lastFinishedAt = 0;
let scheduled: ReturnType<typeof setTimeout> | null = null;

function start(): void {
  if (child) {
    refreshAgain = true;
    return;
  }
  const workerPath = fileURLToPath(new URL('./memory-index-maintenance-worker.ts', import.meta.url));
  const next = spawn(process.execPath, ['--import', 'tsx', workerPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'ignore',
  });
  child = next;
  next.once('exit', (code) => {
    if (child === next) child = null;
    lastFinishedAt = Date.now();
    if (code !== 0) console.error(`[memory-index] maintenance worker exited with code ${code ?? 'unknown'}.`);
    if (!refreshAgain) return;
    refreshAgain = false;
    requestMemoryIndexRefresh();
  });
  next.once('error', (error) => {
    if (child === next) child = null;
    console.error('[memory-index] maintenance worker failed to start', error);
  });
}

/** Coalesces refresh requests into one child process. Collection, embedding,
 * cleanup, and SQLite vector writes never execute on the HTTP event loop. */
export function requestMemoryIndexRefresh(): void {
  if (child) {
    refreshAgain = true;
    return;
  }
  const remaining = MIN_REFRESH_INTERVAL_MS - (Date.now() - lastFinishedAt);
  if (remaining <= 0) {
    start();
    return;
  }
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    start();
  }, remaining);
  scheduled.unref();
}

export function shutdownMemoryIndexMaintenance(): void {
  if (scheduled) clearTimeout(scheduled);
  scheduled = null;
  refreshAgain = false;
  const current = child;
  child = null;
  current?.kill('SIGTERM');
}
