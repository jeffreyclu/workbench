import type { WorkspaceDiff, WorkspaceDiffFile, WorkspaceDiffSnapshot, WorkspaceRefs } from '../../../shared/contracts.js';

/** The parts of a diff the review stack reads, whichever produced it.
 *
 * Review normalises its own source rather than reusing the Changes view, so
 * that switching source here — or opening Review at all — cannot move what
 * Changes is showing. */
export interface ReviewSourceDiff {
  branch: string;
  revision: string;
  files: WorkspaceDiffFile[];
}

export type ReviewSourceKind = 'workspace' | 'history' | 'branch' | 'worktree' | 'pull-request';

export interface ReviewSourceOption {
  /** Also the persisted preference value: `workspace`, `history:<id>`,
   * `branch:<name>`, `worktree:<path>`, or the pull request URL. */
  id: string;
  kind: ReviewSourceKind;
  label: string;
}

export const WORKSPACE_SOURCE_ID = 'workspace';

export function historySourceId(snapshotId: string): string {
  return `history:${snapshotId}`;
}

export function branchSourceId(branchName: string): string {
  return `branch:${branchName}`;
}

export function worktreeSourceId(worktreePath: string): string {
  return `worktree:${worktreePath}`;
}

/** Every id but a pull request's carries its own prefix, so the URL stays the
 * fallback rather than something this has to recognise. */
export function reviewSourceKind(id: string): ReviewSourceKind {
  if (id === WORKSPACE_SOURCE_ID) return 'workspace';
  if (id.startsWith('history:')) return 'history';
  if (id.startsWith('branch:')) return 'branch';
  if (id.startsWith('worktree:')) return 'worktree';
  return 'pull-request';
}

/** A worktree is named by its directory; the full path is the id and would
 * crowd out everything else in the selector. */
function worktreeLabel(worktree: { path: string; branch: string | null }): string {
  const name = worktree.path.split('/').filter(Boolean).pop() ?? worktree.path;
  return worktree.branch && worktree.branch !== name ? `Worktree ${name} — ${worktree.branch}` : `Worktree ${name}`;
}

export function reviewSourceOptions(input: {
  diff: WorkspaceDiff | null | undefined;
  snapshots: WorkspaceDiffSnapshot[];
  pullRequests: Array<{ url: string; label: string }>;
  refs?: WorkspaceRefs | null;
}): ReviewSourceOption[] {
  const options: ReviewSourceOption[] = [{
    id: WORKSPACE_SOURCE_ID,
    kind: 'workspace',
    label: input.diff?.branch ? `Working tree — ${input.diff.branch}` : 'Working tree',
  }];
  for (const snapshot of input.snapshots) {
    options.push({ id: historySourceId(snapshot.id), kind: 'history', label: `Recorded ${snapshot.capturedAt.slice(0, 16).replace('T', ' ')}` });
  }
  // Sibling checkouts sit next to the working tree because they are the same
  // kind of thing: uncommitted work someone is in the middle of.
  for (const worktree of input.refs?.worktrees ?? []) {
    if (worktree.current) continue;
    options.push({ id: worktreeSourceId(worktree.path), kind: 'worktree', label: worktreeLabel(worktree) });
  }
  for (const branch of input.refs?.branches ?? []) {
    const suffix = branch.ahead > 0 ? ` — ${branch.ahead} commit${branch.ahead === 1 ? '' : 's'}` : '';
    options.push({ id: branchSourceId(branch.name), kind: 'branch', label: `Branch ${branch.name}${suffix}` });
  }
  for (const pullRequest of input.pullRequests) {
    options.push({ id: pullRequest.url, kind: 'pull-request', label: pullRequest.label });
  }
  return options;
}

/** Which source to open on, decided once. A working tree with something in it
 * wins, then the newest record, then a linked pull request — the order in
 * which a reviewer is most likely to already know what they are looking at. */
export function defaultReviewSourceId(options: ReviewSourceOption[], input: {
  diff: WorkspaceDiff | null | undefined;
  snapshots: WorkspaceDiffSnapshot[];
}): string {
  if ((input.diff?.changedFiles ?? 0) > 0) return WORKSPACE_SOURCE_ID;
  const recorded = input.snapshots.find((snapshot) => snapshot.diff.changedFiles > 0);
  if (recorded) return historySourceId(recorded.id);
  return options.find((option) => option.kind === 'pull-request')?.id ?? WORKSPACE_SOURCE_ID;
}

export function resolveReviewSourceDiff(sourceId: string, input: {
  diff: WorkspaceDiff | null | undefined;
  snapshots: WorkspaceDiffSnapshot[];
  pullRequest: ReviewSourceDiff | null;
  refDiff?: ReviewSourceDiff | null;
}): ReviewSourceDiff | null {
  const kind = reviewSourceKind(sourceId);
  if (kind === 'pull-request') return input.pullRequest;
  // One fetched ref at a time: whichever branch or worktree is selected is the
  // only one whose patch was ever asked for.
  if (kind === 'branch' || kind === 'worktree') return input.refDiff ?? null;
  if (kind === 'history') {
    const snapshot = input.snapshots.find((candidate) => historySourceId(candidate.id) === sourceId);
    return snapshot ? { branch: snapshot.diff.branch, revision: snapshot.diff.revision, files: snapshot.diff.files } : null;
  }
  return input.diff ? { branch: input.diff.branch, revision: input.diff.revision, files: input.diff.files } : null;
}
