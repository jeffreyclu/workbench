import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';

const getWorkspaceDiff = vi.fn();
const requestReviewAssist = vi.fn();
const publishRealtimeReviewScore = vi.fn();

vi.mock('./workspace-diff.js', () => ({ getWorkspaceDiff: (path: string) => getWorkspaceDiff(path) }));
vi.mock('./review-assist-ai.js', () => ({
  requestReviewAssist: (...args: unknown[]) => requestReviewAssist(...args),
}));
vi.mock('./realtime.js', () => ({
  publishRealtimeReviewScore: (score: unknown) => publishRealtimeReviewScore(score),
}));

const { resetReviewAutoScore, reviewAutoScoreSnapshot, scheduleReviewAutoScore } = await import('./review-auto-score.js');

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

  it('caps a very large diff and reports what it did not score', async () => {
    const repository = newRepository();
    getWorkspaceDiff.mockResolvedValue(diffWith(45));
    requestReviewAssist.mockResolvedValue('SCORE: 5\nfine');

    await scheduleReviewAutoScore(repository, { workItemId: 'item-5' }, process.cwd());

    expect(requestReviewAssist).toHaveBeenCalledTimes(40);
    expect(reviewAutoScoreSnapshot({ workItemId: 'item-5' }, 'rev-1')).toMatchObject({ total: 40, skipped: 5 });
  });
});
