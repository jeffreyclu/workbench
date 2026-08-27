import { useInfiniteQuery } from '@tanstack/react-query';
import { githubDiffData, githubDiffQueryKeys } from './data.js';

export function useGitHubPullRequestDiff(url: string | null) {
  return useInfiniteQuery({
    queryKey: githubDiffQueryKeys.pullRequest(url ?? ''),
    queryFn: ({ pageParam }) => githubDiffData.getPullRequest(url!, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.diff.nextPage,
    enabled: url !== null,
    staleTime: 30_000,
  });
}
