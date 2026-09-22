import { execFile as execFileCallback } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DEVELOPMENT_ROOT } from './run-worktree.js';
import { listCandidateWorkspaces } from './workspace-candidates.js';

const execFile = promisify(execFileCallback);
const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_STALE_GIT_DAYS = (() => {
  const configured = Number.parseInt(process.env.WORKBENCH_STALE_GIT_DAYS ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 14;
})();

interface WorktreeRecord {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
}

export interface WorkspaceMaintenanceResult {
  worktrees: string[];
  branches: Array<{ repository: string; branch: string }>;
  skipped: string[];
}

const insideDevelopmentRoot = (path: string) => {
  const candidate = resolve(path);
  return candidate !== DEVELOPMENT_ROOT && candidate.startsWith(`${DEVELOPMENT_ROOT}/`);
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 1_000_000 });
  return stdout.trim();
}

function parseWorktrees(output: string): WorktreeRecord[] {
  return output.split(/\n\n+/).flatMap((block) => {
    const fields = block.split('\n');
    const path = fields.find((line) => line.startsWith('worktree '))?.slice(9);
    const head = fields.find((line) => line.startsWith('HEAD '))?.slice(5);
    if (!path || !head) return [];
    return [{
      path: resolve(path),
      head,
      branch: fields.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
      locked: fields.some((line) => line === 'locked' || line.startsWith('locked ')),
    }];
  });
}

async function defaultBranchRef(repository: string): Promise<string | null> {
  try {
    const remote = await git(repository, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    if (remote) return remote;
  } catch { /* A local-only repository has no remote default. */ }
  for (const branch of ['main', 'develop', 'master']) {
    try {
      await git(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      return `refs/heads/${branch}`;
    } catch { /* Try the next conventional default. */ }
  }
  return null;
}

async function isAncestor(repository: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repository, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove stale Git state only after proving it is clean, old, and fully merged.
 * Remote refs are never mutated. `dryRun` returns the exact safe targets.
 */
export async function cleanupStaleLocalGitState(options: {
  workspaces?: readonly string[];
  staleBefore?: number;
  dryRun?: boolean;
} = {}): Promise<WorkspaceMaintenanceResult> {
  const result: WorkspaceMaintenanceResult = { worktrees: [], branches: [], skipped: [] };
  const staleBefore = options.staleBefore ?? Date.now() - DEFAULT_STALE_GIT_DAYS * DAY_MS;
  const commonDirectories = new Set<string>();

  for (const candidate of options.workspaces ?? listCandidateWorkspaces()) {
    if (!insideDevelopmentRoot(candidate)) continue;
    try {
      const commonDirectory = resolve(candidate, await git(candidate, ['rev-parse', '--git-common-dir']));
      if (commonDirectories.has(commonDirectory)) continue;
      commonDirectories.add(commonDirectory);

      let worktrees = parseWorktrees(await git(candidate, ['worktree', 'list', '--porcelain']));
      const primary = worktrees[0]?.path;
      if (!primary || !insideDevelopmentRoot(primary)) continue;
      const base = await defaultBranchRef(primary);
      if (!base) {
        result.skipped.push(`${primary}: no default branch`);
        continue;
      }

      let removedWorktrees = 0;
      for (const worktree of worktrees.slice(1)) {
        if (!insideDevelopmentRoot(worktree.path) || worktree.locked) continue;
        const dirty = await git(worktree.path, ['status', '--porcelain']);
        if (dirty) continue;
        // Commit age alone is unsafe: a worktree created today can point at an
        // old commit. Require the checkout and its Git link to both be stale.
        const [directoryStat, gitLinkStat] = await Promise.all([stat(worktree.path), stat(join(worktree.path, '.git'))]);
        if (Math.max(directoryStat.mtimeMs, gitLinkStat.mtimeMs) >= staleBefore) continue;
        const committedAt = Number.parseInt(await git(worktree.path, ['show', '-s', '--format=%ct', worktree.head]), 10) * 1_000;
        if (!Number.isFinite(committedAt) || committedAt >= staleBefore) continue;
        if (!await isAncestor(primary, worktree.head, base)) continue;
        if (!options.dryRun) await git(primary, ['worktree', 'remove', worktree.path]);
        result.worktrees.push(worktree.path);
        removedWorktrees += 1;
      }

      if (!options.dryRun && removedWorktrees) {
        await git(primary, ['worktree', 'prune', '--expire', 'now']);
        worktrees = parseWorktrees(await git(primary, ['worktree', 'list', '--porcelain']));
      }
      const checkedOut = new Set(worktrees.flatMap((worktree) => worktree.branch ? [worktree.branch] : []));
      const protectedBranches = new Set(['main', 'master', 'develop', base.replace(/^refs\/(?:heads|remotes\/origin)\//, '')]);
      const branches = (await git(primary, ['for-each-ref', '--format=%(refname:short)\t%(committerdate:unix)', 'refs/heads']))
        .split('\n').filter(Boolean);
      for (const line of branches) {
        const [branch, seconds] = line.split('\t');
        const committedAt = Number.parseInt(seconds, 10) * 1_000;
        if (!branch || checkedOut.has(branch) || protectedBranches.has(branch) || !Number.isFinite(committedAt) || committedAt >= staleBefore) continue;
        if (!await isAncestor(primary, branch, base)) continue;
        if (options.dryRun) result.branches.push({ repository: primary, branch });
        else try {
          await git(primary, ['branch', '-d', branch]);
          result.branches.push({ repository: primary, branch });
        } catch { result.skipped.push(`${primary}: Git refused to delete ${branch}`); }
      }
    } catch (error) {
      result.skipped.push(`${candidate}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  return result;
}
