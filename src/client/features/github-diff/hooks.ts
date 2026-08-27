import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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

export function useGitHubPullRequestDiffPreviews(urls: string[]) {
  return useQueries({
    queries: urls.map((url) => ({
      queryKey: githubDiffQueryKeys.pullRequest(url),
      queryFn: () => githubDiffData.getPullRequest(url, 1),
      staleTime: 30_000,
    })),
  });
}

export function useSelectedGitHubPullRequest(urls: string[]) {
  const [selectedUrl, setSelectedUrl] = useState<string | null>(() => urls[0] ?? null);
  useEffect(() => {
    setSelectedUrl((current) => current && urls.includes(current) ? current : urls[0] ?? null);
  }, [urls]);
  return [selectedUrl, setSelectedUrl] as const;
}
