import { api } from '../../data/api.js';

export const githubDiffQueryKeys = {
  pullRequest: (url: string) => ['github-pull-request-diff', url] as const,
  preview: (url: string) => ['github-pull-request-diff-preview', url] as const,
  commits: (url: string) => ['github-pull-request-commits', url] as const,
  commitDiff: (url: string, sha: string) => ['github-pull-request-commit-diff', url, sha] as const,
};

export const githubDiffData = {
  getPullRequest: (url: string, page: number) => api.getGitHubPullRequestDiff(url, page),
  getCommits: (url: string) => api.getGitHubPullRequestCommits(url),
  getCommitDiff: (url: string, sha: string) => api.getGitHubPullRequestCommitDiff(url, sha),
  imageUrl: (url: string, path: string) => `/api/github/pull-request-image?url=${encodeURIComponent(url)}&path=${encodeURIComponent(path)}`,
};
