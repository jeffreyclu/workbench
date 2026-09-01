import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
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

/** A pull request's commits, and one of them read as its own diff. */
export function useGitHubPullRequestCommits(url: string | null) {
  return useQuery({
    queryKey: githubDiffQueryKeys.commits(url ?? ''),
    queryFn: () => githubDiffData.getCommits(url!),
    enabled: url !== null,
    staleTime: 30_000,
  });
}

export function useGitHubPullRequestCommitDiff(url: string | null, sha: string | null) {
  return useQuery({
    queryKey: githubDiffQueryKeys.commitDiff(url ?? '', sha ?? ''),
    queryFn: () => githubDiffData.getCommitDiff(url!, sha!),
    enabled: url !== null && sha !== null,
    // A pushed commit does not change under the reviewer.
    staleTime: Infinity,
  });
}

/** A pull request file is immutable for the head SHA the server resolves, so
 * reselecting a decision in the same file can reuse the downloaded content. */
export function useGitHubPullRequestFile(url: string | null, path: string | null, revision: string | null, enabled: boolean) {
  return useQuery({
    queryKey: githubDiffQueryKeys.file(url ?? '', path ?? '', revision ?? ''),
    queryFn: () => githubDiffData.getFile(url!, path!, revision!),
    enabled: Boolean(url) && Boolean(path) && Boolean(revision) && enabled,
    staleTime: Infinity,
  });
}

export function useGitHubPullRequestDiffPreviews(urls: string[]) {
  return useQueries({
    queries: urls.map((url) => ({
      // A one-page availability probe cannot share a key with the paginated
      // viewer: React Query stores different data shapes for each, and mixing
      // them makes the infinite observer read a non-existent `pages` array.
      queryKey: githubDiffQueryKeys.preview(url),
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
