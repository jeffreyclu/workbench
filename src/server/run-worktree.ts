import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
let integrationTail: Promise<void> = Promise.resolve();

function changedPaths(cwd: string, range: string[]): Set<string> {
  const output = execFileSync('git', ['diff', '--name-only', '-z', ...range], { cwd, encoding: 'utf8', timeout: 5_000, maxBuffer: 1_000_000 });
  return new Set(output.split('\0').filter(Boolean));
}

function untrackedPaths(cwd: string): string[] {
  const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8', timeout: 5_000, maxBuffer: 1_000_000 });
  return output.split('\0').filter(Boolean);
}

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
 * main, and left available for the normal explicit promotion flow. Integration
 * is index-only so an unrelated, uncommitted edit in the primary checkout is
 * preserved rather than stranding a completed run.
 */
export function integrateWorkbenchRunWorktree(sourceWorkspace: string, worktree: string, runId: string, isolate = shouldIsolateRunWorkspace(sourceWorkspace)): Promise<{ integrated: boolean; commitHash: string | null }> {
  const source = resolve(sourceWorkspace);
  const detached = resolve(worktree);
  if (!isolate || source === detached) return Promise.resolve({ integrated: false, commitHash: null });
  const task = integrationTail.then(() => {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: source, encoding: 'utf8', timeout: 5_000 }).trim();
    if (branch !== 'main') throw new Error(`Workbench worktree integration requires main; found ${branch || 'detached HEAD'}.`);
    // Remember every tracked file the primary checkout had already changed.
    // Those paths are user/WIP territory and must not be refreshed below.
    const primaryDirtyPaths = changedPaths(source, ['HEAD']);
    // `git diff HEAD` omits untracked files. Mark them intent-to-add in the
    // detached tree so its binary patch includes newly created source files;
    // the detached tree is reset after successful integration.
    const untracked = untrackedPaths(detached);
    if (untracked.length) execFileSync('git', ['add', '--intent-to-add', '--', ...untracked], { cwd: detached, stdio: 'ignore', timeout: 15_000 });
    const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: detached, encoding: 'utf8', timeout: 15_000, maxBuffer: 4_000_000 });
    if (!patch.trim()) return { integrated: false, commitHash: null };
    try {
      // Do not use `git apply --index` here: it insists that the primary
      // working tree is clean. `--cached` applies the completed run's patch
      // against HEAD in the index only, so local edits remain exactly as they
      // were while the integration commit contains only this run.
      execFileSync('git', ['apply', '--3way', '--cached', '-'], { cwd: source, input: patch, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
      execFileSync('git', ['commit', '-m', `feat: integrate Workbench agent run ${runId}`], { cwd: source, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
      const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', timeout: 5_000 }).trim();
      // `--cached` intentionally leaves the working tree alone. Refresh only
      // files created by this commit that were clean before integration;
      // otherwise a clean primary would appear dirty after every handoff.
      const integratedPaths = [...changedPaths(source, ['HEAD^', 'HEAD'])].filter((path) => !primaryDirtyPaths.has(path));
      if (integratedPaths.length) {
        execFileSync('git', ['checkout', '--quiet', 'HEAD', '--', ...integratedPaths], { cwd: source, stdio: 'ignore', timeout: 15_000 });
      }
      // The exact patch now exists in main. Clear the detached copy so the
      // post-promotion collector can remove this worktree without retaining
      // duplicate staged edits.
      execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: detached, stdio: 'ignore', timeout: 15_000 });
      return { integrated: true, commitHash };
    } catch (error) {
      // `git apply --cached` may leave conflict entries. Reset only the index;
      // never reset the primary working tree, which may contain a user's
      // unrelated work. The detached run tree remains intact for recovery.
      try { execFileSync('git', ['reset', '--mixed', 'HEAD'], { cwd: source, stdio: 'ignore', timeout: 15_000 }); } catch { /* Preserve the original integration error. */ }
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
