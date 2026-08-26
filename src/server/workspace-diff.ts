import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { WorkspaceDiff, WorkspaceDiffFile } from '../shared/contracts.js';

const execFile = promisify(execFileCallback);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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
  return {
    workspacePath,
    branch: branch || 'detached HEAD',
    revision: workspaceDiffRevision(status, branch, patch, ...untrackedPatches),
    files,
    changedFiles: files.length,
    ...totals,
  };
}

/**
 * Keep an open diff stable while the workspace changes. This is intentionally
 * separate from the rendered snapshot so callers can opt into a refresh.
 */
export async function getWorkspaceDiffRevision(workspacePath: string) {
  return (await getWorkspaceDiff(workspacePath)).revision;
}
