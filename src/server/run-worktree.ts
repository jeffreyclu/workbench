import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

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
