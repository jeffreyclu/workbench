import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { useWorkspaceCommitDiff, useWorkspaceDiff, useWorkspaceDiffSnapshots, useWorkspaceRefCommits, useWorkspaceRefDiff, useWorkspaceRefs } from '../workspace-diff/hooks.js';
import { useGitHubPullRequestCommitDiff, useGitHubPullRequestCommits, useGitHubPullRequestDiff } from '../github-diff/hooks.js';
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

  // The commits behind the selected source. A pull request and a branch are
  // the same question asked of two hosts, so both answer with `ReviewCommit`
  // and the reader below cannot tell them apart.
  const pullRequestCommitsQuery = useGitHubPullRequestCommits(pullRequestUrl);
  const refCommitsQuery = useWorkspaceRefCommits(scope, selectedKind === 'branch' ? refId : null);
  const commits = useMemo(
    () => (pullRequestUrl ? pullRequestCommitsQuery.data?.commits : refCommitsQuery.data?.commits) ?? [],
    [pullRequestUrl, pullRequestCommitsQuery.data, refCommitsQuery.data],
  );

  // A commit id only means anything inside the source it was listed from, so
  // changing source drops back to reading that source whole.
  const [commitSha, setCommitSha] = useState<string | null>(null);
  useEffect(() => { setCommitSha(null); }, [sourceId]);
  const selectedCommit = commitSha && commits.some((commit) => commit.sha === commitSha) ? commitSha : null;

  const pullRequestCommitQuery = useGitHubPullRequestCommitDiff(pullRequestUrl, pullRequestUrl ? selectedCommit : null);
  const workspaceCommitQuery = useWorkspaceCommitDiff(scope, pullRequestUrl ? null : selectedCommit);
  const commitDiff: ReviewSourceDiff | null = useMemo(() => {
    const fromPullRequest = pullRequestCommitQuery.data;
    if (fromPullRequest) return { branch: `${fromPullRequest.commit.shortSha} — ${fromPullRequest.commit.title}`, revision: fromPullRequest.commit.sha, files: fromPullRequest.files };
    const fromWorkspace = workspaceCommitQuery.data?.diff;
    if (!fromWorkspace) return null;
    const listed = commits.find((commit) => fromWorkspace.revision.endsWith(commit.sha));
    return { branch: listed ? `${listed.shortSha} — ${listed.title}` : fromWorkspace.branch, revision: fromWorkspace.revision, files: fromWorkspace.files };
  }, [pullRequestCommitQuery.data, workspaceCommitQuery.data, commits]);

  const selectSource = (nextId: string) => {
    setSourceId(nextId);
    writeReviewStackSource(preferenceScope, nextId);
  };

  const wholeSource = sourceId ? resolveReviewSourceDiff(sourceId, { diff, snapshots, pullRequest: pullRequestDiff, refDiff }) : null;
  const commitLoading = selectedCommit !== null && (pullRequestCommitQuery.isLoading || workspaceCommitQuery.isLoading);
  return {
    preferenceScope,
    options,
    sourceId,
    selectSource,
    commits,
    commitSha: selectedCommit,
    selectCommit: setCommitSha,
    // A selected commit replaces what is being read, rather than filtering it:
    // the commit's own patch is what its author wrote, hunk for hunk.
    source: selectedCommit ? commitDiff : wholeSource,
    isLoading: diffQuery.isLoading || snapshotsQuery.isLoading || (pullRequestUrl !== null && pullRequestQuery.isLoading) || (refId !== null && refDiffQuery.isLoading) || commitLoading,
    error: diffQuery.error ?? pullRequestQuery.error ?? refDiffQuery.error ?? pullRequestCommitQuery.error ?? workspaceCommitQuery.error ?? null,
    refresh: () => {
      void diffQuery.refetch(); void snapshotsQuery.refetch(); void refsQuery.refetch();
      if (refId) void refDiffQuery.refetch();
      if (pullRequestUrl) void pullRequestCommitsQuery.refetch(); else if (selectedKind === 'branch') void refCommitsQuery.refetch();
    },
  };
}

export type ReviewSourceState = ReturnType<typeof useReviewSource>;
export type { ReviewSourceOption };
