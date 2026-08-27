import { api } from '../../data/api.js';

export const githubDiffQueryKeys = {
  pullRequest: (url: string) => ['github-pull-request-diff', url] as const,
};

export const githubDiffData = {
  getPullRequest: (url: string, page: number) => api.getGitHubPullRequestDiff(url, page),
  imageUrl: (url: string, path: string) => `/api/github/pull-request-image?url=${encodeURIComponent(url)}&path=${encodeURIComponent(path)}`,
};
