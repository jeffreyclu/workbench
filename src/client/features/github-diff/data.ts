import { api } from '../../api.js';

export const githubDiffQueryKeys = {
  pullRequest: (url: string) => ['github-pull-request-diff', url] as const,
};

export const githubDiffData = {
  getPullRequest: (url: string) => api.getGitHubPullRequestDiff(url),
};
