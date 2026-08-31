import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { useWorkspaceDiff, useWorkspaceDiffSnapshots, useWorkspaceRefDiff, useWorkspaceRefs } from '../workspace-diff/hooks.js';
import { useGitHubPullRequestDiff } from '../github-diff/hooks.js';
import { pullRequestLabel, pullRequestUrls } from '../github-diff/logic.js';
import { readReviewStackSelection, writeReviewStackSource } from '../../lib/preferences.js';
import {
  defaultReviewSourceId, resolveReviewSourceDiff, reviewSourceKind, reviewSourceOptions,
  type ReviewSourceDiff, type ReviewSourceOption,
} from './source.js';

/** The review stack's own source resolution.
 *
 * It reads the same read-only data hooks the Changes view reads — those are
 * data access, not Changes' state — but it owns the selection, the default and
 * the remembered preference. Nothing here can move what Changes is showing. */
export function useReviewSource(scope: WorkspaceDiffScope, pullRequestUrlCandidates?: string[]) {
  const preferenceScope = 'conversationId' in scope ? `conversation:${scope.conversationId}`
    : 'reviewId' in scope ? `review:${scope.reviewId}`
    : `work-item:${scope.workItemId}`;
  const remembered = useMemo(() => readReviewStackSelection(preferenceScope), [preferenceScope]);

  const diffQuery = useWorkspaceDiff(scope);
  const diff = diffQuery.data?.diff;
  const snapshotsQuery = useWorkspaceDiffSnapshots(scope, diff?.revision);
  const snapshots = useMemo(() => snapshotsQuery.data?.snapshots ?? [], [snapshotsQuery.data]);

  const pullRequests = useMemo(
    () => pullRequestUrls(pullRequestUrlCandidates ?? []).map((url) => ({ url, label: pullRequestLabel(url) })),
    [pullRequestUrlCandidates],
  );
  const refsQuery = useWorkspaceRefs(scope);
  const refs = refsQuery.data?.refs ?? null;
  const options = useMemo(() => reviewSourceOptions({ diff, snapshots, pullRequests, refs }), [diff, snapshots, pullRequests, refs]);

  const [sourceId, setSourceId] = useState<string | null>(null);
  useEffect(() => {
    // Decided once, after the first real answer arrives: a later edit to the
    // working tree must never yank the reviewer out of what they are reading.
    if (sourceId !== null || diffQuery.isLoading || snapshotsQuery.isLoading) return;
    const preferred = remembered?.source;
    setSourceId(preferred && options.some((option) => option.id === preferred) ? preferred : defaultReviewSourceId(options, { diff, snapshots }));
  }, [sourceId, diffQuery.isLoading, snapshotsQuery.isLoading, remembered?.source, options, diff, snapshots]);

  const selectedKind = sourceId ? reviewSourceKind(sourceId) : null;
  const refId = selectedKind === 'branch' || selectedKind === 'worktree' ? sourceId : null;
  const refDiffQuery = useWorkspaceRefDiff(scope, refId);
  const refDiff: ReviewSourceDiff | null = useMemo(() => {
    const answer = refDiffQuery.data?.diff;
    return answer ? { branch: answer.branch, revision: answer.revision, files: answer.files } : null;
  }, [refDiffQuery.data]);

  const pullRequestUrl = sourceId && selectedKind === 'pull-request' ? sourceId : null;
  const pullRequestQuery = useGitHubPullRequestDiff(pullRequestUrl);
  const pullRequestDiff: ReviewSourceDiff | null = useMemo(() => {
    const first = pullRequestQuery.data?.pages[0]?.diff;
    if (!first) return null;
    return { branch: `${first.baseRef} → ${first.headRef}`, revision: first.revision, files: pullRequestQuery.data!.pages.flatMap((page) => page.diff.files) };
  }, [pullRequestQuery.data]);

  const selectSource = (nextId: string) => {
    setSourceId(nextId);
    writeReviewStackSource(preferenceScope, nextId);
  };

  const source = sourceId ? resolveReviewSourceDiff(sourceId, { diff, snapshots, pullRequest: pullRequestDiff, refDiff }) : null;
  return {
    preferenceScope,
    options,
    sourceId,
    selectSource,
    source,
    isLoading: diffQuery.isLoading || snapshotsQuery.isLoading || (pullRequestUrl !== null && pullRequestQuery.isLoading) || (refId !== null && refDiffQuery.isLoading),
    error: diffQuery.error ?? pullRequestQuery.error ?? refDiffQuery.error ?? null,
    refresh: () => { void diffQuery.refetch(); void snapshotsQuery.refetch(); void refsQuery.refetch(); if (refId) void refDiffQuery.refetch(); },
  };
}

export type ReviewSourceState = ReturnType<typeof useReviewSource>;
export type { ReviewSourceOption };
