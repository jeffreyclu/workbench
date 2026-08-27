import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkItemReference } from '../../../shared/contracts.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { pullRequestUrls } from '../github-diff/logic.js';
import { useGitHubPullRequestDiffPreviews } from '../github-diff/hooks.js';
import { useWorkspaceDiff, useWorkspaceDiffSnapshots } from '../workspace-diff/hooks.js';
import { workspaceDiffQueryKeys } from '../workspace-diff/data.js';

export function useDebouncedValue(value: string, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debouncedValue;
}

export function useConversationChangesAvailability(scope: WorkspaceDiffScope | null, sourceUrl: string | null, references: WorkItemReference[], isRunning: boolean) {
  const queryClient = useQueryClient();
  const workspaceDiff = useWorkspaceDiff(scope);
  // A commit clears Git's current diff, but Workbench preserves it as a
  // snapshot. Keep the tab available for those reviewable recorded changes.
  const snapshots = useWorkspaceDiffSnapshots(scope, workspaceDiff.data?.diff?.revision);
  const wasRunning = useRef(isRunning);
  useEffect(() => {
    // The diff query is deliberately stale-forever (see useWorkspaceDiff) so a
    // patch someone is reading never shifts under them. But that means the
    // "Changes" tab's enabled/disabled state can go stale too: once an agent
    // finishes a turn, this is the one moment we know new changes may exist,
    // so force a refetch to keep the tab honest.
    if (wasRunning.current && !isRunning && scope) void queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.detail(scope) });
    wasRunning.current = isRunning;
  }, [isRunning, scope, queryClient]);
  const linkedPullRequestUrls = pullRequestUrls([...(sourceUrl ? [sourceUrl] : []), ...references.map((reference) => reference.url)]);
  const pullRequestDiffs = useGitHubPullRequestDiffPreviews(linkedPullRequestUrls);
  const hasWorkspaceChanges = (workspaceDiff.data?.diff?.changedFiles ?? 0) > 0;
  const hasRecordedWorkspaceChanges = (snapshots.data?.snapshots ?? []).some((snapshot) => snapshot.diff.changedFiles > 0);
  const hasPullRequestChanges = pullRequestDiffs.some((pullRequestDiff) => (pullRequestDiff.data?.diff.changedFiles ?? 0) > 0);
  const isError = workspaceDiff.isError || snapshots.isError || pullRequestDiffs.some((pullRequestDiff) => pullRequestDiff.isError);
  const retry = useCallback(async () => {
    await Promise.all([
      workspaceDiff.refetch(),
      snapshots.refetch(),
      ...pullRequestDiffs.map((pullRequestDiff) => pullRequestDiff.refetch()),
    ]);
  }, [pullRequestDiffs, snapshots.refetch, workspaceDiff.refetch]);

  return {
    hasChanges: hasWorkspaceChanges || hasRecordedWorkspaceChanges || hasPullRequestChanges,
    isLoading: workspaceDiff.isLoading || snapshots.isLoading || pullRequestDiffs.some((pullRequestDiff) => pullRequestDiff.isLoading),
    isError,
    retry,
  };
}
