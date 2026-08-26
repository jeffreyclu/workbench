import { useQuery } from '@tanstack/react-query';
import { githubDiffData, githubDiffQueryKeys } from './data.js';

export function useGitHubPullRequestDiff(url: string | null) {
  return useQuery({
    queryKey: githubDiffQueryKeys.pullRequest(url ?? ''),
    queryFn: () => githubDiffData.getPullRequest(url!),
    enabled: url !== null,
    staleTime: 30_000,
  });
}
