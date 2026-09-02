import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { workspaceDiffScopeKey } from '../workspace-diff/data.js';
import { pullRequestUrls } from '../github-diff/logic.js';
import { useGitHubPullRequestDiffPreviews } from '../github-diff/hooks.js';
import { useWorkspaceDiff, useWorkspaceDiffSnapshots, useWorkspaceExplorer } from '../workspace-diff/hooks.js';
import { workspaceDiffQueryKeys } from '../workspace-diff/data.js';

export function useDebouncedValue(value: string, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debouncedValue;
}

export function useConversationChangesAvailability(scope: WorkspaceDiffScope | null, candidateUrls: string[], isRunning: boolean) {
  const queryClient = useQueryClient();
  const explorer = useWorkspaceExplorer(scope, isRunning);
  const workspacePath = explorer.data?.selectedPath ?? null;
  const workspaceDiff = useWorkspaceDiff(scope, workspacePath);
  // A commit clears Git's current diff, but Workbench preserves it as a
  // snapshot. Keep the tab available for those reviewable recorded changes.
  const snapshots = useWorkspaceDiffSnapshots(scope, workspacePath, workspaceDiff.data?.diff?.revision);
  const wasRunning = useRef(isRunning);
  const previousScopeKey = useRef(scope ? workspaceDiffScopeKey(scope) : null);
  const scopeKey = scope ? workspaceDiffScopeKey(scope) : null;
  useEffect(() => {
    // A completed run can have produced its diff in a detached Workbench
    // worktree. Refresh once per scope transition without reopening a stale
    // conversation's Changes panel.
    if (previousScopeKey.current !== scopeKey) {
      previousScopeKey.current = scopeKey;
      wasRunning.current = isRunning;
      return;
    }
    if (wasRunning.current && !isRunning && scope) {
      void queryClient.invalidateQueries({ queryKey: workspaceDiffQueryKeys.detailPrefix(scope) });
    }
    wasRunning.current = isRunning;
  }, [isRunning, scope, scopeKey, queryClient]);
  const linkedPullRequestUrls = pullRequestUrls(candidateUrls);
  const pullRequestDiffs = useGitHubPullRequestDiffPreviews(linkedPullRequestUrls);
  const hasWorkspaceChanges = (workspaceDiff.data?.diff?.changedFiles ?? 0) > 0;
  const hasRecordedWorkspaceChanges = (snapshots.data?.snapshots ?? []).some((snapshot) => snapshot.diff.changedFiles > 0);
  const hasPullRequestChanges = pullRequestDiffs.some((pullRequestDiff) => (pullRequestDiff.data?.diff.changedFiles ?? 0) > 0);
  const isError = explorer.isError || workspaceDiff.isError || snapshots.isError || pullRequestDiffs.some((pullRequestDiff) => pullRequestDiff.isError);
  const refetchExplorer = explorer.refetch;
  const refetchWorkspaceDiff = workspaceDiff.refetch;
  const refetchSnapshots = snapshots.refetch;
  const retry = useCallback(async () => {
    await Promise.all([
      refetchWorkspaceDiff(),
      refetchSnapshots(),
      refetchExplorer(),
      ...pullRequestDiffs.map((pullRequestDiff) => pullRequestDiff.refetch()),
    ]);
  }, [pullRequestDiffs, refetchExplorer, refetchSnapshots, refetchWorkspaceDiff]);

  return {
    hasChanges: hasWorkspaceChanges || hasRecordedWorkspaceChanges || hasPullRequestChanges,
    // A scoped request that is still waiting for Repo Explorer's selection is
    // pending, not loading. Reporting it as settled would hide Changes for the
    // moment before the repository is known.
    isLoading: (Boolean(scope) && (explorer.isPending || workspaceDiff.isPending || snapshots.isPending)) || pullRequestDiffs.some((pullRequestDiff) => pullRequestDiff.isLoading),
    isError,
    retry,
  };
}
