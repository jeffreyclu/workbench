import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { WorkspaceDiff, WorkspaceDiffFile, WorkspacePublishResult, WorkspacePublishStatus } from '../shared/contracts.js';

const execFile = promisify(execFileCallback);
// Workspace diffs in the Writer monorepo routinely exceed Node's 1 MiB
// default and can exceed 8 MiB. Keep a finite cap so an unexpectedly huge
// repository does not consume unbounded server memory, while allowing the
// complete reviewable patch through to the diff UI.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

type ChangedFileStatus = WorkspaceDiffFile['status'];

function statusFor(code: string): ChangedFileStatus {
  if (code.includes('A') || code === '??') return 'added';
  if (code.includes('D')) return 'removed';
  if (code.includes('R')) return 'renamed';
  if (code.includes('C')) return 'copied';
  return 'modified';
}

function changedLines(patch: string) {
  return patch.split('\n').reduce((counts, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return counts;
    if (line.startsWith('+')) counts.additions += 1;
    if (line.startsWith('-')) counts.deletions += 1;
    return counts;
  }, { additions: 0, deletions: 0 });
}

/**
 * `git diff --no-renames` deliberately emits a rename as a removed file plus
 * an added file. Keep the porcelain metadata aligned with that reviewable
 * output instead of applying the rename state to only one half of the pair.
 */
export function workspaceStatuses(status: string): Map<string, ChangedFileStatus> {
  const statuses = new Map<string, ChangedFileStatus>();
  const entries = status.split('\0').filter(Boolean);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    const isRenameOrCopy = code.includes('R') || code.includes('C');

    if (isRenameOrCopy) {
      const originalPath = entries[index + 1];
      index += 1;
      if (code.includes('R')) {
        statuses.set(path, 'added');
        if (originalPath) statuses.set(originalPath, 'removed');
      } else {
        statuses.set(path, 'added');
      }
      continue;
    }

    statuses.set(path, statusFor(code));
  }

  return statuses;
}

/** Parse git's unified output into the workspace diff file shape. */
export function parseWorkspacePatch(patch: string, statuses = new Map<string, ChangedFileStatus>()): WorkspaceDiffFile[] {
  const sections = patch.split(/^diff --git /m).filter(Boolean);
  return sections.map((section) => {
    const lines = section.split('\n');
    const header = lines.shift() ?? '';
    const paths = header.match(/^a\/(.+) b\/(.+)$/);
    const oldPath = paths?.[1] ?? '';
    const newPath = paths?.[2] ?? oldPath;
    const status = statuses.get(newPath) ?? statuses.get(oldPath) ?? (section.includes('new file mode') ? 'added' : section.includes('deleted file mode') ? 'removed' : 'modified');
    const path = status === 'removed' ? oldPath : newPath;
    const body = lines.join('\n');
    const isBinary = /Binary files .* differ|GIT binary patch/.test(body);
    const counts = changedLines(body);
    return { path, status, additions: counts.additions, deletions: counts.deletions, previousPath: status === 'renamed' ? oldPath : null, patch: isBinary ? null : `diff --git ${header}\n${body}`, isBinary };
  }).filter((file) => file.path);
}

async function git(workspacePath: string, args: string[]) {
  return execFile('git', args, { cwd: workspacePath, maxBuffer: MAX_OUTPUT_BYTES, timeout: 10_000, encoding: 'utf8' });
}

async function gitOutput(workspacePath: string, args: string[]) {
  return (await git(workspacePath, args)).stdout.trim();
}

async function publishStatus(workspacePath: string, status: string, branch: string): Promise<WorkspacePublishStatus> {
  const hasChanges = status.split('\0').some(Boolean);
  if (!branch) return { branch: null, hasOrigin: false, ahead: 0, hasChanges, reason: 'Cannot publish from detached HEAD.' };

  let hasOrigin = false;
  try {
    await gitOutput(workspacePath, ['remote', 'get-url', 'origin']);
    hasOrigin = true;
  } catch { /* A local-only workspace cannot push. */ }
  if (!hasOrigin) return { branch, hasOrigin: false, ahead: 0, hasChanges, reason: 'This workspace has no origin remote.' };

  let ahead = 0;
  try { ahead = Number(await gitOutput(workspacePath, ['rev-list', '--count', '@{upstream}..HEAD'])) || 0; }
  catch { /* A new branch has no upstream yet; pushing HEAD still establishes it. */ }
  return { branch, hasOrigin: true, ahead, hasChanges, reason: null };
}

function workspaceDiffRevision(...parts: string[]) {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export async function getWorkspaceDiff(workspacePath: string): Promise<WorkspaceDiff> {
  let status: string;
  let branch: string;
  let patch: string;
  try {
    [status, branch, patch] = await Promise.all([
      git(workspacePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).then(({ stdout }) => stdout),
      git(workspacePath, ['branch', '--show-current']).then(({ stdout }) => stdout.trim()),
      git(workspacePath, ['diff', '--no-ext-diff', '--binary', '--no-color', '--no-renames', 'HEAD']).then(({ stdout }) => stdout),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Git could not read this workspace.';
    throw new Error(`Could not read local workspace changes. Confirm ${workspacePath} is a Git repository. ${message}`);
  }

  const untracked: string[] = [];
  for (const entry of status.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??') untracked.push(path);
  }
  const statuses = workspaceStatuses(status);

  const untrackedPatches = await Promise.all(untracked.map(async (path) => {
    try {
      const { stdout } = await git(workspacePath, ['diff', '--no-index', '--no-ext-diff', '--binary', '--no-color', '--', '/dev/null', path]);
      return stdout;
    } catch (error) {
      // git diff --no-index uses exit code 1 when it finds a difference.
      const output = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
      if (output) return output;
      throw error;
    }
  }));
  const files = parseWorkspacePatch(`${patch}${untrackedPatches.join('')}`, statuses);
  const totals = files.reduce((counts, file) => ({ additions: counts.additions + file.additions, deletions: counts.deletions + file.deletions }), { additions: 0, deletions: 0 });
  const publish = await publishStatus(workspacePath, status, branch);
  return {
    workspacePath,
    branch: branch || 'detached HEAD',
    revision: workspaceDiffRevision(status, branch, patch, ...untrackedPatches),
    files,
    changedFiles: files.length,
    ...totals,
    publish,
  };
}

/**
 * Regenerate a single file's patch with a wider unified-diff context than the
 * default 3 lines, so a reviewer can expand a hunk (or see the whole file)
 * without leaving the diff pane. A very large context naturally clips at the
 * file's boundaries and merges nearby hunks, which is exactly "whole file".
 */
export async function getWorkspaceFileDiff(workspacePath: string, filePath: string, context: number): Promise<string | null> {
  const status = await gitOutput(workspacePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const statuses = workspaceStatuses(status);
  const isUntracked = status.split('\0').filter(Boolean).some((entry) => entry.slice(0, 2) === '??' && entry.slice(3) === filePath);

  let stdout: string;
  if (isUntracked) {
    try {
      ({ stdout } = await git(workspacePath, ['diff', '--no-index', `-U${context}`, '--no-ext-diff', '--binary', '--no-color', '--', '/dev/null', filePath]));
    } catch (error) {
      // git diff --no-index uses exit code 1 when it finds a difference.
      const output = typeof error === 'object' && error !== null && 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '') : '';
      if (!output) throw error;
      stdout = output;
    }
  } else {
    ({ stdout } = await git(workspacePath, ['diff', `-U${context}`, '--no-ext-diff', '--binary', '--no-color', '--no-renames', 'HEAD', '--', filePath]));
  }

  const [file] = parseWorkspacePatch(stdout, statuses);
  return file?.patch ?? null;
}

/**
 * Rebuild a reviewable patch from a commit that an agent explicitly recorded
 * in the conversation. This is the recovery path for work committed outside
 * the Changes pane, before its uncommitted snapshot could be captured.
 */
export async function getWorkspaceCommitDiff(workspacePath: string, commitReference: string): Promise<WorkspaceDiff> {
  const commit = await gitOutput(workspacePath, ['rev-parse', '--verify', `${commitReference}^{commit}`]);
  const [branchResult, patchResult] = await Promise.all([
    git(workspacePath, ['branch', '--show-current']),
    git(workspacePath, ['show', '--format=', '--no-ext-diff', '--binary', '--no-color', '--no-renames', commit]),
  ]);
  const files = parseWorkspacePatch(patchResult.stdout);
  const totals = files.reduce((counts, file) => ({ additions: counts.additions + file.additions, deletions: counts.deletions + file.deletions }), { additions: 0, deletions: 0 });
  const branch = branchResult.stdout.trim() || 'detached HEAD';
  return {
    workspacePath,
    branch,
    revision: `commit:${commit}`,
    files,
    changedFiles: files.length,
    ...totals,
    // Historic records are read-only. The view disables publishing while a
    // recorded version is selected, so this status is intentionally inert.
    publish: { branch, hasOrigin: false, ahead: 0, hasChanges: false, reason: null },
  };
}

/**
 * Keep an open diff stable while the workspace changes. This is intentionally
 * separate from the rendered snapshot so callers can opt into a refresh.
 */
export async function getWorkspaceDiffRevision(workspacePath: string) {
  return (await getWorkspaceDiff(workspacePath)).revision;
}

/** Full HEAD identifier recorded alongside an immutable workspace snapshot. */
export async function getWorkspaceHeadCommit(workspacePath: string): Promise<string | null> {
  try {
    return await gitOutput(workspacePath, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    return null;
  }
}

function gitFailure(error: unknown) {
  if (typeof error !== 'object' || error === null) return 'Git command failed.';
  const result = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [result.stderr, result.stdout, result.message].map((part) => String(part ?? '').trim()).find(Boolean) ?? 'Git command failed.';
}

/** Stage the reviewed workspace, create one commit, then publish the current branch. */
export async function commitAndPushWorkspace(workspacePath: string, message: string, expectedRevision: string): Promise<WorkspacePublishResult> {
  const before = await getWorkspaceDiff(workspacePath);
  if (before.revision !== expectedRevision) throw new Error('Workspace changed since this diff was opened. Refresh changes before committing.');
  if (before.publish.reason) throw new Error(before.publish.reason);

  let committed = false;
  let commit: string | null = null;
  try {
    if (before.publish.hasChanges) {
      await git(workspacePath, ['add', '--all']);
      await git(workspacePath, ['commit', '-m', message]);
      committed = true;
      commit = await gitOutput(workspacePath, ['rev-parse', '--short', 'HEAD']);
    }
    const afterCommit = await getWorkspaceDiff(workspacePath);
    if (afterCommit.publish.ahead === 0) throw new Error('There are no commits to push.');
    await git(workspacePath, ['push', '--set-upstream', 'origin', 'HEAD']);
    return { committed, pushed: true, commit };
  } catch (error) {
    const prefix = committed ? 'Commit created, but push failed.' : 'Could not commit and push.';
    throw new Error(`${prefix} ${gitFailure(error)}`);
  }
}
