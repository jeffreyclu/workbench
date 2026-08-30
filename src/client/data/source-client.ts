import type { StaleReferenceReport } from '../../shared/stale-reference-contract.js';
import type { BrokerConnection, BrokerSearchResponse, BrokerSourceId, ResolvedSourceDraft } from '../../shared/contracts';
import type { ReviewAssistTier } from '../../shared/contracts';
import type { DiffBlockReview, DiffHunkReview, DiffHunkReviewState, GitHubPullRequestDiff, UpsertDiffBlockReviewInput, UpsertDiffHunkReviewsInput, WorkspaceDiff, WorkspaceDiffSnapshot } from '../../shared/contracts';
import { request } from './request';

// A conversation with no linked task still has a real workspace (see
// resolveSharedReplyWorkingDirectory server-side), so the diff surface is
// scoped to either a task or a conversation rather than a task alone.
export type WorkspaceDiffScope = { workItemId: string } | { conversationId: string };
const workspaceDiffBasePath = (scope: WorkspaceDiffScope) => 'workItemId' in scope
  ? `/api/work-items/${scope.workItemId}`
  : `/api/shared/conversations/${scope.conversationId}`;

/** Wire-level action union for `/api/review-assist*`; mirrors
 * `reviewAssistRequestSchema` in shared contracts. */
export type ReviewAssistActionName = 'explain' | 'what_could_break' | 'compare_task_intent' | 'score_risk';

export const sourceClient = {
  resolveSourceUrl: (url: string) => request<{ draft: ResolvedSourceDraft }>('/api/sources/resolve', { method: 'POST', body: JSON.stringify({ url }) }),
  searchSources: (query: string, sources: BrokerSourceId[], signal?: AbortSignal) => request<BrokerSearchResponse>('/api/sources/search', { method: 'POST', body: JSON.stringify({ query, sources }), signal }),
  listSourceConnections: () => request<{ connections: BrokerConnection[] }>('/api/source-connections'),
  getFigmaScope: () => request<{ roots: string[] }>('/api/source-connections/figma/scope'),
  updateFigmaScope: (roots: string[]) => request<{ roots: string[] }>('/api/source-connections/figma/scope', { method: 'PUT', body: JSON.stringify({ roots }) }),
  startMcpOAuth: (provider: 'confluence' | 'slack' | 'figma' | 'gmail', serverUrl?: string) => request<{ url: string }>(`/api/source-connections/${provider}/mcp/oauth/start`, { method: 'POST', body: JSON.stringify({ serverUrl }) }),
  configureGrafana: (token: string) => request<{ configured: true }>('/api/source-connections/grafana', { method: 'PUT', body: JSON.stringify({ token }) }),
  disconnectSource: (provider: 'confluence' | 'slack' | 'figma' | 'grafana' | 'gmail' | 'github') => request<void>(`/api/source-connections/${provider}`, { method: 'DELETE' }),
  getWorkspaceDiff: (scope: WorkspaceDiffScope) => request<{ diff: WorkspaceDiff }>(`${workspaceDiffBasePath(scope)}/workspace-diff`),
  getWorkspaceDiffSnapshots: (scope: WorkspaceDiffScope) => request<{ snapshots: WorkspaceDiffSnapshot[] }>(`${workspaceDiffBasePath(scope)}/workspace-diff/snapshots`),
  getWorkspaceDiffStatus: (scope: WorkspaceDiffScope, revision: string) => request<{ changed: boolean }>(`${workspaceDiffBasePath(scope)}/workspace-diff/status?revision=${encodeURIComponent(revision)}`),
  getDiffHunkReviews: (scope: WorkspaceDiffScope, revision: string) => request<{ reviews: DiffHunkReview[] }>(`${workspaceDiffBasePath(scope)}/workspace-diff/hunk-reviews?revision=${encodeURIComponent(revision)}`),
  upsertDiffHunkReview: (scope: WorkspaceDiffScope, input: { revision: string; filePath: string; hunkRange: string; state: DiffHunkReviewState; note?: string }) => request<{ review: DiffHunkReview }>(`${workspaceDiffBasePath(scope)}/workspace-diff/hunk-reviews`, { method: 'PUT', body: JSON.stringify(input) }),
  upsertDiffHunkReviews: (scope: WorkspaceDiffScope, input: UpsertDiffHunkReviewsInput) => request<{ reviews: DiffHunkReview[] }>(`${workspaceDiffBasePath(scope)}/workspace-diff/hunk-reviews/batch`, { method: 'PUT', body: JSON.stringify(input) }),
  getDiffBlockReviews: (scope: WorkspaceDiffScope, revision: string) => request<{ reviews: DiffBlockReview[] }>(`${workspaceDiffBasePath(scope)}/workspace-diff/block-reviews?revision=${encodeURIComponent(revision)}`),
  upsertDiffBlockReview: (scope: WorkspaceDiffScope, input: UpsertDiffBlockReviewInput) => request<{ review: DiffBlockReview }>(`${workspaceDiffBasePath(scope)}/workspace-diff/block-reviews`, { method: 'PUT', body: JSON.stringify(input) }),
  getStaleReferences: (id: string) => request<{ report: StaleReferenceReport }>(`/api/work-items/${id}/workspace-diff/stale-references`),
  getWorkItemWorkspaces: (id: string) => request<{ selectedPath: string | null; workspaces: Array<{ path: string; label: string; selected: boolean }> }>(`/api/work-items/${id}/workspaces`),
  selectWorkItemWorkspace: (id: string, workspacePath: string) => request<{ selectedPath: string; workspaces: Array<{ path: string; label: string; selected: boolean }> }>(`/api/work-items/${id}/workspaces/selection`, { method: 'PUT', body: JSON.stringify({ workspacePath }) }),
  getGitHubPullRequestDiff: (url: string, page = 1) => request<{ diff: GitHubPullRequestDiff }>(`/api/github/pull-request-diff?url=${encodeURIComponent(url)}&page=${page}`),
  assessDiffBlocks: (blocks: Array<{ key: string; lines: string[] }>) => request<{ assessments: Record<string, { risk: number | null; reasoning: string }> }>('/api/diff-confidence', { method: 'POST', body: JSON.stringify({ blocks }) }),
  lookupDiffConfidenceBlocks: (blocks: Array<{ key: string; lines: string[] }>) => request<{ assessments: Record<string, { risk: number | null; reasoning: string }> }>('/api/diff-confidence/lookup', { method: 'POST', body: JSON.stringify({ blocks }) }),
  requestReviewAssist: (input: {
    action: ReviewAssistActionName;
    decision: { behavior: string; state: string; hunks: Array<{ filePath: string; location: string; lines: string[] }> };
    taskIntent: { title: string; description: string } | null;
    tier?: ReviewAssistTier | null;
  }) => request<{ answer: string }>('/api/review-assist', { method: 'POST', body: JSON.stringify(input) }),
  // Streams the answer as the model writes it. The reviewer sees the first
  // words about a second after clicking instead of waiting for the whole turn;
  // the resolved value is still the complete, server-persisted answer.
  streamReviewAssist: async (input: {
    action: ReviewAssistActionName;
    decision: { behavior: string; state: string; hunks: Array<{ filePath: string; location: string; lines: string[] }> };
    taskIntent: { title: string; description: string } | null;
    /** Only the review stack sends this. Omitted, the request body is
     * byte-identical to what it was before tiering existed. */
    tier?: ReviewAssistTier | null;
  }, onDelta: (text: string) => void): Promise<string> => {
    const response = await fetch('/api/review-assist/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`AI assist request failed (${response.status}).`);
    let answer: string | null = null;
    let failure: string | null = null;
    let buffer = '';
    const consume = (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
        if (!line) continue;
        let event: { type?: string; text?: string; answer?: string; message?: string };
        try { event = JSON.parse(line.slice(6)); } catch { continue; }
        if (event.type === 'delta' && typeof event.text === 'string') onDelta(event.text);
        else if (event.type === 'done' && typeof event.answer === 'string') answer = event.answer;
        else if (event.type === 'error') failure = event.message ?? 'AI assist failed.';
      }
    };
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consume(decoder.decode(value, { stream: true }));
      }
    } else {
      consume(await response.text());
    }
    if (failure) throw new Error(failure);
    if (answer === null) throw new Error('AI assist ended without an answer.');
    return answer;
  },
  lookupReviewAssist: (input: {
    action: ReviewAssistActionName;
    decision: { behavior: string; state: string; hunks: Array<{ filePath: string; location: string; lines: string[] }> };
    taskIntent: { title: string; description: string } | null;
    tier?: ReviewAssistTier | null;
  }) => request<{ answer: string | null }>('/api/review-assist/lookup', { method: 'POST', body: JSON.stringify(input) }),
  /** Replays a background scoring pass a pane may have opened in the middle
   * of. Live results arrive over the realtime socket; this only backfills what
   * was streamed before the pane existed. */
  getReviewAutoScore: (input: ({ workItemId: string } | { conversationId: string }) & { revision: string }) => {
    const query = new URLSearchParams(input as Record<string, string>);
    return request<{ snapshot: ReviewAutoScoreSnapshot | null }>(`/api/review-assist/auto-score?${query.toString()}`);
  },
};

export type ReviewAutoScoreSnapshot = {
  revision: string;
  running: boolean;
  completed: number;
  total: number;
  skipped: number;
  entries: Array<{ decisionId: string; ordinal: number; answer: string | null; error: string | null }>;
};
