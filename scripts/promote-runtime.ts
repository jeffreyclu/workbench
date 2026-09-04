import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { get as httpGet } from 'node:http';
import { runtimeSourceFingerprint } from '../src/server/runtime-preview.js';
import { markRuntimePromotionPending, publishRuntimeRelease } from '../src/server/runtime-release.js';
import { promotionMustWaitForAgents } from '../src/server/runtime-promotion.js';

const root = resolve(new URL('..', import.meta.url).pathname);
const runtimeRoot = join(root, '.workbench-runtime');
const releaseId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const lockPath = join(runtimeRoot, 'promotion.lock');
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 250;
const databasePath = process.env.DATABASE_PATH?.trim() || join(root, 'data', 'workbench.db');

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function activeAgentWork(): Promise<boolean | null> {
  return new Promise((resolveStatus) => {
    const request = httpGet({ hostname: '127.0.0.1', port: 5180, path: '/api/health', timeout: 750 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body = `${body}${chunk}`.slice(-4_000); });
      response.on('end', () => {
        try {
          const status = JSON.parse(body) as { ownedAgentWorkActive?: unknown; liveAgentProcessCount?: unknown };
          resolveStatus(promotionMustWaitForAgents(status));
        } catch { resolveStatus(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveStatus(null));
  });
}

async function waitForAgentIdle(): Promise<void> {
  let reported = false;
  for (;;) {
    const active = await activeAgentWork();
    // No live runtime is normal for the first installation. A responding live
    // runtime must drain every agent process before build/preflight can compete
    // with the user's workload for memory and CPU.
    if (active !== true) return;
    if (!reported) {
      reported = true;
      console.log('Waiting for active Workbench agent work to finish before building the release…');
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_000));
  }
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

function waitForCandidateHealth(port: number, processToCheck: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolveHealth, rejectHealth) => {
    const deadline = Date.now() + 20_000;
    const poll = () => {
      if (processToCheck.exitCode !== null) return rejectHealth(new Error(`Candidate runtime exited with code ${processToCheck.exitCode} during preflight.`));
      const request = httpGet({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 750 }, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolveHealth();
        if (Date.now() >= deadline) return rejectHealth(new Error('Candidate runtime did not become healthy within 20 seconds.'));
        setTimeout(poll, 150);
      });
      request.on('error', () => Date.now() >= deadline ? rejectHealth(new Error('Candidate runtime did not become healthy within 20 seconds.')) : setTimeout(poll, 150));
      request.on('timeout', () => request.destroy());
    };
    poll();
  });
}

/** Validate the exact build against a transactionally copied live database before publication. */
async function preflightCandidate(): Promise<void> {
  const preflightDirectory = mkdtempSync(join(tmpdir(), 'workbench-runtime-preflight-'));
  const copiedDatabase = join(preflightDirectory, 'workbench.db');
  const backup = spawnSync('sqlite3', [databasePath, `.backup ${copiedDatabase}`], { encoding: 'utf8' });
  if (backup.status !== 0) throw new Error(`Could not copy the live database for promotion preflight: ${backup.stderr || backup.stdout}`);
  const port = 46_000 + (process.pid % 1_000);
  const child = spawn(join(root, 'node_modules/.bin/tsx'), [join(root, 'src/server/index.ts')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_PATH: copiedDatabase, WORKBENCH_CLIENT_PATH: join(root, 'dist/client') },
    stdio: 'ignore',
  });
  try {
    await waitForCandidateHealth(port, child);
  } finally {
    child.kill('SIGTERM');
    rmSync(preflightDirectory, { recursive: true, force: true });
  }
}

assertMainIsPushed();
const releaseLock = acquirePromotionLock();
try {

await waitForAgentIdle();

const build = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (build.status !== 0) throw new Error(`Runtime build failed with exit code ${build.status ?? 1}.`);

await preflightCandidate();
publishRuntimeRelease(root, releaseId, runtimeSourceFingerprint(root), databasePath);
markRuntimePromotionPending(root, releaseId);
console.log(`Promoted Workbench runtime ${releaseId}. The stable gateway will switch to it after its health check.`);
} finally {
  releaseLock();
}
