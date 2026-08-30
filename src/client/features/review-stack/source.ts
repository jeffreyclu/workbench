import type { WorkspaceDiff, WorkspaceDiffFile, WorkspaceDiffSnapshot } from '../../../shared/contracts.js';

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

export type ReviewSourceKind = 'workspace' | 'history' | 'pull-request';

export interface ReviewSourceOption {
  /** Also the persisted preference value: `workspace`, `history:<id>`, or the
   * pull request URL. */
  id: string;
  kind: ReviewSourceKind;
  label: string;
}

export const WORKSPACE_SOURCE_ID = 'workspace';

export function historySourceId(snapshotId: string): string {
  return `history:${snapshotId}`;
}

export function reviewSourceKind(id: string): ReviewSourceKind {
  if (id === WORKSPACE_SOURCE_ID) return 'workspace';
  return id.startsWith('history:') ? 'history' : 'pull-request';
}

export function reviewSourceOptions(input: {
  diff: WorkspaceDiff | null | undefined;
  snapshots: WorkspaceDiffSnapshot[];
  pullRequests: Array<{ url: string; label: string }>;
}): ReviewSourceOption[] {
  const options: ReviewSourceOption[] = [{
    id: WORKSPACE_SOURCE_ID,
    kind: 'workspace',
    label: input.diff?.branch ? `Working tree — ${input.diff.branch}` : 'Working tree',
  }];
  for (const snapshot of input.snapshots) {
    options.push({ id: historySourceId(snapshot.id), kind: 'history', label: `Recorded ${snapshot.capturedAt.slice(0, 16).replace('T', ' ')}` });
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
}): ReviewSourceDiff | null {
  const kind = reviewSourceKind(sourceId);
  if (kind === 'pull-request') return input.pullRequest;
  if (kind === 'history') {
    const snapshot = input.snapshots.find((candidate) => historySourceId(candidate.id) === sourceId);
    return snapshot ? { branch: snapshot.diff.branch, revision: snapshot.diff.revision, files: snapshot.diff.files } : null;
  }
  return input.diff ? { branch: input.diff.branch, revision: input.diff.revision, files: input.diff.files } : null;
}
