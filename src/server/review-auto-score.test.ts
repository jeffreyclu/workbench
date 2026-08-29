import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import type { ReviewDecision } from '../shared/review-decisions.js';
import type { ReviewChangeType } from '../shared/change-type.js';

const getWorkspaceDiff = vi.fn();
const requestReviewAssist = vi.fn();
const lookupReviewAssist = vi.fn();
const publishRealtimeReviewScore = vi.fn();

vi.mock('./workspace-diff.js', () => ({ getWorkspaceDiff: (path: string) => getWorkspaceDiff(path) }));
vi.mock('./review-assist-ai.js', () => ({
  requestReviewAssist: (...args: unknown[]) => requestReviewAssist(...args),
  lookupReviewAssist: (...args: unknown[]) => lookupReviewAssist(...args),
}));
vi.mock('./realtime.js', () => ({
  publishRealtimeReviewScore: (score: unknown) => publishRealtimeReviewScore(score),
}));

const { ensureReviewAutoScore, orderDecisionsForAutoScore, resetReviewAutoScore, reviewAutoScoreSnapshot, reviewAutoScoreView, scheduleReviewAutoScore } = await import('./review-auto-score.js');

function diffWith(files: number) {
  return {
    revision: 'rev-1',
    changedFiles: files,
    files: Array.from({ length: files }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      isBinary: false,
      patch: `@@ -1,2 +1,3 @@ function handler${index}(\n+  retry();`,
    })),
  };
}

function newRepository() {
  return new WorkItemRepository(openDatabase(':memory:'));
}

describe('background review scoring', () => {
  beforeEach(() => {
    resetReviewAutoScore();
    getWorkspaceDiff.mockReset();
    requestReviewAssist.mockReset();
    lookupReviewAssist.mockReset();
    lookupReviewAssist.mockReturnValue(null);
    publishRealtimeReviewScore.mockReset();
  });

  it('scores every decision in the diff and streams each result as it settles', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue(diffWith(2));
    requestReviewAssist.mockImplementation((_db, _action, decision) => Promise.resolve(`SCORE: 40\n${decision.hunks[0].filePath}`));

    await scheduleReviewAutoScore(repository, { workItemId: 'item-1' }, process.cwd());

    expect(requestReviewAssist).toHaveBeenCalledTimes(2);
    expect(requestReviewAssist.mock.calls[0][1]).toBe('score_risk');
    // Intent is not part of a risk score's prompt, so it is not part of its request.
    expect(requestReviewAssist.mock.calls[0][3]).toBeNull();
    const streamed = publishRealtimeReviewScore.mock.calls.map(([score]) => score);
    expect(streamed).toHaveLength(2);
    expect(streamed[0]).toMatchObject({ scope: { workItemId: 'item-1' }, revision: 'rev-1', error: null, completed: 1, total: 2 });
    expect(streamed[1]).toMatchObject({ completed: 2, total: 2 });
    expect(streamed[0].answer).toContain('SCORE: 40');
  });

  it('keeps a failed score a visible, retryable failure instead of a neutral result', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue(diffWith(1));
    requestReviewAssist.mockRejectedValue(new Error('AI review assist timed out after 30 seconds.'));

    await scheduleReviewAutoScore(repository, { workItemId: 'item-2' }, process.cwd());

    const [score] = publishRealtimeReviewScore.mock.calls[0];
    expect(score).toMatchObject({ answer: null, error: 'AI review assist timed out after 30 seconds.' });
    expect(reviewAutoScoreSnapshot({ workItemId: 'item-2' }, 'rev-1')?.entries[0].error)
      .toBe('AI review assist timed out after 30 seconds.');
  });

  it('does nothing when the workspace has no changes to score', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue({ revision: 'rev-empty', changedFiles: 0, files: [] });

    await scheduleReviewAutoScore(repository, { workItemId: 'item-3' }, process.cwd());

    expect(requestReviewAssist).not.toHaveBeenCalled();
    expect(publishRealtimeReviewScore).not.toHaveBeenCalled();
  });

  it('never runs two passes over the same scope at once, and reruns once when the diff moves under it', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue(diffWith(1));
    let release: (() => void) | null = null;
    requestReviewAssist.mockImplementation(() => new Promise<string>((resolve) => {
      release = () => resolve('SCORE: 10\nsafe');
    }));

    const first = scheduleReviewAutoScore(repository, { workItemId: 'item-4' }, process.cwd());
    await vi.waitFor(() => expect(release).not.toBeNull());
    const second = scheduleReviewAutoScore(repository, { workItemId: 'item-4' }, process.cwd());
    expect(second).toBe(first);
    release!();
    await first;
    // The queued rerun is a fresh pass, not a third concurrent one.
    await vi.waitFor(() => expect(getWorkspaceDiff).toHaveBeenCalledTimes(2));
  });

  it('replays only the snapshot matching the revision a pane is showing', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue(diffWith(1));
    requestReviewAssist.mockResolvedValue('SCORE: 20\nlow risk');

    await scheduleReviewAutoScore(repository, { conversationId: 'conv-1' }, process.cwd());

    const snapshot = reviewAutoScoreSnapshot({ conversationId: 'conv-1' }, 'rev-1');
    expect(snapshot).toMatchObject({ running: false, completed: 1, total: 1, skipped: 0 });
    expect(snapshot?.entries[0]).toMatchObject({ answer: 'SCORE: 20\nlow risk', error: null });
    expect(reviewAutoScoreSnapshot({ conversationId: 'conv-1' }, 'rev-stale')).toBeNull();
    expect(reviewAutoScoreSnapshot({ workItemId: 'conv-1' }, 'rev-1')).toBeNull();
  });

  it('scores every decision in a large diff instead of leaving a silent tail', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue(diffWith(45));
    requestReviewAssist.mockResolvedValue('SCORE: 5\nfine');

    await scheduleReviewAutoScore(repository, { workItemId: 'item-5' }, process.cwd());

    expect(requestReviewAssist).toHaveBeenCalledTimes(45);
    expect(reviewAutoScoreSnapshot({ workItemId: 'item-5' }, 'rev-1')).toMatchObject({ total: 45, skipped: 0 });
  });

  it('scores with bounded parallelism and streams each result as it settles', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue(diffWith(4));
    let active = 0;
    let peak = 0;
    requestReviewAssist.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return 'SCORE: 25\nBounded.';
    });

    await scheduleReviewAutoScore(repository, { workItemId: 'parallel' }, process.cwd());

    expect(peak).toBe(2);
    expect(publishRealtimeReviewScore).toHaveBeenCalledTimes(4);
  });

  it('starts a missing revision asynchronously when a Changes pane observes it', async () => {
    const repository = newRepository();
    const item = repository.create({ title: 'Observed review', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: process.cwd(), dueDate: null });
    repository.database.prepare('INSERT INTO work_item_workspace_selection (work_item_id, workspace_path, updated_at) VALUES (?, ?, ?)')
      .run(item.id, process.cwd(), new Date().toISOString());
    getWorkspaceDiff.mockResolvedValue(diffWith(1));
    requestReviewAssist.mockResolvedValue('SCORE: 20\nLow risk.');

    ensureReviewAutoScore(repository, { workItemId: item.id }, 'rev-1');

    await vi.waitFor(() => expect(reviewAutoScoreSnapshot({ workItemId: item.id }, 'rev-1')?.running).toBe(false));
    expect(requestReviewAssist).toHaveBeenCalledTimes(1);
  });

  it('serves scores already persisted for the current diff without spending a model turn', async () => {
    const repository = newRepository();
    const item = repository.create({ title: 'Persisted scores', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: process.cwd(), dueDate: null });
    repository.database.prepare('INSERT INTO work_item_workspace_selection (work_item_id, workspace_path, updated_at) VALUES (?, ?, ?)')
      .run(item.id, process.cwd(), new Date().toISOString());
    getWorkspaceDiff.mockResolvedValue(diffWith(2));
    lookupReviewAssist.mockReturnValue('SCORE: 15\nPersisted answer.');

    // No job has run in this process — the state a pane sees after a runtime
    // restart, or on any later visit to Changes.
    expect(reviewAutoScoreSnapshot({ workItemId: item.id }, 'rev-1')).toBeNull();

    const view = await reviewAutoScoreView(repository, { workItemId: item.id }, 'rev-1');

    expect(view).toMatchObject({ revision: 'rev-1', running: false });
    expect(view?.entries).toHaveLength(2);
    expect(view?.entries.every((entry) => entry.answer === 'SCORE: 15\nPersisted answer.')).toBe(true);
    expect(requestReviewAssist).not.toHaveBeenCalled();
  });

  it('does not replay persisted scores against a diff that has moved on', async () => {
    const repository = newRepository();
    const item = repository.create({ title: 'Moved diff', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: process.cwd(), dueDate: null });
    repository.database.prepare('INSERT INTO work_item_workspace_selection (work_item_id, workspace_path, updated_at) VALUES (?, ?, ?)')
      .run(item.id, process.cwd(), new Date().toISOString());
    getWorkspaceDiff.mockResolvedValue(diffWith(1));
    lookupReviewAssist.mockReturnValue('SCORE: 15\nPersisted answer.');

    expect(await reviewAutoScoreView(repository, { workItemId: item.id }, 'rev-2')).toBeNull();
  });
});

describe('auto-score ordering', () => {
  const decision = (ordinal: number, changeType: ReviewChangeType): ReviewDecision => ({
    id: `decision-${ordinal}`, ordinal, subject: null, behavior: `Decision ${ordinal}.`,
    hunks: [], filePaths: [], additions: 0, deletions: 0, riskSignals: [],
    changeType, secondaryChangeTypes: [], state: null, note: null,
  });

  it('spends the capped budget on the decisions a reviewer cannot guess the score of', () => {
    const ordered = orderDecisionsForAutoScore([
      decision(1, 'docs_comment'), decision(2, 'test_only'), decision(3, 'deletion'), decision(4, 'new_code'),
    ]);

    expect(ordered.map((entry) => entry.ordinal)).toEqual([3, 4, 2, 1]);
  });

  it('keeps source order within a change type, so the queue stays predictable', () => {
    const ordered = orderDecisionsForAutoScore([decision(7, 'new_code'), decision(2, 'new_code'), decision(5, 'new_code')]);

    expect(ordered.map((entry) => entry.ordinal)).toEqual([2, 5, 7]);
  });
});
