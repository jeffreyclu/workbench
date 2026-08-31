import type { GitHubPullRequestCommentsSummary, GitHubPullRequestDiff, GitHubPullRequestFile, ReviewCommit } from '../shared/contracts.js';
import { createOutboundFetch, type OutboundPolicyName } from './outbound-policy.js';

const pullRequestPattern = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/files)?\/?$/;
const FILES_PER_PAGE = 100;
const COMMENTS_PER_PAGE = 100;
const COMMITS_PER_PAGE = 100;
const MAX_COMMIT_PAGES = 3;
const commitShaPattern = /^[0-9a-f]{7,40}$/;

type GitHubPullRequestResponse = {
  html_url: string;
  title: string;
  number: number;
  base: { ref: string };
  head: { ref: string; sha: string };
  changed_files: number;
  additions: number;
  deletions: number;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  mergeable_state: string | null;
};

type GitHubReviewResponse = {
  state: string;
  user: { login: string } | null;
  submitted_at: string | null;
};

type GitHubReviewCommentResponse = {
  id: number;
  path: string;
  line: number | null;
  body: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
};

type GitHubFileResponse = {
  filename: string;
  previous_filename?: string;
  status: GitHubPullRequestFile['status'];
  additions: number;
  deletions: number;
  patch?: string;
};

type GitHubCommitResponse = {
  sha: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
  author: { login: string } | null;
  files?: GitHubFileResponse[];
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

// Status and comment counts are supplementary to the diff itself, so a failure here
// (rate limit, transient error) must degrade rather than blank out the whole review.
async function getJsonNonFatal<T>(fetchImpl: typeof fetch, endpoint: string, token: string | undefined): Promise<{ data: T | null; error: string | null }> {
  try {
    return { data: await getJson<T>(fetchImpl, endpoint, token), error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'GitHub could not load this data.' };
  }
}

// GitHub's authoritative review_decision is GraphQL-only; this approximates it from
// each reviewer's most recent completed review, which is close enough for display.
function deriveReviewDecision(reviews: GitHubReviewResponse[]): 'approved' | 'changes_requested' | 'review_required' | null {
  const latestByReviewer = new Map<string, GitHubReviewResponse>();
  for (const review of reviews) {
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'COMMENTED') continue;
    const key = review.user?.login ?? '';
    const existing = latestByReviewer.get(key);
    if (!existing || (review.submitted_at ?? '') >= (existing.submitted_at ?? '')) latestByReviewer.set(key, review);
  }
  const states = [...latestByReviewer.values()].map((review) => review.state);
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  if (states.length > 0) return 'review_required';
  return null;
}

function summarizeComments(data: GitHubReviewCommentResponse[] | null, error: string | null): GitHubPullRequestCommentsSummary {
  if (!data) return { available: false, partial: false, total: null, byPath: {}, comments: [], error };
  const byPath: Record<string, number> = {};
  for (const comment of data) byPath[comment.path] = (byPath[comment.path] ?? 0) + 1;
  return {
    available: true,
    partial: data.length === COMMENTS_PER_PAGE,
    total: data.length,
    byPath,
    comments: data.map((comment) => ({
      id: comment.id,
      path: comment.path,
      line: comment.line,
      body: comment.body,
      author: comment.user?.login ?? null,
      createdAt: comment.created_at,
      url: comment.html_url,
    })),
    error: null,
  };
}

export async function getGitHubPullRequestDiff(
  url: string,
  options: { token?: string; page?: number; fetchForPolicy?: (policy: OutboundPolicyName) => typeof fetch } = {},
): Promise<GitHubPullRequestDiff> {
  const target = parseGitHubPullRequestUrl(url);
  if (!target) throw new Error('Enter a GitHub pull request URL, such as github.com/owner/repo/pull/123.');
  const fetchImpl = (options.fetchForPolicy ?? createOutboundFetch)('github-api');
  const root = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/pulls/${target.number}`;
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1) throw new Error('Pull-request file page must be a positive integer.');
  const [pullRequest, filePage, reviews, commentPage] = await Promise.all([
    getJson<GitHubPullRequestResponse>(fetchImpl, root, options.token),
    getJson<GitHubFileResponse[]>(fetchImpl, `${root}/files?per_page=${FILES_PER_PAGE}&page=${page}`, options.token),
    getJsonNonFatal<GitHubReviewResponse[]>(fetchImpl, `${root}/reviews?per_page=100`, options.token),
    getJsonNonFatal<GitHubReviewCommentResponse[]>(fetchImpl, `${root}/comments?per_page=${COMMENTS_PER_PAGE}`, options.token),
  ]);
  const files = toReviewFiles(filePage);
  return {
    url: pullRequest.html_url,
    repository: `${target.owner}/${target.repository}`,
    number: pullRequest.number,
    title: pullRequest.title,
    baseRef: pullRequest.base.ref,
    headRef: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    revision: pullRequest.head.sha,
    files,
    changedFiles: pullRequest.changed_files,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    nextPage: filePage.length === FILES_PER_PAGE && page * FILES_PER_PAGE < pullRequest.changed_files ? page + 1 : null,
    state: pullRequest.merged ? 'merged' : pullRequest.state,
    draft: pullRequest.draft,
    mergeableState: pullRequest.mergeable_state ?? 'unknown',
    reviewDecision: reviews.data ? deriveReviewDecision(reviews.data) : null,
    reviewDecisionError: reviews.error,
    comments: summarizeComments(commentPage.data, commentPage.error),
  };
}

function toReviewCommit(commit: GitHubCommitResponse): ReviewCommit {
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    // A commit message is a subject line and then a body; the selector reads
    // the subject, which is what the author wrote the commit to say.
    title: commit.commit.message.split('\n')[0],
    author: commit.author?.login ?? commit.commit.author?.name ?? null,
    committedAt: commit.commit.author?.date ?? null,
  };
}

function toReviewFiles(files: GitHubFileResponse[]): GitHubPullRequestFile[] {
  return files.map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    previousPath: file.previous_filename ?? null,
    patch: file.patch ?? null,
    isBinary: !file.patch,
  }));
}

/** The commits a pull request is made of, newest first.
 *
 * GitHub returns them oldest-first and caps this endpoint at 250 commits; both
 * are the API's shape rather than a choice, so the order is reversed here and
 * a longer pull request is reviewed whole instead. */
export async function getGitHubPullRequestCommits(
  url: string,
  options: { token?: string; fetchForPolicy?: (policy: OutboundPolicyName) => typeof fetch } = {},
): Promise<ReviewCommit[]> {
  const target = parseGitHubPullRequestUrl(url);
  if (!target) throw new Error('Enter a GitHub pull request URL, such as github.com/owner/repo/pull/123.');
  const fetchImpl = (options.fetchForPolicy ?? createOutboundFetch)('github-api');
  const root = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/pulls/${target.number}`;
  // Paged to GitHub's own 250-commit ceiling rather than to the first page:
  // taking one page would quietly drop the newest commits, which are the ones
  // a reviewer opens the list to find.
  const commits: GitHubCommitResponse[] = [];
  for (let page = 1; page <= MAX_COMMIT_PAGES; page += 1) {
    const batch = await getJson<GitHubCommitResponse[]>(fetchImpl, `${root}/commits?per_page=${COMMITS_PER_PAGE}&page=${page}`, options.token);
    commits.push(...batch);
    if (batch.length < COMMITS_PER_PAGE) break;
  }
  return commits.map(toReviewCommit).reverse();
}

/** One commit of a pull request, as its own diff.
 *
 * The commit is read from the pull request's repository, so a sha from
 * somewhere else cannot be smuggled in through the same link. */
export async function getGitHubCommitDiff(
  url: string,
  sha: string,
  options: { token?: string; fetchForPolicy?: (policy: OutboundPolicyName) => typeof fetch } = {},
): Promise<{ commit: ReviewCommit; files: GitHubPullRequestFile[] }> {
  const target = parseGitHubPullRequestUrl(url);
  if (!target) throw new Error('Enter a GitHub pull request URL, such as github.com/owner/repo/pull/123.');
  if (!commitShaPattern.test(sha)) throw new Error('That is not a commit identifier.');
  const fetchImpl = (options.fetchForPolicy ?? createOutboundFetch)('github-api');
  const commit = await getJson<GitHubCommitResponse>(
    fetchImpl,
    `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/commits/${sha}`,
    options.token,
  );
  return { commit: toReviewCommit(commit), files: toReviewFiles(commit.files ?? []) };
}

const imageContentTypes: Record<string, string> = {
  avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

export function imageContentType(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return imageContentTypes[extension] ?? null;
}

export async function getGitHubPullRequestImage(
  url: string,
  path: string,
  options: { token?: string; fetchForPolicy?: (policy: OutboundPolicyName) => typeof fetch } = {},
): Promise<{ body: Buffer; contentType: string }> {
  const target = parseGitHubPullRequestUrl(url);
  if (!target) throw new Error('Enter a GitHub pull request URL, such as github.com/owner/repo/pull/123.');
  const contentType = imageContentType(path);
  if (!contentType) throw new Error('Only image files can be previewed.');
  const fetchImpl = (options.fetchForPolicy ?? createOutboundFetch)('github-api');
  const root = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/pulls/${target.number}`;
  const pullRequest = await getJson<GitHubPullRequestResponse>(fetchImpl, root, options.token);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repository)}/contents/${encodedPath}?ref=${encodeURIComponent(pullRequest.head.sha)}`, {
    headers: { ...githubHeaders(options.token), Accept: 'application/vnd.github.raw+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error('GitHub image file not found.');
    if (response.status === 401 || response.status === 403) throw new Error('GitHub could not read this image. Reconnect GitHub in Sources.');
    throw new Error(`GitHub could not load this image (${response.status}).`);
  }
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}
