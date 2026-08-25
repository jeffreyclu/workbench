import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeSourceFingerprint } from '../src/server/runtime-preview.js';
import { publishRuntimeRelease } from '../src/server/runtime-release.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const runtimeRoot = join(root, '.workbench-runtime');
const releaseId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const lockPath = join(runtimeRoot, 'promotion.lock');
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 250;

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockOwnerIsAlive(): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };
    if (typeof owner.pid !== 'number') return Date.now() - statSync(lockPath).mtimeMs < 5_000;
    process.kill(owner.pid, 0);
    return true;
  } catch {
    // Another process can observe the directory in the few synchronous writes
    // between mkdir and owner.json. Treat that short window as owned; only an
    // incomplete lock older than five seconds is safe to reclaim.
    try { return Date.now() - statSync(lockPath).mtimeMs < 5_000; } catch { return false; }
  }
}

function acquirePromotionLock(): () => void {
  mkdirSync(runtimeRoot, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!existsSync(lockPath)) continue;
      // A process killed during a build cannot clean up. Its PID is definitive;
      // reclaim only that dead lock, never a live slow promotion.
      if (!lockOwnerIsAlive()) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Runtime promotion is already in progress and did not release its lock within 60 seconds.');
      wait(LOCK_POLL_MS);
    }
  }
}

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, env: process.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Promotion requires git ${args.join(' ')} to succeed.\n\n${result.stderr || result.stdout}`);
  return result.stdout;
}

/** The release being copied must already be the exact commit on origin/main.
 * The higher-level approval worker can create that commit; this final gate
 * prevents manual/scripted promotion from bypassing the same invariant. */
function assertMainIsPushed(): void {
  const branch = runGit(['branch', '--show-current']).trim();
  if (branch !== 'main') throw new Error(`Promotion requires main. Current branch: ${branch || 'detached HEAD'}.`);
  if (runGit(['status', '--porcelain']).trim()) throw new Error('Promotion requires a clean worktree. Commit and push main first.');
  runGit(['fetch', 'origin', 'main']);
  if (runGit(['rev-list', 'origin/main..HEAD']).trim()) throw new Error('Promotion requires HEAD to be pushed to origin/main.');
}

assertMainIsPushed();
const releaseLock = acquirePromotionLock();
try {

const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (build.status !== 0) throw new Error(`Runtime build failed with exit code ${build.status ?? 1}.`);

publishRuntimeRelease(root, releaseId, runtimeSourceFingerprint(root));
console.log(`Promoted Workbench runtime ${releaseId}. The stable gateway will switch to it after its health check.`);
} finally {
  releaseLock();
}
