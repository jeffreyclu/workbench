import type { GitHubPullRequestDiff, GitHubPullRequestFile } from '../shared/contracts.js';
import { createOutboundFetch, type OutboundPolicyName } from './outbound-policy.js';

const pullRequestPattern = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/files)?\/?$/;
const MAX_FILES = 300;

type GitHubPullRequestResponse = {
  html_url: string;
  title: string;
  number: number;
  base: { ref: string };
  head: { ref: string };
  changed_files: number;
  additions: number;
  deletions: number;
};

type GitHubFileResponse = {
  filename: string;
  previous_filename?: string;
  status: GitHubPullRequestFile['status'];
  additions: number;
  deletions: number;
  patch?: string;
};

export interface GitHubPullRequestTarget {
  owner: string;
  repository: string;
  number: number;
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestTarget | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.hostname !== 'github.com') return null;
  const match = url.pathname.match(pullRequestPattern);
  if (!match) return null;
  return { owner: match[1], repository: match[2], number: Number(match[3]) };
}

function githubHeaders(token: string | undefined) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'workbench-local',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function getJson<T>(fetchImpl: typeof fetch, endpoint: string, token: string | undefined): Promise<T> {
  const response = await fetchImpl(endpoint, { headers: githubHeaders(token), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('GitHub could not read this pull request. Reconnect GitHub in Sources.');
    if (response.status === 404) throw new Error('GitHub pull request not found or not available to the connected account.');
    throw new Error(`GitHub could not load this pull request (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export async function getGitHubPullRequestDiff(
  url: string,
  options: { token?: string; fetchForPolicy?: (policy: OutboundPolicyName) => typeof fetch } = {},
): Promise<GitHubPullRequestDiff> {
  const target = parseGitHubPullRequestUrl(url);
  if (!target) throw new Error('Enter a GitHub pull request URL, such as github.com/owner/repo/pull/123.');
  const fetchImpl = (options.fetchForPolicy ?? createOutboundFetch)('github-api');
  const root = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/pulls/${target.number}`;
  const [pullRequest, filePages] = await Promise.all([
    getJson<GitHubPullRequestResponse>(fetchImpl, root, options.token),
    Promise.all(Array.from({ length: 3 }, (_, index) => getJson<GitHubFileResponse[]>(fetchImpl, `${root}/files?per_page=100&page=${index + 1}`, options.token))),
  ]);
  const files = filePages.flat().slice(0, MAX_FILES).map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    previousPath: file.previous_filename ?? null,
    patch: file.patch ?? null,
    isBinary: !file.patch,
  }));
  return {
    url: pullRequest.html_url,
    repository: `${target.owner}/${target.repository}`,
    number: pullRequest.number,
    title: pullRequest.title,
    baseRef: pullRequest.base.ref,
    headRef: pullRequest.head.ref,
    files,
    changedFiles: pullRequest.changed_files,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
  };
}
