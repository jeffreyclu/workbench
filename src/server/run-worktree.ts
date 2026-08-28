import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
let integrationTail: Promise<void> = Promise.resolve();

/** Workbench is the only repository whose parallel mutating runs are isolated.
 * Other project repositories remain in their selected primary checkout. */
export function shouldIsolateRunWorkspace(sourceWorkspace: string): boolean {
  return resolve(sourceWorkspace) === resolve(process.cwd());
}

/**
 * Gives each mutating run its own detached worktree.  A detached worktree is
 * deliberately branchless: parallel agents never switch the user's checkout
 * or create a feature branch just to obtain filesystem isolation.
 *
 * Worktrees are retained after a run so Changes can inspect the exact files it
 * produced. The garbage collector owns eventual removal of terminal run trees.
 */
export async function isolatedRunWorkspace(sourceWorkspace: string, runId: string, mutates: boolean, isolate = true): Promise<string> {
  const source = resolve(sourceWorkspace);
  if (!mutates || !isolate || process.env.VITEST) return source;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: source, timeout: 5_000, maxBuffer: 32_768 });
    const repository = resolve(stdout.trim());
    const key = createHash('sha256').update(repository).digest('hex').slice(0, 12);
    const destination = join(homedir(), '.workbench', 'run-worktrees', `${basename(repository)}-${key}`, runId);
    if (!existsSync(destination)) {
      mkdirSync(join(homedir(), '.workbench', 'run-worktrees', `${basename(repository)}-${key}`), { recursive: true });
      await execFile('git', ['worktree', 'add', '--detach', destination, 'HEAD'], { cwd: repository, timeout: 60_000, maxBuffer: 131_072 });
    }
    return destination;
  } catch {
    // Scratch directories and a broken Git installation must not prevent a
    // task from running. Real repositories use the isolated path above.
    return source;
  }
}

/**
 * The only valid exit path for a dirty Workbench run worktree. Its patch is
 * applied to the primary main checkout under one in-process FIFO, committed on
 * main, and left available for the normal explicit promotion flow. A conflict
 * is an integration failure, never an invisible orphaned worktree.
 */
export function integrateWorkbenchRunWorktree(sourceWorkspace: string, worktree: string, runId: string, isolate = shouldIsolateRunWorkspace(sourceWorkspace)): Promise<{ integrated: boolean; commitHash: string | null }> {
  const source = resolve(sourceWorkspace);
  const detached = resolve(worktree);
  if (!isolate || source === detached) return Promise.resolve({ integrated: false, commitHash: null });
  const task = integrationTail.then(() => {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: source, encoding: 'utf8', timeout: 5_000 }).trim();
    if (branch !== 'main') throw new Error(`Workbench worktree integration requires main; found ${branch || 'detached HEAD'}.`);
    if (execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8', timeout: 5_000 }).trim()) {
      throw new Error('Workbench main has uncommitted changes; cannot safely integrate this run worktree.');
    }
    const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: detached, encoding: 'utf8', timeout: 15_000, maxBuffer: 4_000_000 });
    if (!patch.trim()) return { integrated: false, commitHash: null };
    try {
      execFileSync('git', ['apply', '--3way', '--index', '-'], { cwd: source, input: patch, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
      execFileSync('git', ['commit', '-m', `feat: integrate Workbench agent run ${runId}`], { cwd: source, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
      const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', timeout: 5_000 }).trim();
      // The exact patch now exists in main. Clear the detached copy so the
      // post-promotion collector can remove this worktree without retaining
      // duplicate staged edits.
      execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: detached, stdio: 'ignore', timeout: 15_000 });
      return { integrated: true, commitHash };
    } catch (error) {
      // `git apply --index` may leave conflict entries. Restore only the
      // primary index/worktree to its pre-integration HEAD; the detached run
      // worktree remains intact for recovery and inspection.
      try { execFileSync('git', ['reset', '--merge', 'HEAD'], { cwd: source, stdio: 'ignore', timeout: 15_000 }); } catch { /* Preserve the original integration error. */ }
      throw error;
    }
  });
  integrationTail = task.then(() => undefined, () => undefined);
  return task;
}

/** Remove only integrated, clean run worktrees. Never discard work merely
 * because a run ended: the detached commit must already be reachable from the
 * source repository's main branch, which is true after its commit has landed
 * and been promoted. */
export async function cleanupIntegratedRunWorktrees(): Promise<number> {
  const root = join(homedir(), '.workbench', 'run-worktrees');
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const repositoryDirectory of readdirSync(root, { withFileTypes: true })) {
    if (!repositoryDirectory.isDirectory()) continue;
    const directory = join(root, repositoryDirectory.name);
    for (const runDirectory of readdirSync(directory, { withFileTypes: true })) {
      if (!runDirectory.isDirectory()) continue;
      const worktree = join(directory, runDirectory.name);
      try {
        const [{ stdout: status }, { stdout: listing }, { stdout: head }] = await Promise.all([
          execFile('git', ['status', '--porcelain'], { cwd: worktree, timeout: 5_000, maxBuffer: 32_768 }),
          execFile('git', ['worktree', 'list', '--porcelain'], { cwd: worktree, timeout: 5_000, maxBuffer: 131_072 }),
          execFile('git', ['rev-parse', 'HEAD'], { cwd: worktree, timeout: 5_000, maxBuffer: 32_768 }),
        ]);
        if (status.trim()) continue;
        const primary = listing.split('\n').find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim();
        if (!primary) continue;
        const integrated = await execFile('git', ['merge-base', '--is-ancestor', head.trim(), 'main'], { cwd: primary, timeout: 5_000, maxBuffer: 32_768 })
          .then(() => true, () => false);
        if (!integrated) continue;
        await execFile('git', ['worktree', 'remove', '--force', worktree], { cwd: primary, timeout: 15_000, maxBuffer: 32_768 });
        removed += 1;
      } catch {
        // A manually removed or temporarily inaccessible worktree is skipped;
        // cleanup must never make a promotion fail.
      }
    }
  }
  return removed;
}
