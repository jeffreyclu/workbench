import { useEffect, useState } from 'react';
import type { WorkItemReference } from '../../../shared/contracts.js';
import type { WorkspaceDiffScope } from '../../data/source-client.js';
import { pullRequestUrl } from '../github-diff/logic.js';
import { useGitHubPullRequestDiff } from '../github-diff/hooks.js';
import { useWorkspaceDiff } from '../workspace-diff/hooks.js';

export function useDebouncedValue(value: string, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debouncedValue;
}

export function useConversationChangesAvailability(scope: WorkspaceDiffScope | null, sourceUrl: string | null, references: WorkItemReference[]) {
  const workspaceDiff = useWorkspaceDiff(scope);
  const pullRequestUrlValue = pullRequestUrl([...(sourceUrl ? [sourceUrl] : []), ...references.map((reference) => reference.url)]);
  const pullRequestDiff = useGitHubPullRequestDiff(pullRequestUrlValue);
  const hasWorkspaceChanges = (workspaceDiff.data?.diff?.changedFiles ?? 0) > 0;
  const hasPullRequestChanges = (pullRequestDiff.data?.diff?.changedFiles ?? 0) > 0;

  return {
    hasChanges: hasWorkspaceChanges || hasPullRequestChanges,
    isLoading: workspaceDiff.isLoading || pullRequestDiff.isLoading,
  };
}
