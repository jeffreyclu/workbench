import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
let integrationTail: Promise<void> = Promise.resolve();

// Dependencies and runtime output are local machine state, never Workbench
// source. A nested Git repository here is reported as a gitlink and can make
// `git checkout HEAD -- node_modules` erase the local executable shims.
function isIntegrationExcludedPath(path: string): boolean {
  return path === 'node_modules' || path.startsWith('node_modules/')
    || path === '.workbench-runtime' || path.startsWith('.workbench-runtime/');
}

const integrationPathspec = ['.', ':(exclude)node_modules', ':(exclude).workbench-runtime'];

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
 * A Git worktree contains tracked source only. Reuse the primary checkout's
 * installed dependency tree so an isolated agent can run focused checks without
 * spending time and disk on a second install. The link is ignored source state,
 * excluded from integration, and is removed with the worktree—not its target.
 */
export function provisionRunWorktreeDependencies(repository: string, worktree: string): void {
  // A trailing-slash `node_modules/` ignore does not match a symlink on every
  // Git version. Record a local, uncommitted repository exclusion so the
  // dependency links never appear as agent-authored source changes, including
  // in projects whose checked-in .gitignore does not mention node_modules.
  try {
    const reported = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: repository, encoding: 'utf8', timeout: 5_000 }).trim();
    const excludePath = resolve(repository, reported);
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    if (!existing.split(/\r?\n/).includes('node_modules')) {
      mkdirSync(dirname(excludePath), { recursive: true });
      appendFileSync(excludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}# Workbench run-worktree dependency links\nnode_modules\n`);
    }
  } catch { /* Integration also excludes dependency paths if local ignore setup fails. */ }
  let manifests = ['package.json'];
  try {
    manifests = execFileSync('git', ['ls-files', '-z', '--', 'package.json', ':(glob)**/package.json'], { cwd: repository, encoding: 'utf8', timeout: 5_000, maxBuffer: 2_000_000 })
      .split('\0')
      .filter(Boolean);
  } catch { /* Root dependency provisioning still works outside a healthy Git index. */ }
  for (const relativeRoot of new Set(manifests.map((manifest) => dirname(manifest)).concat('.'))) {
    const source = join(repository, relativeRoot, 'node_modules');
    const destination = join(worktree, relativeRoot, 'node_modules');
    if (!existsSync(source)) continue;
    try {
      lstatSync(destination);
      continue;
    } catch { /* This package root has no dependency entry yet. */ }
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(source, destination, 'dir');
  }
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
    // Also runs for an existing destination so retries repair worktrees created
    // by older runtimes instead of asking the agent to install dependencies.
    provisionRunWorktreeDependencies(repository, destination);
    return destination;
  } catch {
    // Scratch directories and a broken Git installation must not prevent a
    // task from running. Real repositories use the isolated path above.
    return source;
  }
}

type IntegrationOutcome = { integrated: boolean; commitHash: string | null; conflicted: string[]; blocked: string | null };

const notIntegrated = (blocked: string | null = null): IntegrationOutcome => ({ integrated: false, commitHash: null, conflicted: [], blocked });

/** First meaningful line of a Git failure: the cause, without the command noise. */
function integrationBlocker(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Unknown integration failure.';
}

/** Paths a single-file patch block touches, read from its header only so hunk
 * body lines can never be mistaken for a file header. */
function patchPaths(block: string): string[] {
  const paths = new Set<string>();
  for (const line of block.split('\n')) {
    if (line.startsWith('@@') || line === 'GIT binary patch') break;
    const match = /^(?:---|\+\+\+) [ab]\/(.*)$/.exec(line);
    if (match) paths.add(match[1]);
  }
  if (!paths.size) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(block.split('\n')[0] ?? '');
    if (header) { paths.add(header[1]); paths.add(header[2]); }
  }
  return [...paths];
}

/** Split a `git diff --binary` patch into self-contained per-file patches so
 * one conflicting file cannot discard the rest of a completed run. */
function splitPatchByFile(patch: string): { paths: string[]; patch: string }[] {
  return patch.split(/^(?=diff --git )/m)
    .filter((block) => block.startsWith('diff --git '))
    .map((block) => ({ paths: patchPaths(block), patch: block }));
}

/**
 * The only valid exit path for a dirty Workbench run worktree. Its patch is
 * applied to the primary main checkout under one in-process FIFO, committed on
 * main, and left available for the normal explicit promotion flow. Integration
 * is index-only so an unrelated, uncommitted edit in the primary checkout is
 * preserved rather than stranding a completed run.
 *
 * Main advances while a run works, so a long run's patch can conflict on a hot
 * file. That conflict is partial almost every time: integration therefore falls
 * back to per-file application and reports the files it could not take, instead
 * of discarding an entire completed run's output.
 *
 * This never rejects. Integration reports what it could not take; it does not
 * get to decide whether a run finished. Every failure path leaves the run's
 * work in its detached worktree and the primary working tree untouched, so a
 * blocked integration costs a recoverable commit, not the run.
 */
export function integrateWorkbenchRunWorktree(sourceWorkspace: string, worktree: string, runId: string, isolate = shouldIsolateRunWorkspace(sourceWorkspace)): Promise<IntegrationOutcome> {
  const source = resolve(sourceWorkspace);
  const detached = resolve(worktree);
  if (!isolate || source === detached) return Promise.resolve(notIntegrated());
  const task = integrationTail.then((): IntegrationOutcome => {
    const resetIndex = () => {
      // Never reset the primary working tree, which may contain a user's
      // unrelated work. Only the index is integration's to manage.
      try { execFileSync('git', ['reset', '--mixed', 'HEAD'], { cwd: source, stdio: 'ignore', timeout: 15_000 }); } catch { /* Preserve the original integration error. */ }
    };
    try {
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd: source, encoding: 'utf8', timeout: 5_000 }).trim();
      // A primary checkout parked off main is a property of the workspace, not a
      // defect in the run that just finished. Report it and leave the work in the
      // detached tree; do not throw, which would discard the completed run.
      if (branch !== 'main') return notIntegrated(`integration requires the primary checkout on main; found ${branch || 'detached HEAD'}. The run's changes stay in ${detached}.`);
      // Remember every tracked file the primary checkout had already changed.
      // Those paths are user/WIP territory and must not be refreshed below.
      const primaryDirtyPaths = changedPaths(source, ['HEAD']);
      // `git diff HEAD` omits untracked files. Mark them intent-to-add in the
      // detached tree so its binary patch includes newly created source files;
      // the detached tree is reset after successful integration.
      const untracked = untrackedPaths(detached).filter((path) => !isIntegrationExcludedPath(path));
      if (untracked.length) execFileSync('git', ['add', '--intent-to-add', '--', ...untracked], { cwd: detached, stdio: 'ignore', timeout: 15_000 });
      const patch = execFileSync('git', ['diff', '--binary', 'HEAD', '--', ...integrationPathspec], { cwd: detached, encoding: 'utf8', timeout: 15_000, maxBuffer: 4_000_000 });
      if (!patch.trim()) return notIntegrated();

      const commitStagedIntegration = (conflicted: string[]): IntegrationOutcome => {
        const message = conflicted.length
          ? `feat: integrate Workbench agent run ${runId} (${conflicted.length} conflicting file(s) left in the run worktree)`
          : `feat: integrate Workbench agent run ${runId}`;
        execFileSync('git', ['commit', '-m', message], { cwd: source, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
        const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', timeout: 5_000 }).trim();
        // `--cached` intentionally leaves the working tree alone. Refresh only
        // files created by this commit that were clean before integration;
        // otherwise a clean primary would appear dirty after every handoff.
        const integratedPaths = [...changedPaths(source, ['HEAD^', 'HEAD'])].filter((path) => !primaryDirtyPaths.has(path) && !isIntegrationExcludedPath(path));
        if (integratedPaths.length) {
          execFileSync('git', ['checkout', '--quiet', 'HEAD', '--', ...integratedPaths], { cwd: source, stdio: 'ignore', timeout: 15_000 });
        }
        // Only a fully integrated run may be cleared. When files conflicted, the
        // detached copy is the sole remaining home of that work and must survive
        // for recovery -- and its dirty state keeps the collector away from it.
        if (!conflicted.length) execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: detached, stdio: 'ignore', timeout: 15_000 });
        return { integrated: true, commitHash, conflicted, blocked: null };
      };

      try {
        // Do not use `git apply --index` here: it insists that the primary
        // working tree is clean. `--cached` applies the completed run's patch
        // against HEAD in the index only, so local edits remain exactly as they
        // were while the integration commit contains only this run.
        execFileSync('git', ['apply', '--3way', '--cached', '-'], { cwd: source, input: patch, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
        return commitStagedIntegration([]);
    } catch (error) {
      // `git apply --cached` may leave conflict entries behind. Drop the
      // half-applied index, then retry a file at a time so every clean file
      // still lands and only genuinely conflicting files are held back.
      resetIndex();
      const files = splitPatchByFile(patch);
      const conflicted: string[] = [];
      let applied = 0;
      for (const file of files) {
        try {
          execFileSync('git', ['apply', '--3way', '--cached', '-'], { cwd: source, input: file.patch, encoding: 'utf8', timeout: 30_000, maxBuffer: 4_000_000 });
          applied += 1;
        } catch {
          conflicted.push(...file.paths);
          // Unmerged stages block the commit below. Clear just this file's
          // entries so the work that did apply stays committable.
          for (const path of file.paths) {
            try { execFileSync('git', ['reset', '--quiet', 'HEAD', '--', path], { cwd: source, stdio: 'ignore', timeout: 15_000 }); } catch { /* The path need not exist in HEAD. */ }
          }
        }
      }
      if (!applied) {
        resetIndex();
        // Nothing could be taken, but the detached tree still holds all of it.
        // Name every file and the cause rather than failing the run.
        return { integrated: false, commitHash: null, conflicted: [...new Set(files.flatMap((file) => file.paths))], blocked: integrationBlocker(error) };
      }
      return commitStagedIntegration([...new Set(conflicted)]);
    }
    } catch (error) {
      // Any other Git failure (a lock, a hook, a timeout) is likewise the
      // workspace's problem, not the run's. Leave the index as we found it.
      resetIndex();
      return notIntegrated(integrationBlocker(error));
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
