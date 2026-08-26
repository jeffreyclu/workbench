import { execFile as execFileCallback } from 'node:child_process';
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

  const statuses = new Map<string, ChangedFileStatus>();
  const untracked: string[] = [];
  for (const entry of status.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??') untracked.push(path);
    statuses.set(path, statusFor(code));
  }

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
  return { workspacePath, branch: branch || 'detached HEAD', files, changedFiles: files.length, ...totals };
}
