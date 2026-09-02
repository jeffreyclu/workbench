import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ReviewCommit, WorkspaceBranchRef, WorkspaceDiff, WorkspaceDiffFile, WorkspaceFileSource, WorkspacePublishResult, WorkspacePublishStatus, WorkspaceRefs, WorkspaceWorktreeRef } from '../shared/contracts.js';
import { patchLogicBoundaries } from './review-logic-primitives.js';

const execFile = promisify(execFileCallback);
// Workspace diffs in the Writer monorepo routinely exceed Node's 1 MiB
// default and can exceed 8 MiB. Keep a finite cap so an unexpectedly huge
// repository does not consume unbounded server memory, while allowing the
// complete reviewable patch through to the diff UI.
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

type ChangedFileStatus = WorkspaceDiffFile['status'];

const DEFAULT_EDITOR_URL_TEMPLATE = 'vscode://file/{path}';

function isWithinWorkspace(workspacePath: string, candidatePath: string) {
  const path = relative(workspacePath, candidatePath);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** Recover from a stale/deleted subdirectory persisted by an older run. */
export function resolveWorkspaceRepository(workspacePath: string): string {
  let candidate = resolve(workspacePath);
  while (!existsSync(candidate) && candidate !== dirname(candidate)) candidate = dirname(candidate);
  if (existsSync(candidate) && !statSync(candidate).isDirectory()) candidate = dirname(candidate);
  for (;;) {
    if (existsSync(join(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(workspacePath);
    candidate = parent;
  }
}

/**
 * Build a configurable deep link only for files in an available local
 * checkout. `WORKBENCH_EDITOR_URL_TEMPLATE` accepts `{path}` and defaults to
 * VS Code's URL scheme, so another local editor can be selected at startup.
 */
export function workspaceEditorUrl(workspacePath: string, filePath: string, template = process.env.WORKBENCH_EDITOR_URL_TEMPLATE ?? DEFAULT_EDITOR_URL_TEMPLATE): string | null {
  const absolutePath = resolve(workspacePath, filePath);
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory() || !isWithinWorkspace(workspacePath, absolutePath)) return null;
  return template.includes('{path}') ? template.replaceAll('{path}', encodeURI(absolutePath)) : null;
}

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
    // Anchored, because these markers are lines Git emits at body level - never
    // inside a hunk, where every line carries a leading space, `+` or `-`. Left
    // unanchored, any source file that merely mentions them (this one does, just
    // above) was read as binary and had its patch dropped to null: no diff to
    // read, and no boundaries for the Review splitter to cut on.
    const isBinary = /^Binary files .* differ$|^GIT binary patch$/m.test(body);
    const counts = changedLines(body);
    const patchText = isBinary ? null : `diff --git ${header}\n${body}`;
    // The boundaries travel with the file because the split happens in the
    // browser, where the TypeScript compiler cannot go. Every diff source
    // funnels through this parse, so attaching here covers the working tree,
    // a recorded commit, and anything the repo selector gains later.
    const logicBlocks = patchText ? patchLogicBoundaries(path, patchText) : [];
    return { path, status, additions: counts.additions, deletions: counts.deletions, previousPath: status === 'renamed' ? oldPath : null, patch: patchText, isBinary, ...(logicBlocks.length > 0 ? { logicBlocks } : {}) };
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

/** A commit subject can contain anything a keyboard can type, so the fields
 * are separated by a unit separator rather than by punctuation. */
const COMMIT_FIELD = '\u001f';
const MAX_LISTED_COMMITS = 300;

export function parseCommitLog(log: string): ReviewCommit[] {
  return log.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sha, title, author, committedAt] = line.split(COMMIT_FIELD);
    return { sha, shortSha: sha.slice(0, 7), title: title ?? '', author: author || null, committedAt: committedAt || null };
  });
}

function workspaceDiffRevision(...parts: string[]) {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/**
 * Identity of the repository a checkout belongs to. Linked worktrees each own
 * a `.git` file and therefore their own root path, yet they share one Git
 * directory - so the common directory, not the path, decides whether two
 * checkouts are the same repository.
 */
export async function repositoryIdentity(workspacePath: string): Promise<string | null> {
  try {
    return await gitOutput(resolveWorkspaceRepository(workspacePath), ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch {
    return null;
  }
}

/**
 * The same identity, for the one caller that cannot await: schema migrations
 * run synchronously. Never call this on a request path.
 */
export function repositoryIdentitySync(workspacePath: string): string | null {
  // A path that no longer exists must stay unidentified. Resolving it would
  // walk up to whatever repository happens to contain its parent directory,
  // which is how a collected run worktree acquires a foreign identity.
  if (!existsSync(workspacePath)) return null;
  try {
    const identity = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: resolveWorkspaceRepository(workspacePath),
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
    }).trim();
    return identity || null;
  } catch {
    return null;
  }
}

/**
 * Keep only the records belonging to the selected checkout's repository. A
 * conversation or task can be pointed at several repositories over its life,
 * and another repository's history is not this one's: offering it makes the
 * repository picker lie about what the review surface is showing. A recorded
 * record is matched on the repository identity written when it was captured;
 * a path is only re-read for legacy records that predate that. A record that
 * can be attributed to no repository is dropped - showing it in every
 * repository is the failure this exists to prevent.
 */
export async function snapshotsForRepository<T extends { repositoryIdentity: string | null; diff: { workspacePath: string } }>(snapshots: T[], workspacePath: string): Promise<T[]> {
  const identity = await repositoryIdentity(workspacePath);
  // Only paths still on disk are worth asking Git about. Everything else has
  // to rely on the identity recorded when the record was captured.
  const identities = new Map<string, string | null>();
  for (const path of new Set(snapshots.filter((snapshot) => !snapshot.repositoryIdentity).map((snapshot) => snapshot.diff.workspacePath))) {
    identities.set(path, existsSync(path) ? await repositoryIdentity(path) : null);
  }
  const attributedTo = (snapshot: T) => snapshot.repositoryIdentity ?? identities.get(snapshot.diff.workspacePath) ?? null;
  // A directory Git will not identify - not a repository at all, or one it
  // refuses to read - is not "every repository". Returning the whole timeline
  // for it was the leak itself: it put one repository's records on screen
  // under a different repository's name in the picker. Such a checkout can
  // only own the records captured from that exact path.
  if (!identity) return snapshots.filter((snapshot) => attributedTo(snapshot) === null && snapshot.diff.workspacePath === workspacePath);
  return snapshots.filter((snapshot) => attributedTo(snapshot) === identity);
}

export async function getWorkspaceDiff(workspacePath: string): Promise<WorkspaceDiff> {
  const repositoryPath = resolveWorkspaceRepository(workspacePath);
  let status: string;
  let branch: string;
  let patch: string;
  try {
    [status, branch, patch] = await Promise.all([
      git(repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).then(({ stdout }) => stdout),
      git(repositoryPath, ['branch', '--show-current']).then(({ stdout }) => stdout.trim()),
      git(repositoryPath, ['diff', '--no-ext-diff', '--binary', '--no-color', '--no-renames', 'HEAD']).then(({ stdout }) => stdout),
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
    // Git reports nested repositories and generated directories (notably
    // node_modules) as a single untracked directory entry. `git diff
    // --no-index` cannot produce a file patch for one; skip it rather than
    // failing the entire Changes view.
    const absolutePath = resolve(repositoryPath, path);
    try {
      if (!statSync(absolutePath).isFile()) return '';
    } catch { return ''; }
    try {
      // The path is passed relative to the repository root, never absolutely.
      // `--no-index` names the file in the patch header exactly as it was
      // given, so an absolute argument produces `+++ b/Users/you/repo/file`:
      // every new file would then be listed, opened and recorded under a path
      // that does not exist in the repository. `/dev/null` stays absolute and
      // is still read as the empty side because Git special-cases it.
      const { stdout } = await git(repositoryPath, ['diff', '--no-index', '--no-ext-diff', '--binary', '--no-color', '--', '/dev/null', relative(repositoryPath, absolutePath)]);
      return stdout;
    } catch (error) {
      // git diff --no-index uses exit code 1 when it finds a difference.
      const output = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout ?? '') : '';
      if (output) return output;
      throw error;
    }
  }));
  const files = parseWorkspacePatch(`${patch}${untrackedPatches.join('')}`, statuses)
    .map((file) => ({ ...file, editorUrl: workspaceEditorUrl(repositoryPath, file.path) }));
  const totals = files.reduce((counts, file) => ({ additions: counts.additions + file.additions, deletions: counts.deletions + file.deletions }), { additions: 0, deletions: 0 });
  const publish = await publishStatus(repositoryPath, status, branch);
  return {
    workspacePath: repositoryPath,
    branch: branch || 'detached HEAD',
    revision: workspaceDiffRevision(status, branch, patch, ...untrackedPatches),
    files,
    changedFiles: files.length,
    ...totals,
    publish,
  };
}

/**
 * Rebuild a reviewable patch from a commit that an agent explicitly recorded
 * in the conversation. This is the recovery path for work committed outside
 * the Changes pane, before its uncommitted snapshot could be captured.
 */
export async function getWorkspaceCommitDiff(workspacePath: string, commitReference: string): Promise<WorkspaceDiff> {
  const repositoryPath = resolveWorkspaceRepository(workspacePath);
  const commit = await gitOutput(repositoryPath, ['rev-parse', '--verify', `${commitReference}^{commit}`]);
  const [branchResult, patchResult] = await Promise.all([
    git(repositoryPath, ['branch', '--show-current']),
    git(repositoryPath, ['show', '--format=', '--no-ext-diff', '--binary', '--no-color', '--no-renames', commit]),
  ]);
  const files = parseWorkspacePatch(patchResult.stdout)
    .map((file) => ({ ...file, editorUrl: workspaceEditorUrl(repositoryPath, file.path) }));
  const totals = files.reduce((counts, file) => ({ additions: counts.additions + file.additions, deletions: counts.deletions + file.deletions }), { additions: 0, deletions: 0 });
  const branch = branchResult.stdout.trim() || 'detached HEAD';
  return {
    workspacePath: repositoryPath,
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
    return await gitOutput(resolveWorkspaceRepository(workspacePath), ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch {
    return null;
  }
}

/** How much of a file whole-file reading will carry. A pane that has to render
 * a megabyte of source stops being a reading surface, and the patch window is
 * still there — so an oversized file declines rather than degrading the pane. */
const MAX_FILE_SOURCE_BYTES = 512 * 1024;

/** The whole text of one file, so a block can be read in its real surroundings.
 *
 * A patch carries three lines of context: enough to see that code changed,
 * not enough to judge a refactor whose meaning lives in the code around it.
 * A `revision` reads that commit's copy; omitting it reads the working tree,
 * because an uncommitted diff's after-state is the file on disk and no commit
 * holds it yet.
 *
 * Unreadable is an ordinary answer rather than an error. A file can be
 * deleted, binary, absent from the commit, or simply too large to read as one
 * page; the caller gets a reason it can show and keeps the patch it already
 * has. */
export async function getWorkspaceFileSource(workspacePath: string, filePath: string, revision?: string | null): Promise<WorkspaceFileSource> {
  const repository = resolveWorkspaceRepository(workspacePath);
  const answer = (content: string | null, unavailable: string | null): WorkspaceFileSource =>
    ({ path: filePath, revision: revision ?? null, content, unavailable });
  // The path arrives from a URL, so it is checked as input rather than trusted
  // because a diff produced it: no absolute path and no parent traversal.
  if (!filePath || isAbsolute(filePath) || filePath.split('/').includes('..')) return answer(null, 'That path cannot be read.');

  let text: string;
  if (revision) {
    try { text = (await git(repository, ['show', `${revision}:${filePath}`])).stdout; }
    catch { return answer(null, 'This file is not in that revision.'); }
  } else {
    const absolute = resolve(repository, filePath);
    if (!isWithinWorkspace(repository, absolute) || !existsSync(absolute)) return answer(null, 'This file is not in the working tree.');
    text = await readFile(absolute, 'utf8');
  }
  if (text.includes('\0')) return answer(null, 'This file is binary.');
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_SOURCE_BYTES) return answer(null, 'This file is too large to read whole.');
  return answer(text, null);
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

// Reviewing a branch or a linked worktree is the same reading task as
// reviewing the working tree, so both resolve to a WorkspaceDiff and join the
// existing review source list rather than growing a surface of their own.

const BASE_BRANCH_CANDIDATES = ['main', 'master', 'trunk'];
/** Enumerating branches costs one rev-list each; a repository with hundreds of
 * stale branches must not turn the source list into a git storm. */
const MAX_LISTED_BRANCHES = 50;

/** What a branch is worth reviewing against. Prefers whatever origin calls its
 * default, because that is the branch the work will actually merge into. */
async function defaultBaseBranch(repositoryPath: string): Promise<string | null> {
  try {
    const head = await gitOutput(repositoryPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    const name = head.replace(/^origin\//, '');
    if (name) return name;
  } catch { /* No origin, or origin/HEAD was never recorded locally. */ }
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    try {
      await gitOutput(repositoryPath, ['rev-parse', '--verify', `${candidate}^{commit}`]);
      return candidate;
    } catch { /* Try the next conventional name. */ }
  }
  return null;
}

/** macOS hands out symlinked temp and home paths and git always answers with
 * the resolved one, so worktree identity is decided by what the filesystem
 * says rather than by the string a caller happened to type. */
function canonicalPath(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** `git worktree list --porcelain` emits blank-line separated records of
 * `worktree <path>` / `HEAD <sha>` / `branch <ref>` or `detached`. */
export function parseWorktreeList(porcelain: string, currentPath: string): WorkspaceWorktreeRef[] {
  const worktrees: WorkspaceWorktreeRef[] = [];
  for (const record of porcelain.split(/\n\s*\n/)) {
    const lines = record.split('\n').map((line) => line.trim()).filter(Boolean);
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!path) continue;
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    worktrees.push({ path, branch: branchRef?.replace(/^refs\/heads\//, '') ?? null, current: canonicalPath(path) === canonicalPath(currentPath) });
  }
  return worktrees;
}

export async function listWorkspaceRefs(workspacePath: string): Promise<WorkspaceRefs> {
  const repositoryPath = resolveWorkspaceRepository(workspacePath);
  const [base, names, current, worktreeList] = await Promise.all([
    defaultBaseBranch(repositoryPath),
    gitOutput(repositoryPath, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
    gitOutput(repositoryPath, ['branch', '--show-current']),
    gitOutput(repositoryPath, ['worktree', 'list', '--porcelain']),
  ]);
  const candidates = names.split('\n').map((line) => line.trim()).filter(Boolean)
    .filter((name) => name !== base)
    .slice(0, MAX_LISTED_BRANCHES);
  const branches: WorkspaceBranchRef[] = await Promise.all(candidates.map(async (name) => {
    let ahead = 0;
    if (base) {
      try { ahead = Number(await gitOutput(repositoryPath, ['rev-list', '--count', `${base}..${name}`])) || 0; }
      catch { /* Unrelated histories still list, they just cannot report a count. */ }
    }
    return { name, current: name === current, ahead };
  }));
  return { base, branches, worktrees: parseWorktreeList(worktreeList, repositoryPath) };
}

/** A branch's own work: everything it added since it left the base, which is
 * what a reviewer means by "review this branch" — not its whole history. */
/** Where a branch review starts and ends. The diff and the commit list must
 * agree on the range, or reading the same branch two ways would show two
 * different changes. */
async function branchRange(repositoryPath: string, branchName: string): Promise<{ mergeBase: string; tip: string }> {
  const tip = await gitOutput(repositoryPath, ['rev-parse', '--verify', `refs/heads/${branchName}^{commit}`]);
  const base = await defaultBaseBranch(repositoryPath);
  if (!base) throw new Error(`Could not determine a comparison base for ${branchName}. This repository has no default branch.`);
  try { return { mergeBase: await gitOutput(repositoryPath, ['merge-base', base, tip]), tip }; }
  catch { throw new Error(`${branchName} shares no history with ${base}, so there is nothing to compare.`); }
}

export async function getWorkspaceBranchDiff(workspacePath: string, branchName: string): Promise<WorkspaceDiff> {
  const repositoryPath = resolveWorkspaceRepository(workspacePath);
  const { mergeBase, tip } = await branchRange(repositoryPath, branchName);
  const { stdout: patch } = await git(repositoryPath, ['diff', '--no-ext-diff', '--binary', '--no-color', '--no-renames', mergeBase, tip]);
  const files = parseWorkspacePatch(patch)
    .map((file) => ({ ...file, editorUrl: workspaceEditorUrl(repositoryPath, file.path) }));
  const totals = files.reduce((counts, file) => ({ additions: counts.additions + file.additions, deletions: counts.deletions + file.deletions }), { additions: 0, deletions: 0 });
  return {
    workspacePath: repositoryPath,
    branch: branchName,
    // Both ends belong in the identity: block reviews must not silently carry
    // over when the base moves underneath an open branch review.
    revision: `branch:${branchName}:${mergeBase}..${tip}`,
    files,
    changedFiles: files.length,
    ...totals,
    // Another branch is read-only from here; publishing stays bound to the
    // checkout the reviewer actually has out.
    publish: { branch: branchName, hasOrigin: false, ahead: 0, hasChanges: false, reason: 'Switch to this branch to publish it.' },
  };
}

/** A linked worktree's uncommitted state. The path is only ever one git itself
 * reported, so a stored preference cannot point the reader at an arbitrary
 * directory. */
export async function getWorkspaceWorktreeDiff(workspacePath: string, worktreePath: string): Promise<WorkspaceDiff> {
  const { worktrees } = await listWorkspaceRefs(workspacePath);
  const worktree = worktrees.find((candidate) => canonicalPath(candidate.path) === canonicalPath(worktreePath));
  if (!worktree) throw new Error(`${worktreePath} is not a worktree of this repository.`);
  return getWorkspaceDiff(worktree.path);
}

/** The commits a branch adds on top of its base, newest first.
 *
 * The working tree and a sibling worktree are uncommitted state by
 * definition, so they answer with nothing rather than with an error: there is
 * no commit series to walk, and that is a real answer. */
export async function listWorkspaceRefCommits(workspacePath: string, refId: string): Promise<ReviewCommit[]> {
  if (!refId.startsWith('branch:')) return [];
  const repositoryPath = resolveWorkspaceRepository(workspacePath);
  const { mergeBase, tip } = await branchRange(repositoryPath, refId.slice('branch:'.length));
  const { stdout } = await git(repositoryPath, [
    'log', `--max-count=${MAX_LISTED_COMMITS}`, `--format=%H${COMMIT_FIELD}%s${COMMIT_FIELD}%an${COMMIT_FIELD}%aI`, `${mergeBase}..${tip}`,
  ]);
  return parseCommitLog(stdout);
}

/** The most recent commits on the checked-out history, newest first. The repo
 * browser reads one commit against the one before it, so the list is a plain
 * walk of HEAD rather than a branch-versus-base range. */
export async function listWorkspaceCommits(workspacePath: string): Promise<ReviewCommit[]> {
  const repositoryPath = resolveWorkspaceRepository(workspacePath);
  const { stdout } = await git(repositoryPath, [
    'log', `--max-count=${MAX_LISTED_COMMITS}`, `--format=%H${COMMIT_FIELD}%s${COMMIT_FIELD}%an${COMMIT_FIELD}%aI`, 'HEAD',
  ]);
  return parseCommitLog(stdout);
}

/** Review source ids are stored in a browser preference and arrive as opaque
 * strings; one resolver keeps both routers honest about what they accept. */
export async function getWorkspaceRefDiff(workspacePath: string, refId: string): Promise<WorkspaceDiff> {
  if (refId.startsWith('branch:')) return getWorkspaceBranchDiff(workspacePath, refId.slice('branch:'.length));
  if (refId.startsWith('worktree:')) return getWorkspaceWorktreeDiff(workspacePath, refId.slice('worktree:'.length));
  throw new Error(`Unrecognised review source ${refId}.`);
}
