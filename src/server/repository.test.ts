import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiff } from '../shared/contracts.js';
import { buildReviewDecisions, contentHashOfLines } from '../shared/review-decisions.js';
import { readFileSync, rmSync } from 'node:fs';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemDependencyError, WorkItemRepository, WorkItemVersionConflictError } from './repository.js';
import { cancelSharedReply, deliverPendingSharedInterjections, dispatchNextSharedTurn, interjectQueuedSharedMessage, interjectionSteeringPrompt, isSharedReplyActive, registerActiveReplySteering, runSharedBackgroundJob, synthesisSource } from './shared-room.js';
import { setEmbedder } from './memory-index.js';
import { deterministicTestEmbedder } from './memory-index.test-helpers.js';
import { fakeAgentDirectory } from './test-fake-agent.js';
import { HEARTBEAT_MS } from './scheduler.js';

describe('WorkItemRepository', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
    // searchActivityMemory refreshes memory-index.ts before every search;
    // stub the embedder so tests never download or run the real model.
    setEmbedder(deterministicTestEmbedder);
  });

  afterEach(() => {
    database.close();
    setEmbedder(null);
  });

  it('keeps one immutable workspace diff record per reviewed revision after the workspace is clean', () => {
    const item = repository.create({ title: 'Preserve diff record', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const diff: WorkspaceDiff = {
      workspacePath: '/tmp/workbench', branch: 'feature/timeline', revision: 'reviewed-revision', changedFiles: 1, additions: 1, deletions: 0,
      publish: { branch: 'feature/timeline', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
      files: [{ path: 'src/version.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+version', isBinary: false }],
    };

    const run = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Implement it.');
    const first = repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff, { originatingAgentRunId: run.id, commitHash: '0123456789abcdef' });
    const duplicate = repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff);

    expect(duplicate.id).toBe(first.id);
    expect(repository.listWorkspaceDiffSnapshots({ workItemId: item.id })).toEqual([expect.objectContaining({ id: first.id, diff, originatingAgentRunId: run.id, commitHash: '0123456789abcdef' })]);
  });

  it('keeps a record per repository when two checkouts produce the same revision', () => {
    const item = repository.create({ title: 'Two checkouts', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const diff = (workspacePath: string): WorkspaceDiff => ({
      workspacePath, branch: 'feature/same', revision: 'identical-revision', changedFiles: 1, additions: 1, deletions: 0,
      publish: { branch: 'feature/same', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
      files: [{ path: 'src/version.ts', previousPath: null, status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+version', isBinary: false }],
    });

    const left = repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff('/tmp/left'), { repositoryIdentity: '/tmp/left/.git' });
    const right = repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff('/tmp/right'), { repositoryIdentity: '/tmp/right/.git' });

    // Identifying a record by revision alone discarded the second repository's
    // capture and handed back the first repository's row, filing one
    // repository's changes permanently under the other's name.
    expect(right.id).not.toBe(left.id);
    expect(right.diff.workspacePath).toBe('/tmp/right');
    expect(repository.listWorkspaceDiffSnapshots({ workItemId: item.id })
      .map((snapshot) => snapshot.repositoryIdentity).sort()).toEqual(['/tmp/left/.git', '/tmp/right/.git']);
  });

  it('upserts a diff hunk review by identity and lists reviews scoped to the owning work item', () => {
    const item = repository.create({ title: 'Hunk review', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const other = repository.create({ title: 'Other item', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', hunkRange: '@@ -1,3 +1,3 @@', contentHash: 'hash-a', state: 'reviewed' });
    const updated = repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', hunkRange: '@@ -1,3 +1,3 @@', contentHash: 'hash-a', state: 'needs_changes', note: 'please fix' });
    repository.upsertDiffHunkReview({ workItemId: other.id }, { revision: 'rev-1', filePath: 'src/a.ts', hunkRange: '@@ -1,3 +1,3 @@', contentHash: 'hash-a', state: 'reviewed' });

    expect(updated.state).toBe('needs_changes');
    expect(updated.note).toBe('please fix');
    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-1')).toEqual([expect.objectContaining({ filePath: 'src/a.ts', hunkRange: '@@ -1,3 +1,3 @@', state: 'needs_changes', note: 'please fix' })]);
    expect(repository.listDiffHunkReviews({ workItemId: other.id }, 'rev-1')).toEqual([expect.objectContaining({ state: 'reviewed' })]);
  });

  it('carries only reviewed byte-identical hunks from the immediately preceding revision', () => {
    const item = repository.create({ title: 'Carried hunk review', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const first: WorkspaceDiff = {
      workspacePath: '/tmp/workbench', branch: 'feature/review', revision: 'rev-1', changedFiles: 4, additions: 4, deletions: 4,
      publish: { branch: 'feature/review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
      files: [
        { path: 'src/stable.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -10,2 +10,2 @@\n const stable = true;\n-oldCall();\n+newCall();', isBinary: false },
        { path: 'src/edited.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -20 +20 @@\n-oldValue\n+firstValue', isBinary: false },
        { path: 'src/commented.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -30 +30 @@\n-oldComment\n+newComment', isBinary: false },
        { path: 'src/blocked.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -40 +40 @@\n-oldBlock\n+newBlock', isBinary: false },
      ],
    };
    const second: WorkspaceDiff = {
      ...first,
      revision: 'rev-2',
      files: [
        { ...first.files[0], patch: '@@ -10,2 +18,2 @@\n const stable = true;\n-oldCall();\n+newCall();' },
        { ...first.files[1], patch: '@@ -20 +28 @@\n-firstValue\n+secondValue' },
        { ...first.files[2], patch: '@@ -30 +38 @@\n-oldComment\n+newComment' },
        { ...first.files[3], patch: '@@ -40 +48 @@\n-oldBlock\n+newBlock' },
      ],
    };
    repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, first);
    repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/stable.ts', hunkRange: '@@ -10,2 +10,2 @@', contentHash: contentHashOfLines([' const stable = true;', '-oldCall();', '+newCall();']), state: 'reviewed' });
    repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/edited.ts', hunkRange: '@@ -20 +20 @@', contentHash: contentHashOfLines(['-oldValue', '+firstValue']), state: 'reviewed' });
    repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/commented.ts', hunkRange: '@@ -30 +30 @@', contentHash: contentHashOfLines(['-oldComment', '+newComment']), state: 'commented', note: 'discussion only' });
    repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/blocked.ts', hunkRange: '@@ -40 +40 @@', contentHash: contentHashOfLines(['-oldBlock', '+newBlock']), state: 'needs_changes', note: 'please fix' });
    repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, second);

    const carried = repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-2');
    expect(carried).toEqual([
      expect.objectContaining({ revision: 'rev-1', filePath: 'src/edited.ts', state: 'reviewed' }),
      expect.objectContaining({ revision: 'rev-1', filePath: 'src/stable.ts', state: 'reviewed' }),
    ]);
    const decisions = buildReviewDecisions(second.files, carried);
    const hunks = decisions.flatMap((decision) => decision.hunks);
    expect(hunks.find((hunk) => hunk.filePath === 'src/stable.ts')).toEqual(expect.objectContaining({ hunkRange: '@@ -10,2 +18,2 @@', state: 'reviewed' }));
    expect(hunks.find((hunk) => hunk.filePath === 'src/edited.ts')).toEqual(expect.objectContaining({ state: null }));
    expect(hunks.find((hunk) => hunk.filePath === 'src/commented.ts')).toEqual(expect.objectContaining({ state: null }));
    expect(hunks.find((hunk) => hunk.filePath === 'src/blocked.ts')).toEqual(expect.objectContaining({ state: null }));

    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ revision: 'rev-1', filePath: 'src/stable.ts', state: 'reviewed' }),
      expect.objectContaining({ revision: 'rev-1', filePath: 'src/commented.ts', state: 'commented', note: 'discussion only' }),
      expect.objectContaining({ revision: 'rev-1', filePath: 'src/blocked.ts', state: 'needs_changes', note: 'please fix' }),
    ]));
  });

  it('does not skip an undecided intermediate revision when carrying hunk reviews', () => {
    const item = repository.create({ title: 'Immediate predecessor only', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const diff = (revision: string): WorkspaceDiff => ({
      workspacePath: '/tmp/workbench', branch: 'feature/review', revision, changedFiles: 1, additions: 1, deletions: 1,
      publish: { branch: 'feature/review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
      files: [{ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new', isBinary: false }],
    });
    repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff('rev-1'));
    repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', hunkRange: '@@ -1 +1 @@', contentHash: contentHashOfLines(['-old', '+new']), state: 'reviewed' });
    repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff('rev-2'));
    repository.captureWorkspaceDiffSnapshot({ workItemId: item.id }, diff('rev-3'));

    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-3')).toEqual([]);
  });

  it('carries reviewed hunks across standalone review snapshots', () => {
    const review = repository.createStandaloneReview({ pullRequestUrl: 'https://github.com/acme/widgets/pull/42' });
    const diff = (revision: string, range: string): WorkspaceDiff => ({
      workspacePath: '', branch: 'feature/review', revision, changedFiles: 1, additions: 1, deletions: 1,
      publish: { branch: null, hasOrigin: false, ahead: 0, hasChanges: false, reason: 'Pull request diff.' },
      files: [{ path: 'src/a.ts', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: `${range}\n-old\n+new`, isBinary: false }],
    });
    repository.captureStandaloneReviewDiffSnapshot(review.id, diff('rev-1', '@@ -1 +1 @@'));
    repository.upsertDiffHunkReview({ reviewId: review.id }, { revision: 'rev-1', filePath: 'src/a.ts', hunkRange: '@@ -1 +1 @@', contentHash: contentHashOfLines(['-old', '+new']), state: 'reviewed' });
    repository.captureStandaloneReviewDiffSnapshot(review.id, diff('rev-2', '@@ -1 +10 @@'));

    expect(repository.listDiffHunkReviews({ reviewId: review.id }, 'rev-2'))
      .toEqual([expect.objectContaining({ revision: 'rev-1', filePath: 'src/a.ts', state: 'reviewed' })]);
    expect(repository.listStandaloneReviewDiffSnapshots(review.id).map((snapshot) => snapshot.revision)).toEqual(['rev-2', 'rev-1']);
  });

  it('keeps a verdict recorded before content was tracked with the revision it was given about', () => {
    const item = repository.create({ title: 'Legacy hunk review', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    database.prepare(`INSERT INTO diff_hunk_reviews (id, work_item_id, revision, file_path, hunk_range, content_hash, state, note, updated_at)
      VALUES ('legacy-1', ?, 'rev-1', 'src/a.ts', '@@ -1,3 +1,3 @@', '', 'reviewed', NULL, '2026-01-01T00:00:00.000Z')`).run(item.id);

    // Still answered where it was answered: an existing review must not be
    // thrown away by the move to content matching.
    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-1'))
      .toEqual([expect.objectContaining({ filePath: 'src/a.ts', contentHash: '', state: 'reviewed' })]);
    // But never carried forward: with no hash there is nothing to prove the
    // code it judged is the code now on screen.
    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-2')).toEqual([]);
  });

  it('keeps block-level review state separate from hunk-level review state', () => {
    const item = repository.create({ title: 'Block review', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.upsertDiffHunkReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', hunkRange: '@@ -1,20 +1,30 @@', contentHash: 'hash-hunk', state: 'reviewed' });

    const block = repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@ parseBody', contentHash: 'abc123', state: 'needs_changes', note: 'unhandled empty body' });
    expect(block.state).toBe('needs_changes');

    // Reviewing a block does not mark its hunk reviewed, and vice versa: the
    // two granularities are deliberately not reconciled.
    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-1')).toEqual([expect.objectContaining({ hunkRange: '@@ -1,20 +1,30 @@', state: 'reviewed' })]);
    expect(repository.listDiffBlockReviews({ workItemId: item.id }, 'rev-1')).toEqual([expect.objectContaining({ blockRange: '@@ -1,8 +1,12 @@ parseBody', contentHash: 'abc123', state: 'needs_changes' })]);
  });

  it('records a rewritten block as a separate verdict from the one it replaced', () => {
    const item = repository.create({ title: 'Rewritten block', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@', contentHash: 'hash-before', state: 'reviewed' });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@', contentHash: 'hash-after', state: 'commented' });

    const reviews = repository.listDiffBlockReviews({ workItemId: item.id }, 'rev-1');
    expect(reviews).toHaveLength(2);
    expect(reviews.map((review) => review.contentHash).sort()).toEqual(['hash-after', 'hash-before']);
  });

  /** A verdict answers a piece of code, not a revision. Rebasing or pushing a
   * follow-up commit changes the revision of every block in the diff including
   * the untouched ones, so a revision-scoped read threw the whole review away
   * and asked the same questions again. */
  it('carries a block verdict onto a later revision when the content is unchanged', () => {
    const item = repository.create({ title: 'Carried verdict', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@', contentHash: 'hash-x', state: 'reviewed', note: 'checked the empty case' });

    expect(repository.listDiffBlockReviews({ workItemId: item.id }, 'rev-2'))
      .toEqual([expect.objectContaining({ revision: 'rev-1', contentHash: 'hash-x', state: 'reviewed', note: 'checked the empty case' })]);
  });

  it('lets the answer given at this revision supersede the one before it', () => {
    const item = repository.create({ title: 'Superseded verdict', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@', contentHash: 'hash-x', state: 'needs_changes' });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-2', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@', contentHash: 'hash-x', state: 'reviewed' });

    const reviews = repository.listDiffBlockReviews({ workItemId: item.id }, 'rev-2');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toEqual(expect.objectContaining({ revision: 'rev-2', state: 'reviewed' }));
  });

  /** What the reviewer wrote outlives the state it was written under, the same
   * way it already did across a state change within one revision. */
  it('carries a note onto the later verdict about the same content', () => {
    const item = repository.create({ title: 'Carried note', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@', contentHash: 'hash-x', state: 'commented', note: 'why is this retried?' });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-2', filePath: 'src/a.ts', blockRange: '@@ -1,8 +1,12 @@', contentHash: 'hash-x', state: 'reviewed' });

    expect(repository.listDiffBlockReviews({ workItemId: item.id }, 'rev-2')[0])
      .toEqual(expect.objectContaining({ revision: 'rev-2', state: 'reviewed', note: 'why is this retried?' }));
  });

  /** Two blocks that happen to hold the same lines were answered separately.
   * Collapsing them by content would silently drop one of those answers. */
  it('keeps both answers when one file repeats the same block content at two ranges', () => {
    const item = repository.create({ title: 'Twin blocks', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -1,4 +1,4 @@', contentHash: 'twin', state: 'reviewed' });
    repository.upsertDiffBlockReview({ workItemId: item.id }, { revision: 'rev-1', filePath: 'src/a.ts', blockRange: '@@ -40,4 +40,4 @@', contentHash: 'twin', state: 'needs_changes' });

    const reviews = repository.listDiffBlockReviews({ workItemId: item.id }, 'rev-2');
    expect(reviews).toHaveLength(2);
    expect(reviews.map((review) => review.state).sort()).toEqual(['needs_changes', 'reviewed']);
  });

  it('upserts every hunk in one review decision through the batch boundary', () => {
    const item = repository.create({ title: 'Cross-file review', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const reviews = repository.upsertDiffHunkReviews({ workItemId: item.id }, {
      revision: 'rev-cross-file',
      hunks: [
        { filePath: 'src/authorize.ts', hunkRange: '@@ -1 +1 @@ function authorizeRequest()', contentHash: 'hash-source' },
        { filePath: 'src/authorize.test.ts', hunkRange: '@@ -10 +10 @@ describe("authorizeRequest")', contentHash: 'hash-test' },
      ],
      state: 'reviewed',
      note: 'Validated together.',
    });

    expect(reviews).toHaveLength(2);
    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-cross-file')).toEqual([
      expect.objectContaining({ filePath: 'src/authorize.test.ts', state: 'reviewed', note: 'Validated together.' }),
      expect.objectContaining({ filePath: 'src/authorize.ts', state: 'reviewed', note: 'Validated together.' }),
    ]);
  });

  it('rolls back every hunk when one write in a review decision fails', () => {
    const item = repository.create({ title: 'Atomic cross-file review', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    database.exec(`CREATE TRIGGER fail_review_hunk BEFORE INSERT ON diff_hunk_reviews
      WHEN NEW.file_path = 'src/fail.ts'
      BEGIN SELECT RAISE(ABORT, 'forced review failure'); END`);

    expect(() => repository.upsertDiffHunkReviews({ workItemId: item.id }, {
      revision: 'rev-atomic',
      hunks: [
        { filePath: 'src/succeeds-first.ts', hunkRange: '@@ -1 +1 @@ function updateDecision()', contentHash: 'hash-ok' },
        { filePath: 'src/fail.ts', hunkRange: '@@ -10 +10 @@ describe("updateDecision")', contentHash: 'hash-fail' },
      ],
      state: 'needs_changes',
      note: 'Both hunks must remain pending.',
    })).toThrow('forced review failure');
    expect(repository.listDiffHunkReviews({ workItemId: item.id }, 'rev-atomic')).toEqual([]);
  });

  it('uses the normal CLI account for repository-created runs unless a profile is explicitly selected', () => {
    const item = repository.create({ title: 'Account default', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    expect(repository.createRun(item.id, 'analysis', 'codex', 'codex', '').accountProfile).toBe('default');
    expect(repository.createRun(item.id, 'analysis', 'claude', 'claude', '', null, null, 'manual', 'work').accountProfile).toBe('work');
  });

  it('finalizes work owned by a runtime that is deliberately stopping', () => {
    const item = repository.create({ title: 'Promote safely', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
    const message = repository.createSharedMessage('claude', 'Partial response', 'running', conversation.id);
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', '', conversation.id, message.id);
    repository.claimRun(run.id, 'runtime-a', 60_000);
    repository.claimSharedMessage(message.id, 'runtime-a', 60_000);

    expect(repository.interruptOwnedWork('runtime-a', 'Runtime promoted.')).toEqual({ runIds: [run.id], messageIds: [message.id] });
    expect(repository.getRun(run.id)).toMatchObject({ status: 'failed', error: 'Runtime promoted.' });
    expect(repository.getSharedMessageById(message.id)).toMatchObject({ status: 'failed', error: 'Runtime promoted.' });
  });

  it('keeps fresh input, cache writes, cache reads, and output distinct in terminal-run insights', () => {
    const item = repository.create({ title: 'Measure usage', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const codexRun = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Implement it.');
    const claudeRun = repository.createRun(item.id, 'review', 'claude', 'claude', 'Review it.');
    const unreportedRun = repository.createRun(item.id, 'research', 'codex', 'codex', 'Research it.');
    const completedAt = new Date().toISOString();
    repository.updateRun(codexRun.id, { status: 'completed', completedAt, model: 'gpt-5.6-terra', inputTokens: 1_200, cacheReadInputTokens: 0, outputTokens: 300 });
    repository.updateRun(claudeRun.id, { status: 'failed', completedAt, model: 'claude-sonnet', inputTokens: 400, cacheCreationInputTokens: 50, cacheReadInputTokens: 5_000, outputTokens: 100 });
    repository.updateRun(unreportedRun.id, { status: 'completed', completedAt, model: 'gpt-5.6-terra' });

    expect(repository.getRunInsights()).toMatchObject({
      inputTokens: 1_600,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 5_000,
      outputTokens: 400,
      tokenUsageByModel: [
        { provider: 'claude', model: 'claude-sonnet', inputTokens: 400, cacheCreationInputTokens: 50, cacheReadInputTokens: 5_000, outputTokens: 100 },
        { provider: 'codex', model: 'gpt-5.6-terra', inputTokens: 1_200, outputTokens: 300 },
      ],
      incompleteTokenTelemetryRuns: 0,
    });
  });

  it('prices terminal runs and shared replies as they are written, with provenance', () => {
    const item = repository.create({ title: 'Meter spend', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Do it.');
    // The model lands in an earlier patch than the tokens, exactly as the
    // runner writes them; the second patch must still price the run.
    repository.updateRun(run.id, { model: 'opus' });
    repository.updateRun(run.id, { status: 'completed', completedAt: new Date().toISOString(), inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 });
    expect(repository.getRun(run.id)).toMatchObject({ estimatedCostUsd: 15, costSource: 'estimated' });

    // A provider-reported amount supersedes the list-price estimate.
    repository.updateRun(run.id, { costUsd: 2.5 });
    expect(repository.getRun(run.id)).toMatchObject({ estimatedCostUsd: 2.5, costSource: 'provider' });

    const conversation = repository.createConversation('Priced reply');
    const reply = repository.createSharedMessage('claude', 'Working…', 'running', conversation.id);
    repository.updateSharedMessage(reply.id, { status: 'completed', model: 'haiku', inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 1_000_000 });
    expect(repository.getSharedMessageById(reply.id)).toMatchObject({ estimatedCostUsd: 6, costSource: 'estimated' });
  });

  it('reports window spend in insights instead of a permanent zero', () => {
    const item = repository.create({ title: 'Spend rollup', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const opus = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Expensive.');
    const unpriced = repository.createRun(item.id, 'analysis', 'claude', 'claude', 'Unknown model.');
    const completedAt = new Date().toISOString();
    repository.updateRun(opus.id, { status: 'completed', completedAt, model: 'opus', inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000_000, outputTokens: 0 });
    repository.updateRun(unpriced.id, { status: 'completed', completedAt, model: 'not-a-known-model', inputTokens: 1_000, cacheReadInputTokens: 0, outputTokens: 1_000 });

    const insights = repository.getRunInsights();
    // 1M fresh input at $15/MTok + 1M cache reads at $1.50/MTok.
    expect(insights.estimatedCostUsd).toBeCloseTo(16.5, 6);
    expect(insights.unpricedTokenTelemetryRuns).toBe(1);
    expect(insights.tokenUsageByModel.find((row) => row.model === 'opus')?.estimatedCostUsd).toBeCloseTo(16.5, 6);
  });

  it('filters Insights to the requested rolling timeframe while All Time retains older records', () => {
    const item = repository.create({ title: 'Timeframe coverage', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const recentRun = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Recent run.');
    const oldRun = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Old run.');
    repository.updateRun(recentRun.id, { status: 'completed', completedAt: new Date().toISOString() });
    repository.updateRun(oldRun.id, { status: 'completed', completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });

    expect(repository.getRunInsights('15m').completedRuns).toBe(1);
    expect(repository.getRunInsights('1h').completedRuns).toBe(1);
    expect(repository.getRunInsights('1d').completedRuns).toBe(2);
    expect(repository.getRunInsights('7d').completedRuns).toBe(2);
    expect(repository.getRunInsights('30d').completedRuns).toBe(2);
    expect(repository.getRunInsights('all').completedRuns).toBe(2);
  });

  it('omits legacy token rows without a cache split instead of inventing fresh input', () => {
    const item = repository.create({ title: 'Legacy telemetry', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const legacy = repository.createRun(item.id, 'analysis', 'codex', 'codex', 'Legacy run.');
    repository.updateRun(legacy.id, { status: 'completed', completedAt: new Date().toISOString(), model: 'gpt-5.6-terra', inputTokens: 99_000, outputTokens: 900 });

    const insights = repository.getRunInsights();
    expect(insights).toMatchObject({ inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, incompleteTokenTelemetryRuns: 1 });
    expect(insights.tokenUsageByModel).toEqual([]);
  });

  it('persists all provider token classes on shared-room replies', () => {
    const conversation = repository.createConversation('Usage telemetry');
    const reply = repository.createSharedMessage('claude', 'Working…', 'running', conversation.id);

    repository.updateSharedMessage(reply.id, {
      status: 'completed',
      inputTokens: 1_700,
      cacheCreationInputTokens: 2_000_000,
      cacheReadInputTokens: 57_500_000,
      outputTokens: 184_400,
    });

    expect(repository.getSharedMessageById(reply.id)).toMatchObject({
      inputTokens: 1_700,
      cacheCreationInputTokens: 2_000_000,
      cacheReadInputTokens: 57_500_000,
      outputTokens: 184_400,
    });
    const insights = repository.getRunInsights();
    expect(insights.tokenUsageByModel).toContainEqual(expect.objectContaining({
      provider: 'claude', inputTokens: 1_700, cacheCreationInputTokens: 2_000_000,
      cacheReadInputTokens: 57_500_000, outputTokens: 184_400,
    }));
  });

  it('records one immutable session verdict with its decision-tree evidence', () => {
    const task = repository.create({ title: 'Rate the outcome', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Decision trace', task.id);
    const reply = repository.createSharedMessage('codex', 'I will inspect the completion path.', 'completed', conversation.id);
    repository.addAgentStreamEvents(reply.id, null, [
      { kind: 'decision', detail: 'Inspect the completion path before changing code.' },
      { kind: 'tool', detail: 'rg completion path' },
    ]);

    const recorded = repository.createSessionFeedback({ conversationId: conversation.id, workItemId: task.id, rating: 'positive' });
    const repeated = repository.createSessionFeedback({ conversationId: conversation.id, workItemId: task.id, rating: 'negative' });

    expect(recorded).toMatchObject({ rating: 'positive', conversationId: conversation.id, workItemId: task.id });
    expect(recorded?.decisionTree.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: reply.id, kind: 'decision', detail: 'Inspect the completion path before changing code.' }),
      expect.objectContaining({ messageId: reply.id, kind: 'tool', detail: 'rg completion path' }),
    ]));
    expect(repeated).toEqual(recorded);
    expect(repository.getSessionFeedback(conversation.id, task.id)).toEqual(recorded);
  });

  it('attributes cursing to the model that most recently replied in the conversation', () => {
    const conversation = repository.createConversation('Model attribution');
    const claudeReply = repository.createSharedMessage('claude', 'Here is the first answer.', 'completed', conversation.id);
    repository.updateSharedMessage(claudeReply.id, { model: 'sonnet' });
    repository.createSharedMessage('jeffrey', 'This is fucking wrong.', 'completed', conversation.id);
    const codexReply = repository.createSharedMessage('codex', 'Here is the revised answer.', 'completed', conversation.id);
    repository.updateSharedMessage(codexReply.id, { model: 'gpt-5.6-terra' });
    repository.createSharedMessage('jeffrey', 'Still shit.', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', 'What the fuck?', 'completed', conversation.id);

    expect(repository.getRunInsights().cursing.byModel).toEqual([
      expect.objectContaining({ model: 'gpt-5.6-terra', count: 2, messagesWithCurses: 2 }),
      expect.objectContaining({ model: 'sonnet', count: 1, messagesWithCurses: 1 }),
    ]);
  });

  it('persists one grounding per human turn and retrieves the preceding objective', () => {
    const conversation = repository.createConversation('Durable grounding');
    const first = repository.createSharedMessage('jeffrey', 'Fix hunk selection.', 'completed', conversation.id);
    const second = repository.createSharedMessage('jeffrey', 'continue', 'completed', conversation.id);
    const firstGrounding = JSON.stringify({ objective: 'Fix hunk selection.', acceptanceCriteria: [], exclusions: [], continuation: false, source: 'fallback' });
    repository.setSharedTurnGrounding(first.id, conversation.id, firstGrounding);

    expect(repository.getSharedTurnGrounding(first.id)).toBe(firstGrounding);
    expect(repository.latestSharedTurnGrounding(conversation.id, second.id)).toBe(firstGrounding);

    const resolvedContinuation = JSON.stringify({ objective: 'Fix hunk selection.', acceptanceCriteria: [], exclusions: [], continuation: true, source: 'persisted' });
    repository.setSharedTurnGrounding(second.id, conversation.id, resolvedContinuation);
    expect(repository.getSharedTurnGrounding(second.id)).toBe(resolvedContinuation);
  });

  it('shares durable Codex and Claude handoffs only within the conversation or linked task scope', () => {
    const task = repository.create({ title: 'Durable handoff task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const linked = repository.createConversation('Linked handoff', task.id);
    const other = repository.createConversation('Unrelated handoff');
    const codex = repository.createSharedMessage('codex', 'Codex verified the first condition.', 'completed', linked.id);
    const claude = repository.createSharedMessage('claude', 'Claude found the remaining edge case.', 'completed', linked.id);
    const unrelated = repository.createSharedMessage('claude', 'This must not leak.', 'completed', other.id);
    repository.recordAgentHandoff(linked.id, codex.id, 'codex', codex.body);
    repository.recordAgentHandoff(linked.id, claude.id, 'claude', claude.body);
    repository.recordAgentHandoff(other.id, unrelated.id, 'claude', unrelated.body);

    const conversationContext = repository.getSharedContext(undefined, { conversationId: linked.id });
    const taskContext = repository.getSharedContext(undefined, { workItemId: task.id });
    expect(conversationContext).toContain('Codex verified the first condition.');
    expect(conversationContext).toContain('Claude found the remaining edge case.');
    expect(conversationContext).not.toContain('This must not leak.');
    expect(taskContext).toContain('Codex verified the first condition.');
    expect(taskContext).toContain('Claude found the remaining edge case.');
    expect(taskContext).not.toContain('This must not leak.');
  });

  it('backfills a linked conversation brief into its task and removes that task scope on unlink', () => {
    const task = repository.create({ title: 'Link brief history', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Previously manual');
    const decision = repository.createSharedMessage('jeffrey', 'Use the existing API and do not change the database schema.', 'completed', conversation.id);
    repository.recordSharedBriefEntry(conversation.id, decision.id, 'jeffrey', 'decision', decision.body);

    repository.setConversationWorkItem(conversation.id, task.id);
    expect(repository.getSharedContext(undefined, { workItemId: task.id })).toContain('Use the existing API');
    repository.setConversationWorkItem(conversation.id, null);
    expect(repository.getSharedContext(undefined, { workItemId: task.id })).not.toContain('Use the existing API');
  });

  it('retrieves shared history across messages, task activity, and prior runs', async () => {
    const task = repository.create({ title: 'Investigate memory retrieval', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Memory room', task.id);
    repository.createSharedMessage('codex', 'The durable-memory marker appears in this message.', 'completed', conversation.id);
    repository.addActivity(task.id, 'codex', 'progress', 'Recorded durable-memory evidence in activity.');
    const run = repository.createRun(task.id, 'analysis', 'claude', 'claude', 'Search durable-memory history.');
    repository.updateRun(run.id, { status: 'completed', output: 'durable-memory run result' });
    const results = await repository.searchActivityMemory('durable-memory');
    expect(results.map((result) => result.source)).toEqual(expect.arrayContaining(['message', 'activity', 'run']));
  });

  it('excludes a just-sent query echo before prompt retrieval ranks results', async () => {
    const conversation = repository.createConversation('Exclude current prompt echo');
    const query = 'Why did retrieval only return the message I just sent?';
    repository.createSharedMessage('jeffrey', 'Durable retrieval decision: preserve relevant historical memories.', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', query, 'completed', conversation.id);

    const results = await repository.searchActivityMemory(query, 100, { excludeExactBody: query });

    expect(results.some((result) => result.body === query)).toBe(false);
  });

  it('updates indexed conversation memory scope when the conversation is linked to a project task', async () => {
    const task = repository.create({ title: 'Connectors task', description: '', priority: 1, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Unlinked history');
    repository.createSharedMessage('jeffrey', 'The connector gateway has a project-scoped retrieval marker.', 'completed', conversation.id);

    await repository.searchActivityMemory('project-scoped retrieval marker');
    repository.setConversationWorkItem(conversation.id, task.id);
    const scoped = await repository.searchActivityMemory('project-scoped retrieval marker', 100, { projectKey: 'connectors' });

    expect(scoped.map((result) => result.body)).toContain('The connector gateway has a project-scoped retrieval marker.');
  });

  it('does not emit empty agent buckets as insight data', () => {
    expect(repository.getRunInsights().byAgent).toEqual([]);
  });

  it('uses terminal completion time and counts canceled runs as unsuccessful attempts', () => {
    const item = repository.create({ title: 'Reliable run metrics', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const completed = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Implement it.');
    const failed = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Implement it.');
    const canceled = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Implement it.');
    const completedAt = new Date().toISOString();
    repository.updateRun(completed.id, { status: 'completed', completedAt });
    repository.updateRun(failed.id, { status: 'failed', completedAt });
    repository.updateRun(canceled.id, { status: 'canceled', completedAt });
    database.prepare("UPDATE agent_runs SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(completed.id);

    const insights = repository.getRunInsights();
    expect(insights.completedRuns).toBe(1);
    expect(insights.byAgent.find((agent) => agent.agent === 'codex')).toMatchObject({ total: 3, completed: 1, failed: 1, successRate: 1 / 3 });
    expect(insights.byKind).toEqual([expect.objectContaining({ kind: 'execute', completed: 1, failed: 1, canceled: 1, successRate: 1 / 3 })]);
  });

  it('uses lifecycle events for retry and handoff insights, including chat-era history', () => {
    const item = repository.create({ title: 'Lifecycle telemetry', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Implement it.');
    repository.updateRun(run.id, { status: 'canceled', completedAt: new Date().toISOString() });
    repository.addActivity(item.id, 'system', 'execution_retried', 'Retrying claude execute after the prior attempt canceled.');
    repository.addActivity(item.id, 'system', 'agent_fallback', 'claude was unavailable; continued with codex.');

    expect(repository.getRunInsights()).toMatchObject({
      retryCount: 1,
      handoffCount: 1,
      retryRate: 1,
      fallbackRate: 1,
    });
  });

  it('excludes extreme task-cycle outliers before calculating the median insight', () => {
    const hour = 60 * 60 * 1_000;
    const completedAt = new Date().toISOString();
    const durations = [hour, 2 * hour, 3 * hour, 4 * hour, 5 * hour, 90 * 24 * hour];

    for (const [index, duration] of durations.entries()) {
      const item = repository.create({ title: `Cycle ${index}`, description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const startedAt = new Date(new Date(completedAt).getTime() - duration).toISOString();
      const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Do it.');
      repository.updateRun(run.id, { status: 'completed', startedAt, completedAt });
      database.prepare('UPDATE work_items SET completed_at = ? WHERE id = ?').run(completedAt, item.id);
    }

    const medianTaskCycleMs = repository.getRunInsights().medianTaskCycleMs;
    expect(medianTaskCycleMs).not.toBeNull();
    expect(medianTaskCycleMs!).toBeGreaterThan(2.9 * hour);
    expect(medianTaskCycleMs!).toBeLessThan(3.1 * hour);
  });

  it('keeps every task-cycle value when there is not enough history to identify an outlier', () => {
    const hour = 60 * 60 * 1_000;
    const completedAt = new Date().toISOString();
    const durations = [hour, 2 * hour, 3 * hour, 90 * 24 * hour];

    for (const [index, duration] of durations.entries()) {
      const item = repository.create({ title: `Small sample ${index}`, description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const startedAt = new Date(new Date(completedAt).getTime() - duration).toISOString();
      const run = repository.createRun(item.id, 'execute', 'claude', 'claude', 'Do it.');
      repository.updateRun(run.id, { status: 'completed', startedAt, completedAt });
      database.prepare('UPDATE work_items SET completed_at = ? WHERE id = ?').run(completedAt, item.id);
    }

    const medianTaskCycleMs = repository.getRunInsights().medianTaskCycleMs;
    expect(medianTaskCycleMs).not.toBeNull();
    expect(medianTaskCycleMs!).toBeGreaterThan(2.9 * hour);
    expect(medianTaskCycleMs!).toBeLessThan(3.1 * hour);
  });

  it('creates and updates a manual work item', () => {
    const item = repository.create({
      title: 'Ship the queue',
      description: '',
      priority: 1,
      status: 'ready',
      projectName: 'Workbench',
      workspacePath: null,
      dueDate: null,
    });

    expect(item.source).toBe('manual');
    expect(item.isQueued).toBe(true);
    expect(repository.listWorkbench().map((entry) => entry.id)).toContain(item.id);
    expect(repository.update(item.id, { status: 'in_progress' })?.status).toBe('in_progress');
    expect(repository.listActivity(item.id)).toHaveLength(1);
  });

  it('applies an update whose expectedVersion matches the current row and bumps version', () => {
    const item = repository.create({ title: 'Versioned task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    expect(item.version).toBe(1);

    const updated = repository.update(item.id, { title: 'Renamed once', expectedVersion: 1 });
    expect(updated?.title).toBe('Renamed once');
    expect(updated?.version).toBe(2);
  });

  it('rejects a second update against a version already consumed by a prior write', () => {
    const item = repository.create({ title: 'Versioned task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const first = repository.update(item.id, { title: 'First writer wins', expectedVersion: 1 });
    expect(first?.version).toBe(2);

    expect(() => repository.update(item.id, { title: 'Second writer loses', expectedVersion: 1 }))
      .toThrow(WorkItemVersionConflictError);

    const current = repository.get(item.id)!;
    expect(current.title).toBe('First writer wins');
    expect(current.version).toBe(2);
  });

  it('applies an update with no expectedVersion regardless of the current version', () => {
    const item = repository.create({ title: 'Unversioned caller', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.update(item.id, { title: 'Bumped by someone else', expectedVersion: 1 });

    const updated = repository.update(item.id, { title: 'Last write wins' });
    expect(updated?.title).toBe('Last write wins');
    expect(updated?.version).toBe(3);
  });

  it('rolls back a dependency change when a conflicting update also passes blockedByIds', () => {
    const item = repository.create({ title: 'Depends on something', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const prerequisite = repository.create({ title: 'Prerequisite', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    // Consume the version out from under the caller before it applies its own update.
    repository.update(item.id, { title: 'Concurrent edit' });

    expect(() => repository.update(item.id, { title: 'Should not apply', blockedByIds: [prerequisite.id], expectedVersion: 1 }))
      .toThrow(WorkItemVersionConflictError);

    const current = repository.get(item.id)!;
    expect(current.title).toBe('Concurrent edit');
    expect(current.blockedBy ?? []).toHaveLength(0);
  });

  it('never archives a task when editing its title and can restore archived tasks', () => {
    const item = repository.create({ title: 'Old title', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const renamed = repository.update(item.id, { title: 'New title' })!;
    expect(renamed.title).toBe('New title');
    expect(renamed.archivedAt).toBeNull();

    expect(repository.archive(item.id, true)).toEqual(expect.objectContaining({ archivedAt: expect.any(String), completionStatus: 'completed' }));
    const restored = repository.restore(item.id)!;
    expect(restored).toEqual(expect.objectContaining({ archivedAt: null, completedAt: null, completionStatus: 'incomplete', status: 'ready', isQueued: true }));
    expect(repository.listConversations().find((conversation) => conversation.workItemId === item.id)?.archivedAt).toBeUndefined();
  });

  it('logs every lifecycle move so a task never leaves the queue unexplained', () => {
    const item = repository.create({ title: 'Ship the log', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    repository.archive(item.id, true, false, { actor: 'jeffrey' });
    repository.restore(item.id, false, { actor: 'jeffrey' });
    repository.archive(item.id, false, false, { reason: 'its conversation was archived' });

    expect(repository.listActivity(item.id).map((entry) => ({ actor: entry.actor, kind: entry.kind, body: entry.body })))
      .toEqual(expect.arrayContaining([
        { actor: 'jeffrey', kind: 'completed', body: 'Completed and moved to the archive.' },
        { actor: 'jeffrey', kind: 'restored', body: 'Restored from the archive.' },
        { actor: 'system', kind: 'archived', body: 'Archived without completing because its conversation was archived.' },
      ]));
  });

  it('logs a rejected plan so the task does not look untouched after a proposal', () => {
    const parent = repository.create({ title: 'Big migration', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const plan = repository.createExecutionPlan(parent.id, 'Split it.', [
      { title: 'First', description: 'Do it.', workspacePath: null },
      { title: 'Second', description: 'Then this.', workspacePath: null },
    ]);

    repository.resolveExecutionPlan(plan.id, 'rejected');

    expect(repository.listActivity(parent.id).find((entry) => entry.kind === 'decomposed'))
      .toMatchObject({ actor: 'jeffrey', body: 'Rejected the proposed breakdown into 2 tasks.' });
  });

  it('keeps same-millisecond activity in insertion order so a decision precedes its consequence', () => {
    const item = repository.create({ title: 'Fast writer', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    // These land inside one millisecond in practice, which is exactly when a
    // created_at-only sort used to flip the routing decision behind its model.
    repository.addActivity(item.id, 'system', 'execution_started', 'Execution type: execute.');
    repository.addActivity(item.id, 'system', 'model_selected', 'Model: codex gpt-5.6-terra.');

    expect(repository.listActivity(item.id).map((entry) => entry.kind).slice(0, 2)).toEqual(['model_selected', 'execution_started']);
  });

  it('does not repeat a lifecycle entry when the same move is applied twice', () => {
    const item = repository.create({ title: 'Double tapped', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const lifecycle = () => repository.listActivity(item.id).filter((entry) => ['archived', 'completed'].includes(entry.kind));

    repository.archive(item.id, false);
    repository.archive(item.id, false);
    expect(lifecycle().map((entry) => entry.kind)).toEqual(['archived']);

    // Completing a task that was already archived incomplete is a real transition.
    repository.archive(item.id, true);
    repository.archive(item.id, true);
    expect(lifecycle().map((entry) => entry.kind)).toEqual(['completed', 'archived']);
  });

  it('preserves local strategy, assignment, and priority during Linear sync', () => {
    const providerItem = {
      sourceIdentifier: 'ENG-42',
      sourceUrl: 'https://linear.app/example/issue/ENG-42',
      title: 'Initial title',
      description: '',
      status: 'ready' as const,
      priority: 2,
      projectName: 'Core',
      labels: ['frontend'],
      dueDate: null,
      providerUpdatedAt: '2026-08-18T10:00:00.000Z',
      providerPayload: {},
    };
    expect(repository.upsertLinearItem(providerItem)).toBe('imported');
    expect(repository.list()).toHaveLength(0);
    const item = repository.searchLinear('ENG-42')[0];
    repository.queueLinearItem(item.id);
    expect(repository.list()).toHaveLength(1);
    repository.update(item.id, { strategy: 'Codex plans; Claude reviews.', assignees: ['codex'], priority: 0 });

    repository.upsertLinearItem({
      ...providerItem,
      title: 'Updated in Linear',
      providerUpdatedAt: '2026-08-18T11:00:00.000Z',
    });
    const updated = repository.get(item.id)!;
    expect(updated.title).toBe('Updated in Linear');
    expect(updated.strategy).toBe('Codex plans; Claude reviews.');
    expect(updated.assignees).toEqual(['codex']);
    expect(updated.priority).toBe(0);
  });

  it('syncs terminal Linear status in an enclosing transaction without overwriting local fields', () => {
    const input = { sourceIdentifier: 'ENG-TERMINAL', sourceUrl: null, title: 'Provider item', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: [], dueDate: null, providerUpdatedAt: '2026-08-20T00:00:00.000Z', providerPayload: {} };
    repository.upsertLinearItem(input);
    const item = repository.searchLinear('ENG-TERMINAL')[0];
    repository.update(item.id, { strategy: 'Locally owned', priority: 0 });

    expect(repository.transaction(() => repository.upsertLinearItems([{ ...input, status: 'done' as const, providerUpdatedAt: '2026-08-21T00:00:00.000Z' }]))).toEqual(['updated']);
    expect(repository.get(item.id)).toEqual(expect.objectContaining({ status: 'done', strategy: 'Locally owned', priority: 0 }));
  });

  it('preserves a local Linear field edit and records a conflict only when Linear also changes it', () => {
    const input = { sourceIdentifier: 'ENG-43', sourceUrl: null, title: 'Provider title', description: 'Provider description', status: 'ready' as const, priority: 2, projectName: 'Core', labels: ['frontend'], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };
    repository.upsertLinearItem(input);
    const item = repository.searchLinear('ENG-43')[0];
    repository.update(item.id, { title: 'Local title' });
    repository.upsertLinearItem({ ...input, description: 'Provider description v2', providerUpdatedAt: '2026-08-18T11:00:00.000Z' });
    expect(repository.get(item.id)?.title).toBe('Local title');
    expect(repository.get(item.id)?.description).toBe('Provider description v2');
    expect(repository.listProviderConflicts(item.id)).toEqual([]);

    repository.upsertLinearItem({ ...input, title: 'Provider title v2', description: 'Provider description v2', providerUpdatedAt: '2026-08-18T12:00:00.000Z' });
    expect(repository.get(item.id)?.title).toBe('Local title');
    expect(repository.listProviderConflicts(item.id)).toEqual([expect.objectContaining({ field: 'title', localValue: 'Local title', providerValue: 'Provider title v2' })]);
    repository.resolveProviderConflict(item.id, 'title', 'use_provider');
    expect(repository.get(item.id)?.title).toBe('Provider title v2');
    expect(repository.listProviderConflicts(item.id)).toEqual([]);
  });

  it('preserves locally edited labels and exposes the provider value when they conflict', () => {
    const input = { sourceIdentifier: 'ENG-44', sourceUrl: null, title: 'Provider title', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: ['backend'], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };
    repository.upsertLinearItem(input);
    const item = repository.searchLinear('ENG-44')[0];
    repository.update(item.id, { labels: ['frontend', 'backend'] });
    repository.upsertLinearItem({ ...input, labels: ['api'], providerUpdatedAt: '2026-08-18T11:00:00.000Z' });

    expect(repository.get(item.id)?.labels).toEqual(['backend', 'frontend']);
    expect(repository.listProviderConflicts(item.id)).toEqual([expect.objectContaining({ field: 'labels', localValue: ['backend', 'frontend'], providerValue: ['api'] })]);
    repository.resolveProviderConflict(item.id, 'labels', 'keep_local');
    expect(repository.listProviderConflicts(item.id)).toEqual([]);
  });

  it('keeps a proposal side-effect-free until acceptance and rejects stale decisions', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const proposal = repository.createProposal([first.id, second.id], 'New context promotes the first task.');
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
    expect(repository.resolveProposal(proposal.id, 'accepted')?.status).toBe('accepted');
    expect(repository.list().map((item) => item.id)).toEqual([first.id, second.id]);
    const stale = repository.createProposal([second.id, first.id], 'Undo the move.');
    repository.move(second.id, { beforeId: first.id });
    expect(repository.resolveProposal(stale.id, 'rejected')?.status).toBe('superseded');
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('plans the canonical attention stack from the Workbench route', () => {
    const attention = repository.create({ title: 'Customer task', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const fresh = repository.create({ title: 'Fresh Workbench task', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const stale = repository.create({ title: 'Stale Workbench task', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * 86_400_000).toISOString(), stale.id);

    const proposal = repository.buildDailyProposal(Date.now());

    expect(proposal.stack).toBe('attention');
    expect(repository.listWorkbench().map((item) => item.id)).toEqual([stale.id, fresh.id]);
    expect(repository.list().map((item) => item.id)).toEqual([stale.id, fresh.id, attention.id]);
    expect(repository.getPendingProposal('attention')?.id).toBe(proposal.id);
  });

  it('shares recent completed room context without synthesizing durable records', () => {
    const conversation = repository.createConversation('Queue operating model');
    repository.createSharedMessage('jeffrey', 'The queue order is the priority.', 'completed', conversation.id);
    repository.createSharedMessage('claude', 'Preserve yesterday’s order unless context changes.', 'completed', conversation.id);
    repository.createSharedMessage('codex', '', 'running', conversation.id);

    expect(repository.listSharedMessages().messages).toHaveLength(3);
    repository.setConversationArchived(conversation.id, true);
    const context = repository.getSharedContext();
    expect(context).toContain('jeffrey: The queue order is the priority.');
    expect(context).toContain('claude: Preserve yesterday’s order unless context changes.');
    expect(context).not.toContain('codex: ');
  });

  it('archives, restores, and forks conversations with their thread and task link', () => {
    const task = repository.create({ title: 'Conversation task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Original thread', task.id);
    repository.createSharedMessage('jeffrey', 'Investigate this', 'completed', conversation.id);
    repository.createSharedMessage('codex', 'Here are the findings', 'completed', conversation.id);
    const queued = repository.createSharedMessage('codex', 'Queued follow-up', 'queued', conversation.id);
    repository.createSharedMessage('system', 'Internal control-plane notice', 'completed', conversation.id);

    expect(repository.setConversationArchived(conversation.id, true)?.archivedAt).toEqual(expect.any(String));
    expect(repository.getSharedMessageById(queued.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
    expect(repository.get(task.id)).toEqual(expect.objectContaining({ archivedAt: expect.any(String), completionStatus: 'incomplete' }));
    expect(repository.listConversationPage(30, null, 'archive').conversations.map((item) => item.id)).toContain(conversation.id);
    expect(repository.listConversationPage(30, null, 'active').conversations.map((item) => item.id)).not.toContain(conversation.id);

    const fork = repository.forkConversation(conversation.id)!;
    expect(fork).toEqual(expect.objectContaining({ workItemId: task.id, forkedFromConversationId: conversation.id, archivedAt: null }));
    expect(repository.listSharedMessages(100, null, fork.id).messages.map((message) => message.body)).toEqual(['Investigate this', 'Queued follow-up']);
    expect(repository.setConversationArchived(conversation.id, false)?.archivedAt).toBeNull();
  });

  it('forks only the last user message and its reply, dropping earlier turns', () => {
    const conversation = repository.createConversation('Original thread', null);
    repository.createSharedMessage('jeffrey', 'First question', 'completed', conversation.id);
    repository.createSharedMessage('codex', 'First answer', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', 'Second question', 'completed', conversation.id);
    repository.createSharedMessage('codex', 'First parallel answer', 'completed', conversation.id);
    repository.createSharedMessage('claude', 'Second answer', 'completed', conversation.id);
    repository.createSharedMessage('system', 'Conversation metadata', 'completed', conversation.id);

    const fork = repository.forkConversation(conversation.id)!;
    expect(repository.listSharedMessages(100, null, fork.id).messages.map((message) => message.body)).toEqual(['Second question', 'Second answer']);
  });

  it('ignores preview promotion messages when choosing the exchange to fork', () => {
    const conversation = repository.createConversation('Promoted thread');
    repository.createSharedMessage('jeffrey', 'First question', 'completed', conversation.id);
    repository.createSharedMessage('codex', 'First answer', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', 'Latest real question', 'completed', conversation.id);
    repository.createSharedMessage('claude', 'Latest real answer', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', 'promote preview', 'completed', conversation.id);
    repository.createSharedMessage('system', 'Promotion queued.', 'queued', conversation.id, [], 'promotion');

    const fork = repository.forkConversation(conversation.id)!;
    expect(repository.listSharedMessages(100, null, fork.id).messages.map((message) => message.body)).toEqual(['Latest real question', 'Latest real answer']);
  });

  it('does not create a partial fork when the latest user message has no assistant reply', () => {
    const conversation = repository.createConversation('Unanswered thread');
    repository.createSharedMessage('jeffrey', 'Answered question', 'completed', conversation.id);
    repository.createSharedMessage('codex', 'Answered response', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', 'Still waiting', 'completed', conversation.id);

    expect(() => repository.forkConversation(conversation.id)).toThrow('A conversation needs a user message and assistant reply before it can be forked.');
    expect(repository.listConversations('all').some((item) => item.forkedFromConversationId === conversation.id)).toBe(false);
  });

  it('unlinks the source conversation from its task when it is forked', () => {
    const task = repository.create({ title: 'Forked task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Original thread', task.id);
    repository.createSharedMessage('jeffrey', 'Please fork this.', 'completed', conversation.id);
    repository.createSharedMessage('codex', 'Working on it.', 'completed', conversation.id);

    const fork = repository.forkConversation(conversation.id)!;
    expect(fork.workItemId).toBe(task.id);
    expect(repository.getConversation(conversation.id)?.workItemId).toBeNull();
    expect(repository.listActivity(task.id).some((activity) => activity.kind === 'conversation_unlinked')).toBe(true);
  });

  it('links and unlinks an existing conversation from a task', () => {
    const task = repository.create({ title: 'Link target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Manual thread');
    const reply = repository.createSharedMessage('codex', 'The implementation is complete.', 'completed', conversation.id);

    repository.setConversationClaudeSessionId(conversation.id, 'claude-before-link');
    repository.setConversationCodexThreadId(conversation.id, 'codex-before-link');
    expect(repository.setConversationWorkItem(conversation.id, task.id)).toEqual(expect.objectContaining({ workItemId: task.id, claudeSessionId: null, codexThreadId: null }));
    expect(repository.listRuns(task.id)).toEqual([expect.objectContaining({ agent: 'codex', messageId: reply.id, conversationId: conversation.id, output: reply.body, status: 'completed' })]);
    expect(repository.listActivity(task.id).some((entry) => entry.kind === 'conversation_linked')).toBe(true);
    repository.setConversationClaudeSessionId(conversation.id, 'claude-before-unlink');
    repository.setConversationCodexThreadId(conversation.id, 'codex-before-unlink');
    expect(repository.setConversationWorkItem(conversation.id, null)).toEqual(expect.objectContaining({ workItemId: null, claudeSessionId: null, codexThreadId: null }));
    expect(repository.listRuns(task.id)).toEqual([]);
    expect(repository.listActivity(task.id).some((entry) => entry.kind === 'conversation_unlinked')).toBe(true);
  });

  it('adds conversation attachments to the linked task files without duplicating their saved path', () => {
    const task = repository.create({ title: 'Attachment target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Attachment thread', task.id);
    const attachment = { name: 'requirements.pdf', path: '/tmp/requirements.pdf', mimeType: 'application/pdf', size: 42 };

    repository.createSharedMessage('jeffrey', 'Please use this file.', 'completed', conversation.id, [attachment]);
    repository.createSharedMessage('jeffrey', 'Same file for reference.', 'completed', conversation.id, [attachment]);

    expect(repository.get(task.id)?.attachments).toEqual([attachment]);
    expect(repository.listActivity(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attachment_added', body: 'Added 1 conversation attachment to task files.' }),
    ]));
  });

  it('backfills existing conversation attachments when a task is linked later', () => {
    const task = repository.create({ title: 'Late attachment target', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Previously unlinked thread');
    const attachment = { name: 'mockup.png', path: '/tmp/mockup.png', mimeType: 'image/png', size: 84 };
    repository.createSharedMessage('jeffrey', 'Attached before task linking.', 'completed', conversation.id, [attachment]);

    repository.setConversationWorkItem(conversation.id, task.id);

    expect(repository.get(task.id)?.attachments).toEqual([attachment]);
  });

  it('logs a model preference activity on the linked task when Jeffrey sets or clears a conversation tier', () => {
    const task = repository.create({ title: 'Model tier task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Tier thread', task.id);

    repository.setConversationExecutionProfile(conversation.id, 'deep');
    expect(repository.listActivity(task.id).some((entry) => entry.kind === 'model_preference' && entry.body.includes('deep'))).toBe(true);

    repository.setConversationExecutionProfile(conversation.id, null);
    expect(repository.listActivity(task.id).filter((entry) => entry.kind === 'model_preference')).toHaveLength(2);

    const before = repository.listActivity(task.id).length;
    repository.setConversationExecutionProfile(conversation.id, null);
    expect(repository.listActivity(task.id)).toHaveLength(before);
  });

  it('protects task-linked conversations from direct deletion and deletes them with their task', () => {
    const task = repository.create({ title: 'Owned conversation', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Task history', task.id);

    expect(repository.deleteConversation(conversation.id)).toBe(false);
    expect(repository.getConversation(conversation.id)).not.toBeNull();

    expect(repository.delete(task.id)).toBe(true);
    expect(repository.getConversation(conversation.id)).toBeNull();
  });

  it('summarizes conversation states for the navigation cards', () => {
    const working = repository.createConversation('Working thread');
    repository.createSharedMessage('codex', '', 'running', working.id);
    const failed = repository.createConversation('Failed thread');
    repository.createSharedMessage('claude', 'Stopped', 'canceled', failed.id);
    const finished = repository.createConversation('Finished thread');
    repository.createSharedMessage('codex', 'Done', 'completed', finished.id);
    const task = repository.create({ title: 'Approval task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const approval = repository.createConversation('Approval thread', task.id);
    repository.createSharedMessage('claude', 'Plan ready', 'completed', approval.id);
    repository.createExecutionPlan(task.id, 'Choose follow-ups.', [{ title: 'Follow-up', description: 'Do it.', workspacePath: null }]);

    const states = new Map(repository.listConversations().map((conversation) => [conversation.id, conversation.state]));
    expect(states.get(working.id)).toBe('working');
    expect(states.get(failed.id)).toBe('canceled');
    expect(states.get(finished.id)).toBe('finished');
    expect(states.get(approval.id)).toBe('waiting_approval');
    expect(repository.countAttentionConversations()).toBe(1);
    expect(repository.countUnreadConversations()).toBe(4);
    repository.markConversationRead(finished.id);
    expect(repository.countUnreadConversations()).toBe(3);
  });

  it('turns only selected execution-plan items into ordered queue tasks', () => {
    const parent = repository.create({ title: 'Large migration', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: '/tmp/project', dueDate: null });
    const plan = repository.createExecutionPlan(parent.id, 'Split the migration safely.', [
      { title: 'Inventory usage', description: 'Find every call site and record evidence.', workspacePath: null },
      { title: 'Implement migration', description: 'Change the implementation and verify tests.', workspacePath: null },
    ]);
    repository.resolveExecutionPlan(plan.id, 'accepted', [1]);

    expect(repository.get(parent.id)).toEqual(expect.objectContaining({ status: 'ready', archivedAt: null, completionStatus: 'incomplete' }));
    expect(repository.listArchived().map((item) => item.id)).not.toContain(parent.id);
    expect(repository.listWorkbench().map((item) => item.title)).toEqual(['Large migration', 'Implement migration']);
    expect(repository.listWorkbench()[1].workspacePath).toBe('/tmp/project');
    expect(repository.listWorkbench()[1].parentWorkItemId).toBe(parent.id);

    const archivalParent = repository.create({ title: 'Archive after split', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const archivalPlan = repository.createExecutionPlan(archivalParent.id, 'Archive deliberately.', [{ title: 'Child', description: 'Continue.', workspacePath: null }]);
    repository.resolveExecutionPlan(archivalPlan.id, 'accepted', undefined, true);
    expect(repository.get(archivalParent.id)?.archivedAt).toEqual(expect.any(String));
  });

  it('preserves relative order when daily context does not justify a move', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.buildDailyProposal();
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('moves ready work ahead of backlog work instead of tying nearly every task at zero', () => {
    const ready = repository.create({ title: 'Ready to execute', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const backlog = repository.create({ title: 'Still vague', description: '', priority: 2, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });

    const proposal = repository.buildDailyProposal();

    expect(proposal.previousOrder).toEqual([backlog.id, ready.id]);
    expect(proposal.proposedOrder).toEqual([ready.id, backlog.id]);
    expect(proposal.rationale).toContain('ready');
  });

  it('includes saved classifications in queue items', () => {
    const item = repository.create({ title: 'Implement the card', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(item.id, { kind: 'execute', agent: 'codex', complex: false, instructions: 'Implement it.' });

    expect(repository.list()[0]).toEqual(expect.objectContaining({ classificationKind: 'execute', classificationComplex: false }));
  });

  it('never clears a manually selected classification when task copy changes', () => {
    const item = repository.create({ title: 'Implement the card', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(item.id, { kind: 'review', agent: 'codex', complex: false, instructions: 'Review it.' }, 'manual');

    repository.update(item.id, { title: 'Implement and review the card', description: 'Updated details.' });

    expect(repository.getClassification(item.id)).toEqual(expect.objectContaining({ kind: 'review', source: 'manual' }));
  });

  it('clears an automatic classification when task copy changes', () => {
    const item = repository.create({ title: 'Investigate the card', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(item.id, { kind: 'research', agent: 'claude', complex: false, instructions: 'Research it.' });

    repository.update(item.id, { title: 'Implement the card' });

    expect(repository.getClassification(item.id)).toBeNull();
  });

  it('invalidates stale automatic classifications without invalidating manual choices', () => {
    const automatic = repository.create({ title: 'Publish the artifact', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const manual = repository.create({ title: 'Research the artifact', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.setClassification(automatic.id, { kind: 'research', agent: 'claude', complex: false, instructions: 'Research it.' });
    repository.setClassification(manual.id, { kind: 'research', agent: 'claude', complex: false, instructions: 'Research it.' }, 'manual');
    database.prepare('UPDATE work_item_classifications SET classifier_version = 1').run();

    expect(repository.getClassification(automatic.id)).toBeNull();
    expect(repository.getClassification(manual.id)).toEqual(expect.objectContaining({ kind: 'research', source: 'manual' }));
  });

  it('does not misrepresent a generic chat run as a saved task classification', () => {
    const item = repository.create({ title: 'Legacy executed task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(item.id, 'research', 'auto', 'claude', 'Investigate it.');

    expect(repository.list()[0]).toEqual(expect.objectContaining({ classificationKind: null, classificationComplex: false }));
  });

  it('promotes tasks that have gone untouched for several days without resetting their age during reorder', () => {
    const old = repository.create({ title: 'Stale follow-up', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const recent = repository.create({ title: 'Recent task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(tenDaysAgo, old.id);

    const proposal = repository.buildDailyProposal();

    expect(proposal.rationale).toContain('10 days without activity');
    expect(repository.list().map((item) => item.id)).toEqual([recent.id, old.id]);
    repository.resolveProposal(proposal.id, 'accepted');
    expect(repository.list().map((item) => item.id)).toEqual([old.id, recent.id]);
    expect(repository.get(old.id)?.lastTouchedAt).toBe(tenDaysAgo);
    expect(repository.getPendingProposal()?.id).toBeUndefined();
  });

  it('records every ordering change and undoes them one step at a time', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const third = repository.create({ title: 'Third', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    expect(repository.list().map((item) => item.id)).toEqual([third.id, second.id, first.id]);

    repository.move(first.id, { beforeId: third.id });
    expect(repository.list().map((item) => item.id)).toEqual([first.id, third.id, second.id]);
    repository.move(second.id, { beforeId: first.id });
    expect(repository.list().map((item) => item.id)).toEqual([second.id, first.id, third.id]);

    expect(repository.listQueueHistory().map((change) => change.actor)).toEqual(['jeffrey', 'jeffrey']);
    expect(repository.listQueueHistory()[0].reason).toContain('Second');

    expect(repository.undoLastQueueChange()?.items.map((item) => item.id)).toEqual([first.id, third.id, second.id]);
    expect(repository.undoLastQueueChange()?.items.map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    expect(repository.undoLastQueueChange()).toBeNull();
  });

  it('skips ordering snapshots that no longer describe the stack instead of resurrecting tasks', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.move(first.id, { beforeId: second.id });
    repository.update(second.id, { status: 'done' });

    expect(repository.undoLastQueueChange()).toBeNull();
    expect(repository.list().map((item) => item.id)).toEqual([first.id]);
  });

  it('journals neither a no-op reorder nor the reseating that follows creating a task', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.reorder([second.id, first.id]);

    expect(repository.listQueueHistory()).toHaveLength(0);
    expect(repository.undoLastQueueChange()).toBeNull();
  });

  it('attaches a per-task explanation to every daily proposal', () => {
    const fresh = repository.create({ title: 'Fresh', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const stale = repository.create({ title: 'Stale', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 86_400_000).toISOString(), stale.id);
    repository.reorder([fresh.id, stale.id]);

    const proposal = repository.buildDailyProposal();

    expect(proposal.proposedOrder).toEqual([stale.id, fresh.id]);
    const explanation = proposal.explanations.find((entry) => entry.itemId === stale.id)!;
    expect(explanation.signals.map((signal) => signal.key)).toEqual(['status', 'aging']);
    expect(explanation.score).toBe(10);
    expect(explanation.previousPosition).toBe(2);
    expect(explanation.proposedPosition).toBe(1);
    expect(repository.getPendingProposal()?.explanations).toHaveLength(2);
  });

  it('demotes a parent that is waiting on its own open subtasks', () => {
    const parent = repository.create({ title: 'Parent epic', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const sibling = repository.create({ title: 'Independent work', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.create({ title: 'Subtask', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null, parentWorkItemId: parent.id });
    repository.reorder([parent.id, sibling.id, ...repository.list().map((item) => item.id).filter((id) => id !== parent.id && id !== sibling.id)]);

    const plan = repository.explainQueue();

    expect(plan.orderedItemIds[plan.orderedItemIds.length - 1]).toBe(parent.id);
    expect(plan.rationale).toContain('waiting on 1 open subtask');
  });

  it('promotes a task whose provider source changed since the last plan', () => {
    const quiet = repository.create({ title: 'Quiet', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const moved = repository.create({ title: 'Source moved', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.reorder([quiet.id, moved.id]);
    repository.buildDailyProposal();
    database.prepare('UPDATE work_items SET provider_updated_at = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), moved.id);

    const plan = repository.explainQueue();

    expect(plan.orderedItemIds).toEqual([moved.id, quiet.id]);
    expect(plan.rationale).toContain('source changed since the last plan');
  });

  it('learns from resolved proposals and reports the weight it applied', () => {
    const fresh = repository.create({ title: 'Fresh', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const stale = repository.create({ title: 'Stale', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    database.prepare('UPDATE work_items SET last_touched_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 86_400_000).toISOString(), stale.id);
    repository.reorder([fresh.id, stale.id]);

    for (let round = 0; round < 3; round += 1) {
      const proposal = repository.buildDailyProposal();
      repository.resolveProposal(proposal.id, 'accepted');
      repository.reorder([fresh.id, stale.id]);
    }

    expect(repository.getQueueFeedbackWeights().get('aging')).toEqual({ weight: 1.3, accepted: 3, rejected: 0 });
    const plan = repository.explainQueue();
    expect(plan.explanations.find((entry) => entry.itemId === stale.id)?.signals.map((signal) => signal.key))
      .toEqual(['status', 'aging', 'feedback']);
  });

  it('stores source credentials without returning them in connection metadata', () => {
    repository.setSourceConnection('github', 'Work GitHub', { token: 'secret-token', query: 'org:writer' });
    expect(repository.getSourceSettings('github')).toEqual({ token: 'secret-token', query: 'org:writer' });
    expect(repository.listSourceConnections()).toEqual([expect.objectContaining({ provider: 'github', label: 'Work GitHub', connected: true })]);
    expect(JSON.stringify(repository.listSourceConnections())).not.toContain('secret-token');
    repository.removeSourceConnection('github');
    expect(repository.listSourceConnections()).toEqual([]);
  });

  it('persists rotated MCP credentials without treating a transient scan failure as expired authorization', () => {
    repository.setSourceConnection('confluence', 'Atlassian MCP · Workbench', {
      serverUrl: 'https://mcp.atlassian.com/v1/mcp/authv2',
      tokens: JSON.stringify({ access_token: 'old', refresh_token: 'old-refresh' }),
    });
    repository.updateSourceSettings('confluence', {
      serverUrl: 'https://mcp.atlassian.com/v1/mcp/authv2',
      tokens: { access_token: 'new', refresh_token: 'new-refresh' },
    });
    repository.updateSourceScan('confluence', 'Atlassian search is unavailable through the connector.');

    expect(repository.getSourceSettings('confluence')).toEqual({
      serverUrl: 'https://mcp.atlassian.com/v1/mcp/authv2',
      tokens: { access_token: 'new', refresh_token: 'new-refresh' },
    });
    expect(repository.listSourceConnections()).toEqual([
      expect.objectContaining({ provider: 'confluence', configurationState: 'connected', health: 'unavailable' }),
    ]);

    repository.markSourceReauthRequired('confluence', 'Atlassian authorization expired. Reconnect this source.');
    expect(repository.listSourceConnections()).toEqual([
      expect.objectContaining({ provider: 'confluence', configurationState: 'reauth_required' }),
    ]);
  });

  it('distinguishes incomplete archives from completed archives and preserves conversation history', () => {
    const incomplete = repository.create({ title: 'Paused work', description: 'Useful context', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const completed = repository.create({ title: 'Shipped work', description: 'Finished context', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const archivedConversation = repository.getOrCreateWorkConversation(incomplete.id, incomplete.title);
    repository.createSharedMessage('claude', 'Useful archived report', 'completed', archivedConversation.id);
    repository.archive(incomplete.id, false);
    repository.archive(completed.id, true);

    expect(repository.list()).toEqual([]);
    expect(repository.get(incomplete.id)?.completionStatus).toBe('incomplete');
    expect(repository.get(completed.id)?.completionStatus).toBe('completed');
    expect(repository.get(completed.id)?.status).toBe('done');
    expect(repository.listConversations().some((conversation) => conversation.id === archivedConversation.id)).toBe(false);
    expect(repository.listSharedMessages(100, null, archivedConversation.id).messages).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'Useful archived report' })]));
    expect(repository.listSharedMessages().messages.filter((message) => message.pinned)).toEqual([]);
    expect(repository.getSharedContext()).toContain('Useful archived report');
  });

  describe('full-text search over shared conversations and messages', () => {
    it('ranks a matching message above an unrelated one and links back to its conversation', () => {
      const conversation = repository.createConversation('Queue redesign');
      repository.createSharedMessage('jeffrey', 'We should switch the queue to bm25 ranking.', 'completed', conversation.id);
      repository.createSharedMessage('claude', 'Unrelated note about lunch.', 'completed', conversation.id);

      const results = repository.searchShared('bm25');

      expect(results).toEqual([
        expect.objectContaining({ type: 'message', conversationId: conversation.id, conversationTitle: 'Queue redesign' }),
      ]);
    });

    it('matches a conversation title as well as message bodies', () => {
      const conversation = repository.createConversation('Search feature planning');
      repository.createSharedMessage('jeffrey', 'No matching keyword here.', 'completed', conversation.id);

      const results = repository.searchShared('planning');

      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'conversation', conversationId: conversation.id, conversationTitle: 'Search feature planning' }),
      ]));
    });

    it('returns an empty array for an empty or whitespace-only query', () => {
      repository.createConversation('Some conversation');
      expect(repository.searchShared('')).toEqual([]);
      expect(repository.searchShared('   ')).toEqual([]);
    });

    it('returns an empty array when nothing matches', () => {
      repository.createConversation('Some conversation');
      expect(repository.searchShared('zzz-no-such-token')).toEqual([]);
    });

    it('does not throw on FTS5 special characters in the query', () => {
      const conversation = repository.createConversation('Special characters');
      repository.createSharedMessage('jeffrey', 'A message with "quotes" and colons.', 'completed', conversation.id);

      expect(() => repository.searchShared('"quotes" AND OR NOT * : -- ;')).not.toThrow();
    });

    it('keeps the FTS index in sync when a message is edited or a conversation is deleted', () => {
      const conversation = repository.createConversation('Editable thread');
      const message = repository.createSharedMessage('jeffrey', 'original wording', 'completed', conversation.id);
      repository.updateSharedMessage(message.id, { body: 'updated wording' });

      expect(repository.searchShared('original')).toEqual([]);
      expect(repository.searchShared('updated')).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'message', messageId: message.id }),
      ]));

      repository.deleteConversation(conversation.id);
      expect(repository.searchShared('updated')).toEqual([]);
    });
  });

  it('moves agent-owned work down and attention-ready work to the top', () => {
    const first = repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const third = repository.create({ title: 'Third', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.moveForAttention(first.id, 'bottom', 'agent started');
    expect(repository.list().map((item) => item.id)).toEqual([third.id, second.id, first.id]);
    repository.moveForAttention(first.id, 'top', 'agent finished');
    expect(repository.list().map((item) => item.id)).toEqual([first.id, third.id, second.id]);
  });

  it('balances automatic agent selection using recent and active load', () => {
    const task = repository.create({ title: 'Balanced task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createRun(task.id, 'execute', 'auto', 'codex', 'first');
    expect(repository.selectBalancedAgent('codex')).toBe('claude');
    repository.createRun(task.id, 'execute', 'auto', 'claude', 'second');
    expect(repository.selectBalancedAgent('claude')).toBe('palmyra');
    repository.createRun(task.id, 'execute', 'auto', 'palmyra', 'third');
    expect(repository.selectBalancedAgent('palmyra')).toBe('codex');
    repository.createRun(task.id, 'execute', 'codex', 'codex', 'explicit selection');
    // Explicit work still consumes capacity, even though it must not skew the historical auto split.
    expect(repository.selectBalancedAgent('claude')).toBe('claude');
  });

  it('routes an automatic shared-room turn away from an agent with an active reply', () => {
    const conversation = repository.createConversation('Balanced chat');
    repository.createSharedMessage('codex', 'Working', 'running', conversation.id);
    expect(repository.selectBalancedAgent('codex')).toBe('claude');
  });

  it('distinguishes explicit agent owners from automatic assignments', () => {
    const task = repository.create({ title: 'Owned task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.updateAutomaticAgentAssignees(task.id, ['codex']);
    expect(repository.getExplicitAgentAssignees(task.id)).toEqual([]);

    repository.update(task.id, { assignees: ['codex', 'claude'] });
    expect(repository.getExplicitAgentAssignees(task.id)).toEqual(['codex', 'claude']);
  });

  it('creates a manual follow-up immediately after its parent', () => {
    const parent = repository.create({ title: 'Parent', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    repository.create({ title: 'Existing next task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const followUp = repository.createFollowUp(parent.id, 'Follow-up', 'Carry this forward.');
    expect(followUp).toEqual(expect.objectContaining({ title: 'Follow-up', projectName: 'Connectors' }));
    expect(followUp?.parentWorkItemId).toBe(parent.id);
    expect(repository.list().map((item) => item.title)).toEqual(['Existing next task', 'Parent', 'Follow-up']);
  });

  it('lists a task graph of children, conversations, artifacts, and linked references', () => {
    const parent = repository.create({ title: 'Parent task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const followUp = repository.createFollowUp(parent.id, 'Follow-up', 'Carry this forward.');
    expect(repository.listChildren(parent.id).map((item) => item.id)).toEqual([followUp!.id]);

    const conversation = repository.createConversation('Attached thread', parent.id);
    expect(repository.listConversationsForWorkItem(parent.id).map((entry) => entry.id)).toEqual([conversation.id]);

    const linear = repository.addReference(parent.id, { type: 'linear_issue', url: 'https://linear.app/writer/issue/CON-1', title: 'CON-1' });
    const pr = repository.addReference(parent.id, { type: 'pull_request', url: 'https://github.com/org/repo/pull/9', title: '' });
    expect(pr.title).toBe('github.com');
    const references = repository.listReferences(parent.id);
    expect(references).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: linear.id, type: 'linear_issue', title: 'CON-1' }),
      expect.objectContaining({ id: pr.id, type: 'pull_request' }),
    ]));
    expect(repository.listActivity(parent.id).some((entry) => entry.kind === 'reference_added')).toBe(true);

    expect(repository.removeReference(parent.id, linear.id)).toBe(true);
    expect(repository.listReferences(parent.id).map((entry) => entry.id)).toEqual([pr.id]);
  });

  it('links existing tasks from either side without allowing duplicate or self links', () => {
    const first = repository.create({ title: 'First task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    repository.addTaskLink(first.id, second.id);
    repository.addTaskLink(second.id, first.id);

    expect(repository.listLinkedTasks(first.id).map((item) => item.id)).toEqual([second.id]);
    expect(repository.listLinkedTasks(second.id).map((item) => item.id)).toEqual([first.id]);
    expect(repository.listActivity(first.id).filter((entry) => entry.kind === 'task_linked')).toHaveLength(1);
    expect(() => repository.addTaskLink(first.id, first.id)).toThrow('cannot link to itself');
    expect(repository.removeTaskLink(second.id, first.id)).toBe(true);
    expect(repository.listLinkedTasks(first.id)).toEqual([]);
  });

  it('includes compact follow-up lineage in queue items', () => {
    const parent = repository.create({ title: 'Parent task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const openChild = repository.createFollowUp(parent.id, 'Open follow-up', '');
    const archivedChild = repository.createFollowUp(parent.id, 'Archived follow-up', '');
    repository.archive(archivedChild!.id, true);

    const items = repository.list();
    expect(items.find((item) => item.id === parent.id)?.lineage).toEqual({ parentTitle: null, followUpCount: 2, openFollowUpCount: 1 });
    expect(items.find((item) => item.id === openChild!.id)?.lineage).toEqual({ parentTitle: 'Parent task', followUpCount: 0, openFollowUpCount: 0 });
  });

  it('keeps children, conversations, and references reachable across archive and restore', () => {
    const parent = repository.create({ title: 'Archivable parent', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.createFollowUp(parent.id, 'Follow-up', '');
    repository.createConversation('Linked thread', parent.id);
    repository.addReference(parent.id, { type: 'document', url: 'https://example.com/doc', title: 'Doc' });

    repository.archive(parent.id, true);
    expect(repository.listChildren(parent.id)).toHaveLength(1);
    expect(repository.listConversationsForWorkItem(parent.id)).toHaveLength(1);
    expect(repository.listConversationsForWorkItem(parent.id)[0].archivedAt).not.toBeNull();
    expect(repository.listReferences(parent.id)).toHaveLength(1);

    repository.restore(parent.id);
    expect(repository.listConversationsForWorkItem(parent.id)[0].archivedAt).toBeNull();
    expect(repository.listReferences(parent.id)).toHaveLength(1);
  });

  it('keeps messages and file references isolated by conversation', () => {
    const first = repository.createConversation('First thread');
    const second = repository.createConversation('Second thread');
    repository.createSharedMessage('jeffrey', 'Review this file', 'completed', first.id, [{ name: 'App.tsx', path: '/tmp/App.tsx', mimeType: 'text/plain', size: 42 }]);
    repository.createSharedMessage('jeffrey', 'Separate context', 'completed', second.id);
    expect(repository.listSharedMessages(100, null, first.id).messages).toEqual([expect.objectContaining({ body: 'Review this file', attachments: [expect.objectContaining({ name: 'App.tsx' })] })]);
    expect(repository.listSharedMessages(100, null, second.id).messages).toHaveLength(1);
  });

  it('paginates shared messages in stable chronological order beyond the old 100-message cap', () => {
    const conversation = repository.createConversation('Long thread');
    const created = Array.from({ length: 5 }, (_, index) => repository.createSharedMessage('jeffrey', `message ${index}`, 'completed', conversation.id));

    const firstPage = repository.listSharedMessages(2, null, conversation.id);
    expect(firstPage.messages.map((message) => message.body)).toEqual(['message 3', 'message 4']);
    expect(firstPage.totalCount).toBe(5);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = repository.listSharedMessages(2, firstPage.nextCursor, conversation.id);
    expect(secondPage.messages.map((message) => message.body)).toEqual(['message 1', 'message 2']);
    expect(secondPage.nextCursor).toBeTruthy();

    const thirdPage = repository.listSharedMessages(2, secondPage.nextCursor, conversation.id);
    expect(thirdPage.messages.map((message) => message.body)).toEqual(['message 0']);
    expect(thirdPage.nextCursor).toBeNull();

    expect(repository.listAllSharedMessages(conversation.id).map((message) => message.id)).toEqual(created.map((message) => message.id));
    expect(() => repository.listSharedMessages(2, 'not-a-real-cursor', conversation.id)).toThrow('Invalid message cursor.');
  });

  it('persists queued chat turns with their requested agent target', () => {
    const conversation = repository.createConversation('Queued thread');
    const message = repository.createSharedMessage('jeffrey', 'Do this next', 'queued', conversation.id, [], 'both');
    expect(repository.nextQueuedSharedTurn(conversation.id)).toEqual({ message, dispatchTarget: 'both' });
    repository.updateSharedMessage(message.id, { status: 'completed' });
    expect(repository.nextQueuedSharedTurn(conversation.id)).toBeNull();
  });

  it('queues Palmyra as a provider and serializes its replies', () => {
    const conversation = repository.createConversation('Palmyra thread');
    const message = repository.createSharedMessage('jeffrey', 'Answer with Palmyra', 'queued', conversation.id, [], 'palmyra');

    expect(repository.nextQueuedSharedTurn(conversation.id)).toEqual({ message, dispatchTarget: 'palmyra' });
    expect(repository.nextQueuedSharedTurn(conversation.id, new Set(['palmyra']))).toBeNull();
  });

  it('synthesizes the exact dual-dispatch group after both replies reach terminal states', () => {
    const conversation = repository.createConversation('Dual synthesis');
    const firstRequest = repository.createSharedMessage('jeffrey', 'Earlier dual request', 'completed', conversation.id, [], 'both');
    repository.createSharedMessage('codex', 'Earlier Codex answer', 'completed', conversation.id, [], 'none', null, null, firstRequest.id);
    repository.createSharedMessage('claude', 'Earlier Claude answer', 'completed', conversation.id, [], 'none', null, null, firstRequest.id);
    const request = repository.createSharedMessage('jeffrey', 'Current dual request', 'completed', conversation.id, [], 'both');
    const codex = repository.createSharedMessage('codex', 'Current Codex answer', 'completed', conversation.id, [], 'none', null, null, request.id);
    const claude = repository.createSharedMessage('claude', '', 'failed', conversation.id, [], 'none', null, null, request.id);
    repository.updateSharedMessage(claude.id, { error: 'Claude unavailable.' });

    const source = synthesisSource(repository, conversation.id, codex.id);

    expect(source?.prompt).toContain('Current dual request');
    expect(source?.prompt).toContain('Current Codex answer');
    expect(source?.prompt).toContain('Claude unavailable.');
    expect(source?.prompt).not.toContain('Earlier Codex answer');
  });

  it('does not run ambient retrieval before concurrent Codex and Claude replies', async () => {
    const task = repository.create({ title: 'Connectors retrieval', description: '', priority: 1, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Concurrent retrieval', task.id);
    repository.createSharedMessage('jeffrey', 'The durable fact has several relevant details.', 'completed', conversation.id);
    repository.createSharedMessage('jeffrey', 'Continue the durable fact investigation.', 'queued', conversation.id, [], 'both');
    const retrieval = vi.spyOn(repository, 'searchActivityMemory');
    const previousPath = process.env.PATH;
    const { directory, log } = fakeAgentDirectory("printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'", "printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'");
    try {
      const replies = dispatchNextSharedTurn(repository, conversation.id);
      expect(replies).toHaveLength(2);
      const deadline = Date.now() + 2_000;
      while (repository.listAllSharedMessages(conversation.id).some((message) => message.status === 'running')) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for concurrent replies.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(retrieval).not.toHaveBeenCalled();
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(expect.arrayContaining(['claude', 'codex']));
      expect(replies.map((reply) => repository.getRetrievedMemoryDetail(reply.id))).toEqual([null, null]);
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('binds a short referential question to its own run instead of the previous objective', async () => {
    const task = repository.create({ title: 'Review connector PR', description: '', priority: 1, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Connector PR review', task.id);
    const earlier = repository.createSharedMessage('jeffrey', 'can we fix these icons, ugh they look inconsistent', 'completed', conversation.id, [], 'codex');
    repository.setSharedTurnGrounding(earlier.id, conversation.id, JSON.stringify({
      objective: 'Fix the inconsistent connector icons.',
      acceptanceCriteria: [],
      exclusions: [],
      continuation: false,
      source: 'haiku',
    }));
    repository.createSharedMessage('codex', 'I fixed the connector icons.', 'completed', conversation.id, [], 'none', null, null, earlier.id);
    const question = repository.createSharedMessage('jeffrey', 'is this PR worth stacking?', 'queued', conversation.id, [], 'codex');
    const previousPath = process.env.PATH;
    const { directory } = fakeAgentDirectory("printf '%s\\n' '{\"type\":\"result\",\"result\":\"Yes, stack it.\"}'", "printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'");
    try {
      const [reply] = dispatchNextSharedTurn(repository, conversation.id);
      expect(reply.dispatchGroupId).toBe(question.id);
      expect(repository.getRunByMessage(reply.id)?.instructions).toBe('is this PR worth stacking?');
      expect(JSON.parse(repository.getSharedTurnGrounding(question.id) ?? '{}')).toEqual(expect.objectContaining({
        objective: 'is this PR worth stacking?',
        continuation: false,
      }));
      const deadline = Date.now() + 2_000;
      while (repository.listAllSharedMessages(conversation.id).some((message) => message.status === 'running')) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for reply.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a pinned task pinned when a queued turn dispatches', async () => {
    const task = repository.create({ title: 'Pinned task', description: '', priority: 1, status: 'pinned', projectName: null, workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Pinned thread', task.id);
    repository.createSharedMessage('jeffrey', 'Keep going', 'queued', conversation.id, [], 'claude');
    const previousPath = process.env.PATH;
    const { directory } = fakeAgentDirectory("printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'", "printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'");
    try {
      const replies = dispatchNextSharedTurn(repository, conversation.id);
      const deadline = Date.now() + 2_000;
      while (repository.listAllSharedMessages(conversation.id).some((message) => message.status === 'running')) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for reply.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(replies.length).toBeGreaterThan(0);
      expect(repository.get(task.id)?.status).toBe('pinned');
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists the classified execution type onto a reply in a standalone conversation', async () => {
    const conversation = repository.createConversation('Unlinked thread');
    repository.createSharedMessage('jeffrey', 'Build the pool warming.', 'queued', conversation.id, [], 'claude');
    const previousPath = process.env.PATH;
    const { directory } = fakeAgentDirectory("printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'", "printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'");
    try {
      const replies = dispatchNextSharedTurn(repository, conversation.id);
      expect(replies).toHaveLength(1);
      // Set at creation time, before the run resolves, so a queued reply
      // already carries the routing decision it was dispatched under.
      expect(replies[0].kind).toBe('execute');
      const deadline = Date.now() + 2_000;
      while (repository.listAllSharedMessages(conversation.id).some((message) => message.status === 'running')) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for reply.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(repository.getSharedMessageById(replies[0].id)?.kind).toBe('execute');
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses a manually selected execution type before dispatching a standalone reply', async () => {
    const conversation = repository.createConversation('New standalone thread');
    repository.createSharedMessage('jeffrey', 'Explain the implementation.', 'queued', conversation.id, [], 'claude', null, null, null, 'review');
    const previousPath = process.env.PATH;
    const { directory } = fakeAgentDirectory("printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'", "printf '%s\\n' '{\"type\":\"result\",\"result\":\"Done\"}'");
    try {
      const replies = dispatchNextSharedTurn(repository, conversation.id);
      expect(replies).toHaveLength(1);
      expect(replies[0].kind).toBe('review');
      const deadline = Date.now() + 2_000;
      while (repository.listAllSharedMessages(conversation.id).some((message) => message.status === 'running')) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for reply.');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not dispatch or cancel a queued turn while the same agent is active', () => {
    const conversation = repository.createConversation('Busy thread');
    const running = repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const queued = repository.createSharedMessage('jeffrey', 'Do this afterward', 'queued', conversation.id, [], 'codex');

    expect(dispatchNextSharedTurn(repository, conversation.id)).toEqual([]);
    expect(repository.listSharedMessages(100, null, conversation.id).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running.id, status: 'running' }),
      expect.objectContaining({ id: queued.id, status: 'queued' }),
    ]));
  });

  it('makes a turn addressed to a different agent eligible while another agent is busy', () => {
    const conversation = repository.createConversation('Busy thread, different target');
    repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const queued = repository.createSharedMessage('jeffrey', 'Claude, take this', 'queued', conversation.id, [], 'claude');

    expect(repository.nextQueuedSharedTurn(conversation.id, new Set(['codex']))).toEqual({ message: queued, dispatchTarget: 'claude' });
    expect(repository.nextQueuedSharedTurn(conversation.id, new Set(['codex', 'claude']))).toBeNull();
  });

  it('promotes a queued turn ahead of earlier-queued turns in the same conversation', () => {
    const conversation = repository.createConversation('Queue jump');
    repository.createSharedMessage('jeffrey', 'First in line', 'queued', conversation.id, [], 'claude');
    const second = repository.createSharedMessage('jeffrey', 'Second in line', 'queued', conversation.id, [], 'claude');
    expect(repository.promoteQueuedSharedMessage(second.id)).toEqual(expect.objectContaining({ id: second.id }));
    expect(repository.nextQueuedSharedTurn(conversation.id)).toEqual(expect.objectContaining({ message: expect.objectContaining({ id: second.id }) }));
  });

  it('never starts a parallel turn when no active session can accept an interjection', async () => {
    const conversation = repository.createConversation('Non-destructive steering');
    const running = repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const earlier = repository.createSharedMessage('jeffrey', 'Do this afterward', 'queued', conversation.id, [], 'codex');
    const interjected = repository.createSharedMessage('jeffrey', 'Do this next', 'queued', conversation.id, [], 'codex');
    const replies = await interjectQueuedSharedMessage(repository, interjected.id, async () => ({ granted: false, operation: null }));
    expect(replies).not.toBeNull();
    if (!replies) throw new Error('Interjection was not dispatched.');
    expect(replies).toEqual([]);
      expect(repository.getSharedMessageById(running.id)).toEqual(expect.objectContaining({ status: 'running' }));
      expect(repository.getSharedMessageById(interjected.id)).toEqual(expect.objectContaining({
        status: 'queued',
        queuePriority: expect.any(Number),
      }));
      expect(repository.getSharedMessageById(earlier.id)).toEqual(expect.objectContaining({ status: 'queued' }));
  });

  it('delivers an acknowledged interjection to the existing reply without creating or canceling a reply', async () => {
    const conversation = repository.createConversation('Live steering');
    const running = repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const interjected = repository.createSharedMessage('jeffrey', 'Use this direction', 'queued', conversation.id, [], 'codex');
    let delivered = '';
    registerActiveReplySteering(running.id, async (body) => {
      delivered = body;
      return true;
    });

    await expect(interjectQueuedSharedMessage(repository, interjected.id, async () => ({ granted: false, operation: null }))).resolves.toEqual([expect.objectContaining({ id: running.id })]);
    expect(delivered).toContain('Use this direction');
    expect(delivered).toContain('External-action guardrail');
    expect(repository.getSharedMessageById(running.id)).toEqual(expect.objectContaining({ status: 'running' }));
    expect(repository.getSharedMessageById(interjected.id)).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(repository.getSharedMessageById(interjected.id)?.interjectionStreamOffset).toBe(1);
    expect(repository.listAllSharedMessages(conversation.id)).toHaveLength(2);
  });

  it('automatically delivers an explicitly interjected message once Codex becomes steering-ready', async () => {
    const conversation = repository.createConversation('Steering startup race');
    const running = repository.createSharedMessage('codex', 'Starting…', 'running', conversation.id);
    const interjected = repository.createSharedMessage('jeffrey', 'Stop exploring and implement it.', 'queued', conversation.id, [], 'codex');

    // The click happens before app-server has returned the turn id.
    const denyExternalAction = async () => ({ granted: false as const, operation: null });
    await expect(interjectQueuedSharedMessage(repository, interjected.id, denyExternalAction)).resolves.toEqual([]);
    expect(repository.getSharedMessageById(interjected.id)).toEqual(expect.objectContaining({ status: 'queued', queuePriority: 1 }));

    let delivered = '';
    registerActiveReplySteering(running.id, async (body) => {
      delivered = body;
      return true;
    });
    await deliverPendingSharedInterjections(repository, running.id, denyExternalAction);

    expect(delivered).toContain('Stop exploring and implement it.');
    expect(delivered).toContain('External-action guardrail');
    expect(repository.getSharedMessageById(running.id)).toEqual(expect.objectContaining({ status: 'running' }));
    expect(repository.getSharedMessageById(interjected.id)).toEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('can interject an auto-routed message into the active Codex session', async () => {
    const conversation = repository.createConversation('Auto steering');
    const running = repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const interjected = repository.createSharedMessage('jeffrey', 'Focus on the repro.', 'queued', conversation.id, [], 'auto');
    registerActiveReplySteering(running.id, async () => true);

    await expect(interjectQueuedSharedMessage(repository, interjected.id, async () => ({ granted: false, operation: null }))).resolves.toEqual([expect.objectContaining({ id: running.id })]);
    expect(repository.getSharedMessageById(interjected.id)).toEqual(expect.objectContaining({ status: 'completed' }));
  });

  it('makes a live interjection an explicit immediate instruction while preserving its text', () => {
    expect(interjectionSteeringPrompt('INTERJECTION!')).toContain('Acknowledge and apply this direction immediately');
    expect(interjectionSteeringPrompt('INTERJECTION!')).toContain('INTERJECTION!');
  });

  it('does not redispatch an accepted interjection when the active reply finishes during acknowledgment', async () => {
    const conversation = repository.createConversation('Steer acknowledgment race');
    const running = repository.createSharedMessage('codex', 'Still working', 'running', conversation.id);
    const interjected = repository.createSharedMessage('jeffrey', 'Redirect this', 'queued', conversation.id, [], 'codex');
    registerActiveReplySteering(running.id, async () => {
      repository.updateSharedMessage(running.id, { status: 'canceled' });
      return true;
    });

    await expect(interjectQueuedSharedMessage(repository, interjected.id, async () => ({ granted: false, operation: null }))).resolves.toEqual([expect.objectContaining({ id: running.id })]);
    expect(repository.getSharedMessageById(interjected.id)).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(repository.listAllSharedMessages(conversation.id)).toHaveLength(2);
  });

  it('releases a rejected interjection to one normal follow-up turn after the active reply ends', async () => {
    const conversation = repository.createConversation('Rejected steering race');
    const running = repository.createSharedMessage('claude', 'Still working', 'running', conversation.id);
    const interjected = repository.createSharedMessage('jeffrey', 'Report now', 'queued', conversation.id, [], 'claude');
    registerActiveReplySteering(running.id, async () => {
      repository.updateSharedMessage(running.id, { status: 'completed' });
      return false;
    });

    await expect(interjectQueuedSharedMessage(repository, interjected.id, async () => ({ granted: false, operation: null }))).resolves.toEqual([]);
    expect(repository.getSharedMessageById(interjected.id)).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(repository.listAllSharedMessages(conversation.id).filter((message) => message.author === 'claude')).toHaveLength(2);
  });

  it('does not promote a message that is not queued', () => {
    const conversation = repository.createConversation('Not queued');
    const completed = repository.createSharedMessage('jeffrey', 'Already answered', 'completed', conversation.id);
    expect(repository.promoteQueuedSharedMessage(completed.id)).toBeNull();
  });

  it('cancels a queued message before it dispatches, without touching a running reply', () => {
    const conversation = repository.createConversation('Cancel queued');
    const queued = repository.createSharedMessage('jeffrey', 'Never mind', 'queued', conversation.id, [], 'claude');
    const canceled = cancelSharedReply(repository, queued.id);
    expect(canceled).toEqual(expect.objectContaining({ id: queued.id, status: 'canceled' }));
    expect(repository.nextQueuedSharedTurn(conversation.id)).toBeNull();
  });

  it('durably cancels the task run linked to a canceled chat reply', () => {
    const task = repository.create({ title: 'Fix cancellation', description: '', priority: 2, status: 'in_progress', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(task.id, task.title);
    const reply = repository.createSharedMessage('claude', 'Working', 'running', conversation.id);
    const run = repository.createRun(task.id, 'execute', 'claude', 'claude', 'Fix it', conversation.id, reply.id);
    repository.updateRun(run.id, { status: 'running' });

    cancelSharedReply(repository, reply.id);

    expect(repository.getRun(run.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
    expect(repository.isCancellationRequested(run.id)).toBe(true);
    expect(repository.listSharedMessages(100, null, conversation.id).messages.find((message) => message.id === reply.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
  });

  it('directly stops the provider process when canceling a live reply', () => {
    const conversation = repository.createConversation('Cancel wedged provider');
    const reply = repository.createSharedMessage('claude', 'Still working', 'running', conversation.id);
    const steer = Object.assign(async () => true, { cancel: vi.fn() });
    registerActiveReplySteering(reply.id, steer);

    cancelSharedReply(repository, reply.id);

    expect(steer.cancel).toHaveBeenCalledOnce();
    expect(repository.getSharedMessageById(reply.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
  });

  it('aborts the local stream as well as the durable run for a task-linked reply', async () => {
    const task = repository.create({ title: 'Stop the active reply', description: '', priority: 2, status: 'in_progress', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(task.id, task.title);
    const reply = repository.createSharedMessage('claude', 'Working', 'running', conversation.id);
    const run = repository.createRun(task.id, 'analysis', 'claude', 'claude', 'Keep working', conversation.id, reply.id);
    repository.updateRun(run.id, { status: 'running' });
    let aborted = false;
    const streaming = runSharedBackgroundJob(repository, reply.id, (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('canceled')); }, { once: true });
    }));

    expect(isSharedReplyActive(reply.id)).toBe(true);
    cancelSharedReply(repository, reply.id);
    await streaming;

    expect(aborted).toBe(true);
    expect(repository.getRun(run.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
    expect(repository.getSharedMessageById(reply.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
  });

  it('aborts the owning provider when another runtime durably cancels its reply', async () => {
    vi.useFakeTimers();
    try {
      const conversation = repository.createConversation('Cross-runtime cancellation');
      const reply = repository.createSharedMessage('claude', 'Still working', 'running', conversation.id);
      let aborted = false;
      const streaming = runSharedBackgroundJob(repository, reply.id, (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('canceled by another runtime'));
        }, { once: true });
      }));

      repository.updateSharedMessage(reply.id, { status: 'canceled' });
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await streaming;

      expect(aborted).toBe(true);
      expect(repository.getSharedMessageById(reply.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a legacy chat run that predates durable reply linkage', () => {
    const task = repository.create({ title: 'Fix legacy cancellation', description: '', priority: 2, status: 'in_progress', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.getOrCreateWorkConversation(task.id, task.title);
    const reply = repository.createSharedMessage('claude', 'Working', 'running', conversation.id);
    const run = repository.createRun(task.id, 'analysis', 'claude', 'claude', 'Continue', conversation.id);
    repository.updateRun(run.id, { status: 'running' });

    cancelSharedReply(repository, reply.id);

    expect(repository.getRun(run.id)).toEqual(expect.objectContaining({ status: 'canceled' }));
  });

  it('paginates conversations in stable updated order', () => {
    repository.createConversation('First');
    repository.createConversation('Second');
    repository.createConversation('Third');
    const firstPage = repository.listConversationPage(2, null);
    expect(firstPage.conversations).toHaveLength(2);
    expect(firstPage.totalCount).toBe(3);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = repository.listConversationPage(2, firstPage.nextCursor);
    expect(secondPage.conversations).toHaveLength(1);
    expect(new Set([...firstPage.conversations, ...secondPage.conversations].map((conversation) => conversation.title))).toEqual(new Set(['First', 'Second', 'Third']));
    expect(secondPage.nextCursor).toBeNull();
  });

  it('puts queued and running conversations ahead of more recently updated idle conversations', () => {
    const working = repository.createConversation('Working first');
    repository.createSharedMessage('claude', 'On it.', 'queued', working.id);
    const idle = repository.createConversation('Recent idle');

    expect(repository.listConversationPage(30, null).conversations.map((conversation) => conversation.id)).toEqual([working.id, idle.id]);
  });

  it('surfaces and prioritizes the existing pinned linked-task state in conversation stacks', () => {
    const pinnedTask = repository.create({ title: 'Pinned task', description: '', priority: 2, status: 'pinned', projectName: null, workspacePath: null, dueDate: null });
    const unpinnedTask = repository.create({ title: 'Ready task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const pinnedConversation = repository.createConversation('Pinned conversation', pinnedTask.id);
    const unpinnedConversation = repository.createConversation('Ready conversation', unpinnedTask.id);

    const conversations = repository.listConversationPage(30, null).conversations;

    expect(conversations.map((conversation) => conversation.id)).toEqual([pinnedConversation.id, unpinnedConversation.id]);
    expect(conversations[0]?.linkedWorkItemPinned).toBe(true);
    expect(conversations[1]?.linkedWorkItemPinned).toBe(false);
  });

  it('reports active and archive counts independently of pagination', () => {
    repository.create({ title: 'Active', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const archived = repository.create({ title: 'Archived', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    repository.archive(archived.id, false);
    expect(repository.getWorkItemCounts()).toEqual({ active: 1, workbench: 0, archive: 1, attentionArchive: 1, workbenchArchive: 0 });
  });

  it('renders Workbench-project tasks as an ordered focus of the attention stack', () => {
    const attention = repository.create({ title: 'Customer task', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const first = repository.create({ title: 'Workbench one', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Workbench two', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.move(first.id, { beforeId: second.id });
    expect(repository.list().map((item) => item.id)).toEqual([first.id, second.id, attention.id]);
    expect(repository.listWorkbench().map((item) => item.id)).toEqual([first.id, second.id]);
    expect(repository.getWorkItemCounts()).toEqual({ active: 1, workbench: 2, archive: 0, attentionArchive: 0, workbenchArchive: 0 });
  });

  it('never surfaces Workbench-project tasks in the paginated active view', () => {
    const attention = repository.create({ title: 'Customer task', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    repository.create({ title: 'Workbench one', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const page = repository.listPage('active', 50, null, { query: '', projectNames: [], statuses: [], assignees: [], sources: [], labels: [], dueStates: [] });
    expect(page.items.map((item) => item.id)).toEqual([attention.id]);
  });

  it('keeps Workbench and attention archive filters complementary', () => {
    const attention = repository.create({ title: 'Customer archive', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const workbench = repository.create({ title: 'Workbench archive', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.archive(attention.id, false);
    repository.archive(workbench.id, true);
    const filter = { query: '', projectNames: [], statuses: [], assignees: [], sources: [], labels: [], dueStates: [] };

    expect(repository.listPage('archive', 50, null, filter).items.map((item) => item.id)).toEqual([attention.id]);
    expect(repository.listPage('workbench-archive', 50, null, filter).items.map((item) => item.id)).toEqual([workbench.id]);
  });

  it('spans active and archived tasks when searching, without crossing the Workbench project scope', () => {
    const activeAttention = repository.create({ title: 'Rename button copy', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    const archivedAttention = repository.create({ title: 'Rename input label', description: '', priority: 2, status: 'ready', projectName: 'Connectors', workspacePath: null, dueDate: null });
    repository.archive(archivedAttention.id, false);
    const activeWorkbench = repository.create({ title: 'Rename queue toggle', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const archivedWorkbench = repository.create({ title: 'Rename filter chip', description: '', priority: 2, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    repository.archive(archivedWorkbench.id, true);
    const search = { query: 'rename', projectNames: [], statuses: [], assignees: [], sources: [], labels: [], dueStates: [] };

    expect(repository.listPage('active', 50, null, search).items.map((item) => item.id).sort())
      .toEqual([activeAttention.id, archivedAttention.id].sort());
    expect(repository.listPage('archive', 50, null, search).items.map((item) => item.id).sort())
      .toEqual([activeAttention.id, archivedAttention.id].sort());
    expect(repository.listPage('workbench', 50, null, search).items.map((item) => item.id).sort())
      .toEqual([activeWorkbench.id, archivedWorkbench.id].sort());
    expect(repository.listPage('workbench-archive', 50, null, search).items.map((item) => item.id).sort())
      .toEqual([activeWorkbench.id, archivedWorkbench.id].sort());
  });

  it('deduplicates discoveries and only creates a task after approval', () => {
    const run = repository.startDiscoveryRun();
    expect(repository.upsertDiscoveryCandidate({ fingerprint: 'same', provider: 'slack', title: 'Review proposal', description: 'Jeffrey was mentioned.', sourceUrl: 'https://writer.slack.com/a', occurredAt: null, runId: run.id })).toBe(true);
    expect(repository.upsertDiscoveryCandidate({ fingerprint: 'same', provider: 'slack', title: 'Review updated proposal', description: 'New context', sourceUrl: 'https://writer.slack.com/a', occurredAt: null, runId: run.id })).toBe(false);
    repository.finishDiscoveryRun(run.id, 1, []);
    const inbox = repository.getDiscoveryInbox();
    expect(inbox.pendingCount).toBe(1);
    expect(repository.list()).toHaveLength(0);
    const resolved = repository.resolveDiscoveryCandidate(inbox.candidates[0].id, 'convert')!;
    expect(resolved.status).toBe('converted');
    expect(repository.list()).toEqual([expect.objectContaining({ title: 'Review updated proposal', sourceUrl: 'https://writer.slack.com/a' })]);
  });

  it('suggests updating an existing task when discovery resolves to the same source URL', () => {
    const existing = repository.create({ title: 'Review connector PR', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null, sourceUrl: 'https://github.com/writer/repo/pull/42' });
    const run = repository.startDiscoveryRun();
    repository.upsertDiscoveryCandidate({ fingerprint: 'pr-42', provider: 'github', title: 'Please review PR 42', description: 'New review request', sourceUrl: existing.sourceUrl, occurredAt: null, runId: run.id, relevance: 2 });

    expect(repository.getDiscoveryInbox().candidates[0]).toEqual(expect.objectContaining({ suggestedWorkItemId: existing.id, relevance: 2 }));
  });

  it('edits, merges, and bulk resolves pending discoveries', () => {
    const target = repository.create({ title: 'Existing task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const run = repository.startDiscoveryRun();
    for (const [fingerprint, title] of [['one', 'First signal'], ['two', 'Second signal'], ['three', 'Third signal']]) {
      repository.upsertDiscoveryCandidate({ fingerprint, provider: 'linear', title, description: '', sourceUrl: `https://linear.app/${fingerprint}`, occurredAt: null, runId: run.id });
    }
    const candidates = repository.getDiscoveryInbox().candidates;
    const first = candidates.find((candidate) => candidate.title === 'First signal')!;
    const second = candidates.find((candidate) => candidate.title === 'Second signal')!;
    const third = candidates.find((candidate) => candidate.title === 'Third signal')!;
    expect(repository.updateDiscoveryCandidate(first.id, { title: 'Edited signal', description: 'Useful context' })).toEqual(expect.objectContaining({ title: 'Edited signal', description: 'Useful context' }));
    expect(repository.resolveDiscoveryCandidate(second.id, 'merge', target.id)).toEqual(expect.objectContaining({ status: 'merged', workItemId: target.id }));
    expect(repository.listActivity(target.id).some((entry) => entry.body.includes('Second signal'))).toBe(true);
    expect(repository.get(target.id)?.sourceTags).toEqual(['Linear']);
    expect(repository.resolveDiscoveryCandidates([first.id, third.id], 'dismiss').map((candidate) => candidate.status)).toEqual(['dismissed', 'dismissed']);
    expect(repository.getDiscoveryInbox().pendingCount).toBe(0);
    expect(repository.getDiscoveryInbox('reviewed').reviewedCount).toBe(3);
    expect(repository.restoreDiscoveryCandidate(first.id)).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(repository.getDiscoveryInbox().candidates.map((candidate) => candidate.id)).toContain(first.id);
    expect(repository.restoreDiscoveryCandidate(second.id)).toBeNull();
  });

  it('undoes a converted discovery by restoring the card and soft-deleting its generated task', () => {
    const run = repository.startDiscoveryRun();
    repository.upsertDiscoveryCandidate({ fingerprint: 'undo-convert', provider: 'github', title: 'Undo converted discovery', description: 'Restore this card.', sourceUrl: null, occurredAt: null, runId: run.id, relevance: 1 });
    repository.upsertDiscoveryCandidate({ fingerprint: 'keep-position', provider: 'github', title: 'Keep its position', description: '', sourceUrl: null, occurredAt: null, runId: run.id, relevance: 2 });
    const initialOrder = repository.getDiscoveryInbox().candidates.map((item) => item.id);
    const candidate = repository.getDiscoveryInbox().candidates.find((item) => item.title === 'Undo converted discovery')!;
    const converted = repository.resolveDiscoveryCandidate(candidate.id, 'convert')!;

    expect(repository.restoreDiscoveryCandidate(candidate.id)).toEqual(expect.objectContaining({ status: 'pending', workItemId: null }));
    expect(repository.get(converted.workItemId!)).toBeNull();
    expect(repository.getDiscoveryInbox().candidates.map((item) => item.id)).toEqual(initialOrder);
  });

  describe('claim/retry primitives', () => {
    it('retries a failed task run in place without creating a second run or chat reply', () => {
      const item = repository.create({ title: 'Retry in place', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
      const message = repository.createSharedMessage('codex', 'Partial output', 'failed', conversation.id);
      const run = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Continue', conversation.id, message.id);
      repository.updateRun(run.id, { status: 'failed', error: 'Agent process stopped reporting progress.' });

      const retried = repository.prepareRunRetry(run.id);

      expect(retried?.id).toBe(run.id);
      expect(retried?.status).toBe('queued');
      expect(repository.listRuns(item.id)).toHaveLength(1);
      expect(repository.listAllSharedMessages(conversation.id).filter((entry) => entry.author === 'codex')).toHaveLength(1);
      expect(repository.getSharedMessageById(message.id)?.status).toBe('running');

      repository.updateRun(run.id, { status: 'completed' });
      repository.updateSharedMessage(message.id, { status: 'completed' });
      expect(repository.getRun(run.id)?.error).toBe('');
      expect(repository.getSharedMessageById(message.id)?.error).toBe('');
    });

    function createQueuedRun() {
      const item = repository.create({ title: 'Reliability task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      return repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
    }

    it('claimRun is atomic: only one of two concurrent claimants wins', () => {
      const run = createQueuedRun();
      expect(repository.claimRun(run.id, 'owner-a', 60_000)).toBe(true);
      expect(repository.claimRun(run.id, 'owner-b', 60_000)).toBe(false);
      expect(repository.getRun(run.id)?.status).toBe('running');
    });

    it('a run reclaimed after its lease expired can be claimed by a new owner', () => {
      // claimRun only matches status = 'queued': once claimed, a run is 'running' and
      // a second direct claimRun always loses, by design. An expired lease is instead
      // surfaced by reclaimExpired(), which resets status back to 'queued' so a fresh
      // claim can succeed.
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', -1); // lease already expired
      repository.reclaimExpired(0);
      expect(repository.claimRun(run.id, 'owner-b', 60_000)).toBe(true);
    });

    it('claimRun refuses a run that is not queued', () => {
      const run = createQueuedRun();
      repository.updateRun(run.id, { status: 'completed' });
      expect(repository.claimRun(run.id, 'owner-a', 60_000)).toBe(false);
    });

    it('lets only the current uncanceled owner finish a running attempt', () => {
      const run = createQueuedRun();
      expect(repository.claimRun(run.id, 'owner-a', 60_000)).toBe(true);
      expect(repository.finishRun(run.id, 'owner-b', { status: 'completed' })).toBe(false);
      expect(repository.requestRunCancellation(run.id)).toBe(true);
      expect(repository.isCancellationRequested(run.id)).toBe(true);
      expect(repository.finishRun(run.id, 'owner-a', { status: 'completed' })).toBe(false);
      expect(repository.getRun(run.id)?.status).toBe('running');
    });

    it('clears durable cancellation when a canceled run is prepared for retry', () => {
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', 60_000);
      repository.requestRunCancellation(run.id);
      repository.updateRun(run.id, { status: 'canceled', completedAt: new Date().toISOString() });

      const retried = repository.prepareRunRetry(run.id);

      expect(retried?.status).toBe('queued');
      expect(repository.isCancellationRequested(run.id)).toBe(false);
      expect(database.prepare('SELECT cancel_requested, cancel_requested_at FROM agent_runs WHERE id = ?').get(run.id)).toEqual({
        cancel_requested: 0,
        cancel_requested_at: null,
      });
      expect(repository.claimRun(run.id, 'owner-b', 60_000)).toBe(true);
      expect(repository.renewRunLease(run.id, 'owner-b', 60_000)).toBe(true);
    });

    it('scheduleRunRetry re-queues with an incremented attempt and clears ownership, up to max_attempts', () => {
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', 60_000);
      expect(repository.scheduleRunRetry(run.id, 'owner-a', 5_000)).toBe(true);
      const retried = repository.getRun(run.id)!;
      expect(retried.status).toBe('queued');
      expect(retried.attempt).toBe(1);
      expect(retried.nextAttemptAt).not.toBeNull();
      repository.claimRun(run.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(run.id, 'owner-a', 0);
      expect(repository.getRun(run.id)?.attempt).toBe(2);
      // Third retry would hit max_attempts (default 3): refuse further retry.
      repository.claimRun(run.id, 'owner-a', 60_000);
      expect(repository.scheduleRunRetry(run.id, 'owner-a', 0)).toBe(false);
    });

    it('prepareRunRetry restores the automatic retry budget so a manually retried run is still recoverable', () => {
      const run = createQueuedRun();
      // Burn the automatic budget the way transient agent errors do.
      repository.claimRun(run.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(run.id, 'owner-a', 0);
      repository.claimRun(run.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(run.id, 'owner-a', 0);
      expect(repository.getRun(run.id)?.attempt).toBe(2);
      repository.updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });

      // A deliberate human retry starts a fresh attempt, so it must not inherit
      // an exhausted budget: before this reset, `attempt` climbed past
      // max_attempts (rows reached attempt 7 and 8 against a cap of 3) and the
      // run lost every form of automatic recovery.
      const retried = repository.prepareRunRetry(run.id)!;
      expect(retried.status).toBe('queued');
      expect(retried.attempt).toBe(0);

      // Automatic recovery works again: both a transient-error retry and a lost
      // lease requeue the run instead of failing it outright.
      repository.claimRun(run.id, 'owner-b', 60_000);
      expect(repository.scheduleRunRetry(run.id, 'owner-b', 0)).toBe(true);
      repository.claimRun(run.id, 'owner-b', -1);
      expect(repository.reclaimExpired(0).recoveredRunIds).toContain(run.id);
    });

    it('reclaimExpired retries a non-execute run whose lease expired and fails an execute run instead', () => {
      const analysisRun = createQueuedRun();
      repository.claimRun(analysisRun.id, 'dead-owner', -1);
      const item = repository.create({ title: 'Filesystem edit', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const executeRun = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
      repository.claimRun(executeRun.id, 'dead-owner', -1);

      const result = repository.reclaimExpired(0);
      expect(result.recoveredRunIds).toContain(analysisRun.id);
      expect(result.failedRunIds).toContain(executeRun.id);
      expect(repository.getRun(analysisRun.id)?.status).toBe('queued');
      expect(repository.getRun(executeRun.id)?.status).toBe('failed');
      expect(repository.getRun(executeRun.id)?.error).toMatch(/stopped reporting progress/);
    });

    it('does not mark a linked chat failed while its interrupted run is being retried', () => {
      const item = repository.create({ title: 'Recover linked reply', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
      const message = repository.createSharedMessage('codex', 'Partial response', 'running', conversation.id);
      const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '', conversation.id, message.id);
      repository.claimRun(run.id, 'dead-owner', -1);
      repository.claimSharedMessage(message.id, 'dead-owner', -1);

      repository.reclaimExpired(0);

      expect(repository.getRun(run.id)?.status).toBe('queued');
      expect(repository.getSharedMessageById(message.id)?.status).toBe('running');
      expect(repository.getSharedMessageById(message.id)?.error).toBe('');
    });

    it('dueWork returns queued runs with no future next_attempt_at and excludes scheduled retries not yet due', () => {
      const dueRun = createQueuedRun();
      const notYetDueRun = createQueuedRun();
      repository.claimRun(notYetDueRun.id, 'owner-a', 60_000);
      repository.scheduleRunRetry(notYetDueRun.id, 'owner-a', 60_000); // due far in the future
      expect(repository.dueWork().runIds).toContain(dueRun.id);
      expect(repository.dueWork().runIds).not.toContain(notYetDueRun.id);
    });

    it('dueWork(limit) returns only the oldest N queued runs when the backlog exceeds the ceiling', () => {
      const runs = [createQueuedRun(), createQueuedRun(), createQueuedRun(), createQueuedRun(), createQueuedRun()];
      const due = repository.dueWork(2).runIds;
      expect(due).toHaveLength(2);
      expect(due).toEqual([runs[0].id, runs[1].id]);
    });

    it('dueWork(limit) returns nothing once the running count already meets the ceiling', () => {
      const runningA = createQueuedRun();
      const runningB = createQueuedRun();
      createQueuedRun(); // still queued, would otherwise be due
      repository.claimRun(runningA.id, 'owner-a', 60_000);
      repository.claimRun(runningB.id, 'owner-b', 60_000);

      expect(repository.dueWork(2).runIds).toEqual([]);
    });

    it('dueWork(limit) frees up capacity as running runs complete', () => {
      const runningA = createQueuedRun();
      const queuedB = createQueuedRun();
      const queuedC = createQueuedRun();
      repository.claimRun(runningA.id, 'owner-a', 60_000);

      // One slot free (ceiling 2, one running): only the oldest queued run is due.
      expect(repository.dueWork(2).runIds).toEqual([queuedB.id]);

      repository.updateRun(runningA.id, { status: 'completed' });

      // Both slots free now: both remaining queued runs are due, oldest first.
      expect(repository.dueWork(2).runIds).toEqual([queuedB.id, queuedC.id]);
    });

    it('hasLiveWork reflects queued/running rows regardless of which process created them', () => {
      expect(repository.hasLiveWork()).toBe(false);
      createQueuedRun();
      expect(repository.hasLiveWork()).toBe(true);
    });

    it('activeRunsForItem lists only queued/running runs for dedup guards', () => {
      const item = repository.create({ title: 'Dedup task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
      expect(repository.activeRunsForItem(item.id)).toHaveLength(1);
      repository.updateRun(run.id, { status: 'completed' });
      expect(repository.activeRunsForItem(item.id)).toHaveLength(0);
    });

    it('grants a workspace to one run at a time and frees it on release', () => {
      const item = repository.create({ title: 'Edit the tree', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const first = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
      const second = repository.createRun(item.id, 'execute', 'claude', 'claude', '');
      const workspace = '/Users/jeffrey.lu/dev/workbench';

      expect(repository.claimWorkspace(workspace, first.id, 'owner-1', 60_000)).toBe(true);
      expect(repository.claimWorkspace(workspace, second.id, 'owner-2', 60_000)).toBe(false);
      expect(repository.workspaceLeaseHolder(workspace)).toBe(first.id);
      // Re-claiming what you already hold is a renewal, not a conflict.
      expect(repository.claimWorkspace(workspace, first.id, 'owner-1', 60_000)).toBe(true);
      // A different tree is never blocked by this one.
      expect(repository.claimWorkspace('/Users/jeffrey.lu/dev/fe.web-app', second.id, 'owner-2', 60_000)).toBe(true);

      repository.releaseWorkspace(first.id);
      expect(repository.workspaceLeaseHolder(workspace)).toBeNull();
      expect(repository.claimWorkspace(workspace, second.id, 'owner-2', 60_000)).toBe(true);
    });

    it('hands an expired workspace lease to the next run', () => {
      const item = repository.create({ title: 'Edit the tree', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const dead = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
      const next = repository.createRun(item.id, 'execute', 'claude', 'claude', '');
      const workspace = '/Users/jeffrey.lu/dev/workbench';
      // A killed process cannot hold a workspace hostage: the lease expires.
      expect(repository.claimWorkspace(workspace, dead.id, 'owner-1', -1_000)).toBe(true);
      expect(repository.workspaceLeaseHolder(workspace)).toBeNull();
      expect(repository.claimWorkspace(workspace, next.id, 'owner-2', 60_000)).toBe(true);
    });

    it('releaseRunToQueue returns a waiting run to the queue without spending an attempt', () => {
      const item = repository.create({ title: 'Waits its turn', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const run = repository.createRun(item.id, 'execute', 'codex', 'codex', '');
      expect(repository.claimRun(run.id, 'owner-1', 60_000)).toBe(true);
      repository.updateRun(run.id, { startedAt: new Date().toISOString(), resolvedWorkspace: '/Users/jeffrey.lu/dev/workbench' });

      repository.releaseRunToQueue(run.id, 'owner-1', 5_000);

      const requeued = repository.getRun(run.id)!;
      expect(requeued.status).toBe('queued');
      expect(requeued.attempt).toBe(0);
      expect(requeued.startedAt).toBeNull();
      expect(requeued.resolvedWorkspace).toBe('/Users/jeffrey.lu/dev/workbench');
    });

    it('claimQueuedTurn promotes a queued jeffrey message exactly once', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('jeffrey', 'hi', 'queued', conversation.id);
      expect(repository.claimQueuedTurn(message.id)).toBe(true);
      expect(repository.claimQueuedTurn(message.id)).toBe(false);
      expect(repository.listSharedMessages(10, null, conversation.id).messages.find((entry) => entry.id === message.id)?.status).toBe('completed');
    });

    it('renewLeases revives a late heartbeat only while the caller still owns the work', () => {
      const run = createQueuedRun();
      repository.claimRun(run.id, 'owner-a', 1_000);
      const conversation = repository.createConversation();
      const ownedMessage = repository.createSharedMessage('claude', 'working', 'running', conversation.id);
      const otherMessage = repository.createSharedMessage('codex', 'other process', 'running', conversation.id);
      repository.claimSharedMessage(ownedMessage.id, 'owner-a', -1);
      repository.claimSharedMessage(otherMessage.id, 'owner-b', -1);
      const before = repository.getRun(run.id);
      repository.renewLeases('owner-a', 60_000);
      // Renewing does not change status; this asserts renewal does not throw and leaves status running.
      expect(repository.getRun(run.id)?.status).toBe('running');
      expect(before?.status).toBe('running');
      const reclaimed = repository.reclaimExpired(0);
      expect(reclaimed.recoveredMessageIds).not.toContain(ownedMessage.id);
      expect(reclaimed.recoveredMessageIds).toContain(otherMessage.id);
    });

    it('claimSharedMessage acquires a lease and prevents double-claim', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', '', 'running', conversation.id);
      expect(repository.claimSharedMessage(message.id, 'owner-a', 60_000)).toBe(true);
      expect(repository.listSharedMessages(10, null, conversation.id).messages.find((m) => m.id === message.id)?.status).toBe('running');
      // Second claim by a different owner fails.
      expect(repository.claimSharedMessage(message.id, 'owner-b', 60_000)).toBe(false);
    });

    it('reclaimExpired marks shared messages with expired leases as failed', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', 'partial output', 'running', conversation.id);
      // Claim with negative lease (already expired).
      repository.claimSharedMessage(message.id, 'dead-owner', -1);

      const result = repository.reclaimExpired(0);
      expect(result.recoveredMessageIds).toContain(message.id);
      const recovered = repository.listSharedMessages(10, null, conversation.id).messages.find((m) => m.id === message.id);
      expect(recovered?.status).toBe('failed');
      expect(recovered?.error).toMatch(/stopped reporting progress/);
      expect(recovered?.body).toBe('partial output'); // Partial output is preserved for inspection.
    });

    it('reclaimExpired marks an unclaimed running reply as failed after the recovery grace period', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('claude', 'partial output', 'running', conversation.id);

      const result = repository.reclaimExpired(0);

      expect(result.recoveredMessageIds).toContain(message.id);
      const recovered = repository.getSharedMessageById(message.id);
      expect(recovered?.status).toBe('failed');
      expect(recovered?.error).toMatch(/stopped reporting progress/);
      expect(recovered?.body).toBe('partial output');
    });
  });

  describe('promotion queue', () => {
    it('claimQueuedPromotionMessage is atomic: only one of two concurrent claimants wins', () => {
      const conversation = repository.createConversation();
      const promotion = repository.createSharedMessage('system', 'Promotion queued.', 'queued', conversation.id, [], 'promotion');
      expect(repository.claimQueuedPromotionMessage(promotion.id, 'owner-a', 60_000)).toBe(true);
      expect(repository.claimQueuedPromotionMessage(promotion.id, 'owner-b', 60_000)).toBe(false);
      expect(repository.getSharedMessageById(promotion.id)?.status).toBe('running');
    });

    it('refuses to claim a promotion message that is not queued, or not a promotion', () => {
      const conversation = repository.createConversation();
      const running = repository.createSharedMessage('system', 'Already running.', 'running', conversation.id, [], 'promotion');
      expect(repository.claimQueuedPromotionMessage(running.id, 'owner-a', 60_000)).toBe(false);

      const notPromotion = repository.createSharedMessage('codex', 'Not a promotion.', 'queued', conversation.id);
      expect(repository.claimQueuedPromotionMessage(notPromotion.id, 'owner-a', 60_000)).toBe(false);
    });

    it('listQueuedPromotionMessageIds returns only queued promotions, oldest first', () => {
      const conversation = repository.createConversation();
      const first = repository.createSharedMessage('system', 'First.', 'queued', conversation.id, [], 'promotion');
      const second = repository.createSharedMessage('system', 'Second.', 'queued', conversation.id, [], 'promotion');
      repository.claimQueuedPromotionMessage(first.id, 'owner-a', 60_000);
      expect(repository.listQueuedPromotionMessageIds()).toEqual([second.id]);
    });

    it('requeueExpiredPromotionMessages returns a running promotion to the queue once its lease expires', () => {
      const conversation = repository.createConversation();
      const promotion = repository.createSharedMessage('system', 'Promotion queued.', 'queued', conversation.id, [], 'promotion');
      repository.claimQueuedPromotionMessage(promotion.id, 'dead-owner', -1); // lease already expired

      expect(repository.requeueExpiredPromotionMessages()).toBe(1);
      expect(repository.getSharedMessageById(promotion.id)?.status).toBe('queued');
      expect(repository.listQueuedPromotionMessageIds()).toEqual([promotion.id]);
    });

    it('requeueExpiredPromotionMessages leaves a promotion alone while its lease is still valid', () => {
      const conversation = repository.createConversation();
      const promotion = repository.createSharedMessage('system', 'Promotion queued.', 'queued', conversation.id, [], 'promotion');
      repository.claimQueuedPromotionMessage(promotion.id, 'live-owner', 60_000);

      expect(repository.requeueExpiredPromotionMessages()).toBe(0);
      expect(repository.getSharedMessageById(promotion.id)?.status).toBe('running');
    });

    it('completeQueuedPromotionMessages folds every other queued approval into the one release that ran', () => {
      const conversation = repository.createConversation();
      const winner = repository.createSharedMessage('system', 'Promotion queued.', 'queued', conversation.id, [], 'promotion');
      const rider = repository.createSharedMessage('system', 'Promotion queued.', 'queued', conversation.id, [], 'promotion');
      repository.claimQueuedPromotionMessage(winner.id, 'owner-a', 60_000);

      repository.completeQueuedPromotionMessages(winner.id, 'Combined into the release that just promoted.');

      expect(repository.getSharedMessageById(winner.id)?.status).toBe('running'); // The winner is finished separately by the caller.
      expect(repository.getSharedMessageById(rider.id)?.status).toBe('completed');
      expect(repository.getSharedMessageById(rider.id)?.body).toBe('Combined into the release that just promoted.');
    });

    it('coalesces concurrent promotion approvals into one active control-plane message', () => {
      const firstConversation = repository.createConversation('First approval');
      const secondConversation = repository.createConversation('Second approval');

      const first = repository.queueRuntimePromotion(firstConversation.id);
      const second = repository.queueRuntimePromotion(secondConversation.id);

      expect(second.id).toBe(first.id);
      expect(repository.listQueuedPromotionMessageIds()).toEqual([first.id]);
    });

    it('hasLiveWork is true for a queued or running agent run or shared message, and false once both settle', () => {
      const conversation = repository.createConversation();
      expect(repository.hasLiveWork()).toBe(false);

      const item = repository.create({ title: 'Live work', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
      expect(repository.hasLiveWork()).toBe(true);

      repository.updateRun(run.id, { status: 'completed' });
      expect(repository.hasLiveWork()).toBe(false);

      const message = repository.createSharedMessage('codex', 'Working…', 'running', conversation.id);
      expect(repository.hasLiveWork()).toBe(true);

      repository.updateSharedMessage(message.id, { status: 'completed' });
      expect(repository.hasLiveWork()).toBe(false);
    });

    it('reclaimOrphanedQueuedMessages cancels a queued codex/claude message that has aged past the grace period, freeing hasLiveWork', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', '', 'queued', conversation.id);
      database.prepare("UPDATE shared_messages SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(message.id);
      expect(repository.hasLiveWork()).toBe(true);

      const result = repository.reclaimOrphanedQueuedMessages(15 * 60_000);

      expect(result.canceledMessageIds).toContain(message.id);
      expect(repository.getSharedMessageById(message.id)?.status).toBe('canceled');
      expect(repository.hasLiveWork()).toBe(false);
    });

    it('reclaimOrphanedQueuedMessages leaves a recently queued codex/claude message untouched', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', '', 'queued', conversation.id);

      const result = repository.reclaimOrphanedQueuedMessages(15 * 60_000);

      expect(result.canceledMessageIds).not.toContain(message.id);
      expect(repository.getSharedMessageById(message.id)?.status).toBe('queued');
      expect(repository.hasLiveWork()).toBe(true);
    });

    it('reclaimOrphanedQueuedMessages never touches a queued jeffrey dispatch message, however old', () => {
      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('jeffrey', 'Dispatch request', 'queued', conversation.id);
      database.prepare("UPDATE shared_messages SET created_at = datetime('now', '-1 hour') WHERE id = ?").run(message.id);

      const result = repository.reclaimOrphanedQueuedMessages(15 * 60_000);

      expect(result.canceledMessageIds).not.toContain(message.id);
      expect(repository.getSharedMessageById(message.id)?.status).toBe('queued');
    });
  });

  describe('audit log', () => {
    it('records and lists append-only audit entries, newest first', () => {
      repository.addAuditEntry('outbound_call', 'linear', 'POST https://api.linear.app/graphql');
      repository.addAuditEntry('agent_file_read', 'codex', 'src/index.ts');
      const page = repository.listAuditLog();
      expect(page.entries).toHaveLength(2);
      expect(page.entries[0]).toMatchObject({ category: 'agent_file_read', source: 'codex', detail: 'src/index.ts' });
      expect(page.entries[1]).toMatchObject({ category: 'outbound_call', source: 'linear' });
      expect(page.nextCursor).toBeNull();
    });

    it('associates an audit entry with a work item and survives its deletion via SET NULL', () => {
      const item = repository.create({ title: 'Task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      repository.addAuditEntry('agent_file_write', 'claude', 'src/app.ts', item.id);
      expect(repository.listAuditLog(100, null, undefined, item.id).entries).toHaveLength(1);
      expect(repository.listAuditLog(100, null, 'agent_file_write').entries).toHaveLength(1);
      expect(repository.listAuditLog(100, null, 'agent_tool_use').entries).toHaveLength(0);
    });

    it('paginates with a bounded cursor and rejects an invalid one', () => {
      for (let index = 0; index < 5; index += 1) repository.addAuditEntry('outbound_call', 'slack', `call ${index}`);
      const firstPage = repository.listAuditLog(2);
      expect(firstPage.entries).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = repository.listAuditLog(2, firstPage.nextCursor);
      expect(secondPage.entries).toHaveLength(2);
      expect(secondPage.entries.map((entry) => entry.detail)).not.toEqual(firstPage.entries.map((entry) => entry.detail));
      expect(() => repository.listAuditLog(2, 'not-a-real-cursor')).toThrow('Invalid audit log cursor.');
    });
  });

  describe('extracted repositories: discovery unit-of-work integrity', () => {
    it('rolls back the created work item when convert fails partway through, leaving the candidate pending', () => {
      const run = repository.startDiscoveryRun();
      repository.upsertDiscoveryCandidate({ fingerprint: 'rollback-me', provider: 'slack', title: 'Candidate to roll back', description: '', sourceUrl: null, occurredAt: null, runId: run.id });
      const candidate = repository.getDiscoveryInbox().candidates[0];

      // addActivity runs after WorkItemRepository.create inside the same
      // resolveDiscoveryCandidate transaction. Forcing it to throw proves the
      // work item insert and the candidate status update — both already
      // issued to SQLite — are rolled back together rather than left partial.
      const addActivitySpy = vi.spyOn(repository, 'addActivity').mockImplementationOnce(() => { throw new Error('boom'); });
      expect(() => repository.resolveDiscoveryCandidate(candidate.id, 'convert')).toThrow('boom');
      addActivitySpy.mockRestore();

      expect(repository.list()).toHaveLength(0);
      const inbox = repository.getDiscoveryInbox();
      expect(inbox.pendingCount).toBe(1);
      expect(inbox.candidates[0]).toEqual(expect.objectContaining({ id: candidate.id, status: 'pending' }));
    });

    it('resolveDiscoveryCandidates keeps resolving independent candidates after one is torn down concurrently', () => {
      const run = repository.startDiscoveryRun();
      repository.upsertDiscoveryCandidate({ fingerprint: 'a', provider: 'linear', title: 'A', description: '', sourceUrl: null, occurredAt: null, runId: run.id });
      repository.upsertDiscoveryCandidate({ fingerprint: 'b', provider: 'linear', title: 'B', description: '', sourceUrl: null, occurredAt: null, runId: run.id });
      const [first, second] = repository.getDiscoveryInbox().candidates;

      // Simulates a concurrent resolution of `first` racing this bulk call:
      // by the time the loop reaches it, its row no longer matches the
      // `status = 'pending'` guard, so applyResolution is a no-op rather than
      // a lost-update — the loop must still resolve the untouched candidate.
      repository.resolveDiscoveryCandidate(first.id, 'dismiss');
      const resolved = repository.resolveDiscoveryCandidates([first.id, second.id], 'dismiss');
      expect(resolved.map((candidate) => candidate.id)).toEqual([second.id]);
      expect(repository.getDiscoveryInbox().pendingCount).toBe(0);
    });
  });

  describe('extracted repositories: conversation unit-of-work integrity', () => {
    it('rolls back the forked conversation and its copied messages when copying fails partway through', () => {
      const task = repository.create({ title: 'Conversation task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const source = repository.createConversation('Original thread', task.id);
      repository.createSharedMessage('jeffrey', 'First message', 'completed', source.id);
      repository.createSharedMessage('claude', 'Second message', 'completed', source.id);

      // forkConversation creates the fork row, copies the latest exchange, then
      // unlinks the source from its task — all inside one UnitOfWork
      // transaction. Forcing the message copy to throw proves none of that
      // survives: no orphaned fork row, and the source keeps its task link.
      const createSharedMessageSpy = vi.spyOn(repository, 'createSharedMessage').mockImplementationOnce(() => { throw new Error('boom'); });
      expect(() => repository.forkConversation(source.id)).toThrow('boom');
      createSharedMessageSpy.mockRestore();

      expect(repository.listConversations('all').some((conversation) => conversation.forkedFromConversationId === source.id)).toBe(false);
      expect(repository.getConversation(source.id)?.workItemId).toBe(task.id);
    });

    it('rolls back the archive cascade when the linked task archive fails partway through, leaving both unarchived', () => {
      const task = repository.create({ title: 'Cascade task', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const conversation = repository.createConversation('Cascade thread', task.id);

      // setConversationArchived archives the linked task before flipping the
      // conversation's own archived_at, inside one UnitOfWork transaction.
      // Forcing addActivity (called from inside archive()) to throw proves
      // the task's archive and the conversation's archived_at are rolled
      // back together rather than left half-applied.
      const addActivitySpy = vi.spyOn(repository, 'addActivity').mockImplementationOnce(() => { throw new Error('boom'); });
      expect(() => repository.setConversationArchived(conversation.id, true)).toThrow('boom');
      addActivitySpy.mockRestore();

      expect(repository.get(task.id)?.archivedAt).toBeNull();
      expect(repository.getConversation(conversation.id)?.archivedAt).toBeNull();
    });

    // No other conversation composition (setConversationWorkItem's link/unlink,
    // backfillConversationRunAdoptions) has a genuinely concurrent-write path
    // distinct from the forced-failure rollback covered above and the existing
    // "keeps resolving independent candidates" style race already exercised for
    // discovery — shared_conversations has no unique constraint that a second
    // writer could collide with, so no concurrency test was added here.
  });

  describe('extracted services: work-item lifecycle integrity', () => {
    it('rolls back a work-item archive when archiving its linked conversation fails', () => {
      const task = repository.create({ title: 'Archive rollback', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const conversation = repository.createConversation('Archive history', task.id);

      // The lifecycle service updates work_items before cascading to the
      // linked conversation. A failure in that second write must leave the
      // task active too, rather than commit an orphaned archive state.
      const originalPrepare = database.prepare.bind(database);
      const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('UPDATE shared_conversations SET archived_at = ?')) throw new Error('boom');
        return originalPrepare(sql);
      });
      expect(() => repository.archive(task.id, false)).toThrow('boom');
      prepareSpy.mockRestore();

      expect(repository.get(task.id)?.archivedAt).toBeNull();
      expect(repository.getConversation(conversation.id)?.archivedAt).toBeNull();
      expect(repository.listActivity(task.id).filter((entry) => entry.kind === 'archived')).toHaveLength(0);
    });

    it('treats racing archive requests as one lifecycle transition', () => {
      const task = repository.create({ title: 'One archive transition', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

      // The second caller observes the committed terminal state and becomes a
      // no-op. This is the observable concurrency guarantee for the UI's
      // duplicate-submit/retry path: one task state change and one ledger row.
      repository.archive(task.id, false);
      repository.archive(task.id, false);

      expect(repository.get(task.id)?.archivedAt).toEqual(expect.any(String));
      expect(repository.listActivity(task.id).filter((entry) => entry.kind === 'archived')).toHaveLength(1);
    });
  });

  describe('extracted repositories: run unit-of-work integrity', () => {
    it('prepareRunRetry rolls back the reopened run when reopening its linked chat bubble fails, leaving both still failed', () => {
      const item = repository.create({ title: 'Retry cascade', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
      const message = repository.createSharedMessage('codex', 'Partial output', 'failed', conversation.id);
      const run = repository.createRun(item.id, 'execute', 'codex', 'codex', 'Continue', conversation.id, message.id);
      repository.updateRun(run.id, { status: 'failed', error: 'Agent process stopped reporting progress.' });

      // prepareRunRetry reopens the run row, then reopens its linked message —
      // both inside one UnitOfWork transaction. Forcing the *second* write (the
      // shared_messages reopen) to throw proves the already-issued run reopen
      // does not survive on its own — it must roll back together with the message.
      const originalPrepare = database.prepare.bind(database);
      const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('UPDATE shared_messages') && sql.includes("status = 'running'") && sql.includes("WHERE id = ? AND status IN ('failed', 'canceled')")) throw new Error('boom');
        return originalPrepare(sql);
      });
      expect(() => repository.prepareRunRetry(run.id)).toThrow('boom');
      prepareSpy.mockRestore();

      expect(repository.getRun(run.id)?.status).toBe('failed');
      expect(repository.getSharedMessageById(message.id)?.status).toBe('failed');
    });

    it('reclaimExpired rolls back a recovered run when the shared-message reclaim in the same pass fails, leaving both still expired', () => {
      const item = repository.create({ title: 'Reclaim cascade', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
      repository.claimRun(run.id, 'dead-owner', -1); // lease already expired

      const conversation = repository.createConversation();
      const message = repository.createSharedMessage('codex', 'partial output', 'running', conversation.id);
      repository.claimSharedMessage(message.id, 'dead-owner', -1); // lease already expired

      // reclaimExpired recovers expired agent_runs first, then reclaims
      // expired shared_messages, inside one UnitOfWork transaction. Forcing
      // the shared_messages recovery UPDATE to throw proves the already-issued
      // run recovery from the same pass is rolled back too, rather than left
      // half-applied while the message stays stuck.
      const originalPrepare = database.prepare.bind(database);
      const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes("UPDATE shared_messages SET status = 'failed', error = 'Agent process stopped reporting progress")) throw new Error('boom');
        return originalPrepare(sql);
      });

      expect(() => repository.reclaimExpired(0)).toThrow('boom');
      prepareSpy.mockRestore();

      expect(repository.getRun(run.id)?.status).toBe('running');
      expect(repository.getSharedMessageById(message.id)?.status).toBe('running');
    });

    // claimRun and claimWorkspace already have dedicated atomicity tests above
    // ("claimRun is atomic...", "grants a workspace to one run at a time...")
    // covering the genuine concurrent-claimant races this repository exposes;
    // no further concurrency test was added here to avoid duplicating them.

    it('surfaceStrandedRuns rolls back the agent_runs write when the work_items re-fencing write fails, leaving all three tables untouched', () => {
      const item = repository.create({ title: 'Stranded without a lease', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      repository.update(item.id, { status: 'in_progress' });
      const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
      const message = repository.createSharedMessage('codex', 'Working…', 'running', conversation.id);
      const run = repository.createRun(item.id, 'analysis', 'codex', 'codex', '', conversation.id, message.id);
      // A run stranded before it ever claimed a lease (process died between
      // insert and its first claim) never sets lease_expires_at; back-date its
      // created_at past the grace window so surfaceStrandedRuns treats it as
      // abandoned rather than merely in flight.
      database.prepare("UPDATE agent_runs SET status = 'running', created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(run.id);

      // surfaceStrandedRuns writes agent_runs, then shared_messages, then
      // work_items inside one BEGIN IMMEDIATE transaction. Forcing the final
      // (work_items) write to throw proves the two writes already issued
      // ahead of it do not survive on their own.
      const originalPrepare = database.prepare.bind(database);
      const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('UPDATE work_items') && sql.includes("status = 'ready'") && sql.includes("status = 'in_progress'")) throw new Error('boom');
        return originalPrepare(sql);
      });
      expect(() => repository.surfaceStrandedRuns(0)).toThrow('boom');
      prepareSpy.mockRestore();

      expect(repository.getRun(run.id)?.status).toBe('running');
      expect(repository.getSharedMessageById(message.id)?.status).toBe('running');
      expect(repository.get(item.id)?.status).toBe('in_progress');
    });

    it('reclaimExpired is idempotent across two racing passes: the second finds nothing left to reclaim', () => {
      const item = repository.create({ title: 'Racing reclaim', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const analysisRun = repository.createRun(item.id, 'analysis', 'codex', 'codex', '');
      repository.claimRun(analysisRun.id, 'dead-owner', -1); // lease already expired

      // Two schedulers (or a retry loop) can race to reclaim the same expired
      // lease. The first pass recovers it; the guard on lease_expires_at means
      // a second pass over the same state must find nothing left to touch and
      // must not double-increment the attempt count.
      const first = repository.reclaimExpired(0);
      expect(first.recoveredRunIds).toEqual([analysisRun.id]);
      const afterFirst = repository.getRun(analysisRun.id)!;
      expect(afterFirst.status).toBe('queued');
      expect(afterFirst.attempt).toBe(1);

      const second = repository.reclaimExpired(0);
      expect(second.recoveredRunIds).toEqual([]);
      expect(second.failedRunIds).toEqual([]);
      const afterSecond = repository.getRun(analysisRun.id)!;
      expect(afterSecond.status).toBe('queued');
      expect(afterSecond.attempt).toBe(1);
    });
  });

  describe('extracted repositories: queue unit-of-work integrity', () => {
    it('rolls back undoLastQueueChange when the final re-fencing write fails, leaving the change un-undone and the proposal still pending', () => {
      repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const originalOrder = repository.list().map((item) => item.id);
      const reversedOrder = [...originalOrder].reverse();

      repository.reorder(reversedOrder, 'attention', { actor: 'jeffrey', reason: 'Swap for the test.' });
      expect(repository.list().map((item) => item.id)).toEqual(reversedOrder);
      const proposal = repository.createProposal(originalOrder, 'Proposed reverting the swap.');

      // undoLastQueueChange marks the journalled swap undone, supersedes the
      // pending proposal, replays the previous order (which journals its own
      // new row), then re-fences that replay row so it cannot itself be
      // undone — all inside one UnitOfWork transaction. Forcing that final
      // fencing UPDATE to throw proves the three writes already issued before
      // it (the undo mark, the proposal supersede, and the replay reorder) do
      // not survive on their own.
      const originalPrepare = database.prepare.bind(database);
      const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('WHERE rowid > ? AND undone_at IS NULL')) throw new Error('boom');
        return originalPrepare(sql);
      });

      expect(() => repository.undoLastQueueChange('attention')).toThrow('boom');
      prepareSpy.mockRestore();

      expect(repository.list().map((item) => item.id)).toEqual(reversedOrder);
      expect(repository.listQueueHistory('attention').find((change) => change.newOrder.join() === reversedOrder.join())?.undoneAt).toBeNull();
      expect(repository.getPendingProposal('attention')?.id).toBe(proposal.id);
    });

    it('resolveProposal supersedes a stale proposal instead of applying it when the queue was reordered after it was created', () => {
      repository.create({ title: 'First', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      repository.create({ title: 'Second', description: '', priority: 2, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
      const currentOrder = repository.list().map((item) => item.id);
      const proposal = repository.createProposal([...currentOrder].reverse(), 'Proposed reversal.');

      // Bumps the attention queue's version without changing the order (the
      // reorder is a no-op on the id sequence, so nothing is journalled), the
      // same way any intervening manual reorder would after the proposal was
      // built against an earlier version.
      repository.reorder(currentOrder, 'attention', { actor: 'jeffrey', reason: 'No-op version bump.' });

      const resolved = repository.resolveProposal(proposal.id, 'accepted');

      expect(resolved?.status).toBe('superseded');
      // The stale proposal's reversed order must never have been applied.
      expect(repository.list().map((item) => item.id)).toEqual(currentOrder);
      expect(repository.getPendingProposal('attention')).toBeNull();
    });
  });

  describe('extracted repositories: provider sync unit-of-work integrity', () => {
    it('rolls back an in-place Linear update when the snapshot write fails partway through, leaving the row, override, and lifecycle event untouched', () => {
      const input = { sourceIdentifier: 'ENG-ROLLBACK', sourceUrl: null, title: 'Provider title', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: ['backend'], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };
      repository.upsertLinearItem(input);
      const item = repository.searchLinear('ENG-ROLLBACK')[0];
      // A local edit first, so the update path also writes a provider_field_overrides
      // row, then a status change from the provider that would append a lifecycle
      // event — every write this transaction can make is exercised at once.
      repository.update(item.id, { title: 'Local title' });

      // upsertLinearItem's update branch writes overrides, the work_items row,
      // a lifecycle event (status changed), and the provider snapshot — all
      // inside one UnitOfWork transaction. Forcing the final snapshot INSERT
      // to throw proves none of the earlier writes in the same pass survive.
      const originalPrepare = database.prepare.bind(database);
      const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO provider_work_item_snapshots')) throw new Error('boom');
        return originalPrepare(sql);
      });

      expect(() => repository.upsertLinearItem({ ...input, status: 'done', providerUpdatedAt: '2026-08-18T11:00:00.000Z' })).toThrow('boom');
      prepareSpy.mockRestore();

      const unchanged = repository.get(item.id)!;
      expect(unchanged.title).toBe('Local title');
      expect(unchanged.status).toBe('ready');
      expect(repository.listActivity(item.id).some((activity) => activity.kind === 'imported')).toBe(true);
    });

    it('rolls back resolveProviderConflict when recording the resolution activity fails, leaving the override and work item untouched', () => {
      const input = { sourceIdentifier: 'ENG-CONFLICT-ROLLBACK', sourceUrl: null, title: 'Provider title', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: [], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };
      repository.upsertLinearItem(input);
      const item = repository.searchLinear('ENG-CONFLICT-ROLLBACK')[0];
      repository.update(item.id, { title: 'Local title' });
      repository.upsertLinearItem({ ...input, title: 'Provider title v2', providerUpdatedAt: '2026-08-18T11:00:00.000Z' });
      expect(repository.listProviderConflicts(item.id)).toHaveLength(1);

      // resolveProviderConflict updates work_items, deletes the override row,
      // then records an activity — all inside one UnitOfWork transaction via
      // the injected addActivity collaborator. Forcing addActivity to throw
      // proves the work_items update and override delete do not survive on
      // their own.
      const addActivitySpy = vi.spyOn(repository, 'addActivity').mockImplementationOnce(() => { throw new Error('boom'); });
      expect(() => repository.resolveProviderConflict(item.id, 'title', 'use_provider')).toThrow('boom');
      addActivitySpy.mockRestore();

      expect(repository.get(item.id)?.title).toBe('Local title');
      expect(repository.listProviderConflicts(item.id)).toHaveLength(1);
    });

    it('upsertLinearItems keeps every prior page-item write atomic with a later item in the same page when that later item fails', () => {
      const first = { sourceIdentifier: 'ENG-PAGE-1', sourceUrl: null, title: 'First', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: [], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };
      const second = { sourceIdentifier: 'ENG-PAGE-2', sourceUrl: null, title: 'Second', description: '', status: 'ready' as const, priority: 2, projectName: null, labels: [], dueDate: null, providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {} };

      // A whole synced page composes as one UnitOfWork transaction (upsertLinearItems
      // wraps every item's upsertLinearItem call). Forcing the second new item's
      // insert to fail proves the first item's otherwise-committed insert is rolled
      // back too.
      let newItemInserts = 0;
      const originalPrepare = database.prepare.bind(database);
      const prepareSpy = vi.spyOn(database, 'prepare').mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO work_items') && sql.includes("'linear'")) {
          newItemInserts += 1;
          if (newItemInserts === 2) throw new Error('boom');
        }
        return originalPrepare(sql);
      });

      expect(() => repository.upsertLinearItems([first, second])).toThrow('boom');
      prepareSpy.mockRestore();

      expect(repository.searchLinear('ENG-PAGE-1')).toHaveLength(0);
      expect(repository.searchLinear('ENG-PAGE-2')).toHaveLength(0);
    });
  });

  describe('Workbench focus', () => {
    const make = (title: string, projectName: string | null, stack?: 'attention' | 'workbench') =>
      repository.create({ title, description: '', priority: 2, status: 'ready', projectName, stack, workspacePath: null, dueDate: null });

    it('keeps every task in attention and focuses Workbench by project', () => {
      expect(make('Build it', 'Workbench').stack).toBe('attention');
      expect(make('Ship it', 'Writer').stack).toBe('attention');
      expect(make('No project', null).stack).toBe('attention');
      // Case-insensitively, matching the predicate this replaced.
      expect(make('Lowercase', 'workbench').stack).toBe('attention');
      expect(repository.listWorkbench().map((item) => item.title)).toEqual(['Lowercase', 'Build it']);
    });

    it('keeps canceled queued tasks in their stack attention list', () => {
      const attention = make('Stopped Writer work', 'Writer');
      const workbench = make('Stopped Workbench work', 'Workbench');
      repository.update(attention.id, { status: 'canceled' });
      repository.update(workbench.id, { status: 'canceled' });

      expect(repository.list().map((item) => item.id)).toEqual(expect.arrayContaining([attention.id, workbench.id]));
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([workbench.id]);
      expect(repository.getWorkItemCounts()).toEqual(expect.objectContaining({ active: 1, workbench: 1 }));
    });

    it('ignores legacy stack input when creating work', () => {
      expect(make('Explicit attention', 'Workbench', 'attention').stack).toBe('attention');
      expect(make('Explicit workbench', 'Writer', 'workbench').stack).toBe('attention');
      expect(repository.listWorkbench().map((item) => item.title)).toEqual(['Explicit attention']);
      expect(repository.list().map((item) => item.title)).toEqual(['Explicit workbench', 'Explicit attention']);
    });

    it('updates the Workbench focus when its project is renamed', () => {
      const item = make('Roadmap work', 'Workbench');
      expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([item.id]);

      const renamed = repository.update(item.id, { projectName: 'Workbench Platform' })!;

      expect(renamed.stack).toBe('attention');
      expect(repository.listWorkbench()).toHaveLength(0);
      expect(repository.list().map((entry) => entry.id)).toEqual([item.id]);
      expect(repository.getWorkItemCounts()).toEqual(expect.objectContaining({ active: 1, workbench: 0 }));
    });

    it('pulls a task into the Workbench focus by naming its project Workbench', () => {
      const item = make('Attention work', 'Writer');
      const renamed = repository.update(item.id, { projectName: 'Workbench' })!;

      expect(renamed.stack).toBe('attention');
      expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([item.id]);
      expect(repository.list().map((entry) => entry.id)).toEqual([item.id]);
    });

    it('does not split the canonical queue when legacy stack input changes', () => {
      const first = make('Workbench first', 'Workbench');
      const second = make('Workbench second', 'Workbench');
      const attention = make('Attention only', null);

      const moved = repository.update(second.id, { stack: 'attention' })!;

      expect(moved.stack).toBe('attention');
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([second.id, first.id]);
      expect(repository.list().map((item) => item.id)).toEqual([attention.id, second.id, first.id]);
      expect(repository.listActivity(second.id).some((entry) => entry.kind === 'stack_changed')).toBe(false);
    });

    it('updates the Workbench focus when Linear sync rewrites the project name', () => {
      repository.upsertLinearItem({
        sourceIdentifier: 'CON-1', sourceUrl: null, title: 'Imported', description: '', status: 'ready',
        priority: 2, projectName: 'Workbench', labels: [], dueDate: null,
        providerUpdatedAt: '2026-08-20T09:00:00.000Z', providerPayload: {},
      });
      const imported = repository.searchLinear('Imported')[0];
      // A provider project named Workbench is in the focused view.
      expect(imported.stack).toBe('attention');

      repository.queueLinearItem(imported.id);
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([imported.id]);

      repository.upsertLinearItem({
        sourceIdentifier: 'CON-1', sourceUrl: null, title: 'Imported', description: '', status: 'ready',
        priority: 2, projectName: 'Something Else', labels: [], dueDate: null,
        providerUpdatedAt: '2026-08-20T10:00:00.000Z', providerPayload: {},
      });

      const synced = repository.get(imported.id)!;
      expect(synced.projectName).toBe('Something Else');
      expect(synced.stack).toBe('attention');
      expect(repository.listWorkbench()).toEqual([]);
    });

    it('keeps follow-ups and approved plan children in the canonical queue', () => {
      const parent = make('Parent', 'Writer', 'workbench');
      const followUp = repository.createFollowUp(parent.id, 'Follow up', '')!;
      expect(followUp.stack).toBe('attention');
      expect(repository.listWorkbench()).toEqual([]);

      const plan = repository.createExecutionPlan(parent.id, 'Split it.', [
        { title: 'Child task', description: 'Do the work.', workspacePath: null },
      ]);
      repository.resolveExecutionPlan(plan.id, 'accepted');
      expect(repository.list().map((item) => item.title)).toContain('Child task');
      expect(repository.list().every((item) => item.stack === 'attention')).toBe(true);
    });

    it('restores an archived task to the canonical queue', () => {
      const item = make('Archived roadmap task', 'Writer', 'workbench');
      repository.archive(item.id, false);
      expect(repository.listWorkbench()).toHaveLength(0);

      const restored = repository.restore(item.id)!;
      expect(restored.stack).toBe('attention');
      expect(repository.listWorkbench()).toEqual([]);
      expect(repository.list().map((entry) => entry.id)).toEqual([item.id]);
    });

    it('keeps legacy bulk stack changes in the canonical queue', () => {
      const first = make('First', 'Workbench');
      const second = make('Second', 'Workbench');
      const attention = make('Attention', null);

      const result = repository.bulkUpdate({ action: 'set_stack', ids: [first.id, second.id], stack: 'attention' });

      expect(result.conflicts).toEqual([]);
      expect(result.appliedIds).toEqual([first.id, second.id]);
      expect(repository.listWorkbench().map((item) => item.id)).toEqual([second.id, first.id]);
      expect(repository.list().map((item) => item.id)).toEqual([attention.id, second.id, first.id]);
      expect(repository.list().map((item) => item.queuePosition)).toEqual([1, 2, 3]);
    });

    it('removes a task from the Workbench focus after a bulk project rename', () => {
      const item = make('Roadmap', 'Workbench');
      repository.bulkUpdate({ action: 'set_project', ids: [item.id], projectName: 'Renamed' });

      expect(repository.get(item.id)!.stack).toBe('attention');
      expect(repository.listWorkbench()).toEqual([]);
    });

    it('logs an edit entry for each item touched by a bulk status or assignee change', () => {
      const first = make('First', 'Workbench');
      const second = make('Second', 'Workbench');

      repository.bulkUpdate({ action: 'set_status', ids: [first.id, second.id], status: 'in_progress' });
      expect(repository.listActivity(first.id).some((entry) => entry.kind === 'edited')).toBe(true);
      expect(repository.listActivity(second.id).some((entry) => entry.kind === 'edited')).toBe(true);

      repository.bulkUpdate({ action: 'set_assignees', ids: [first.id], assignees: ['codex'] });
      expect(repository.listActivity(first.id).filter((entry) => entry.kind === 'edited')).toHaveLength(2);

      repository.bulkUpdate({ action: 'set_project', ids: [first.id], projectName: 'Renamed' });
      expect(repository.listActivity(first.id).filter((entry) => entry.kind === 'edited')).toHaveLength(3);
    });

    it('rejects a stack value outside the allowed set at the database boundary', () => {
      const item = make('Guarded', null);
      expect(() => database.prepare('UPDATE work_items SET stack = ? WHERE id = ?').run('nonsense', item.id))
        .toThrow(/CHECK constraint failed/);
    });
  });

describe('task dependencies', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

    const make = (title: string) => repository.create({
      title, description: '', priority: 2, status: 'ready',
      projectName: 'Workbench', workspacePath: null, dueDate: null,
    });

    it('records prerequisites and reports them on every queue read', () => {
      const blocker = make('Schema first');
      const dependent = make('API second');

      expect(repository.replaceDependencies(dependent.id, [blocker.id]).map((entry) => entry.id)).toEqual([blocker.id]);
      expect(repository.get(dependent.id)!.blockedBy).toEqual([
        expect.objectContaining({ id: blocker.id, title: 'Schema first', isOpen: true }),
      ]);
      // The list read must carry the same edges, or the queue UI would show a
      // blocked task as dispatchable. These tasks carry the "Workbench" project
      // name, so create() seats them in the workbench stack rather than attention.
      expect(repository.listWorkbench().find((entry) => entry.id === dependent.id)!.blockedBy)
        .toEqual([expect.objectContaining({ id: blocker.id })]);
      expect(repository.get(blocker.id)!.blockedBy).toEqual([]);
    });

    it('closes the gate only when a prerequisite reaches a terminal state', () => {
      const blocker = make('Schema first');
      const dependent = make('API second');
      repository.replaceDependencies(dependent.id, [blocker.id]);

      expect(repository.listOpenDependencies(dependent.id)).toHaveLength(1);

      repository.update(blocker.id, { status: 'in_progress' });
      expect(repository.listOpenDependencies(dependent.id)).toHaveLength(1);

      repository.update(blocker.id, { status: 'done' });
      expect(repository.listOpenDependencies(dependent.id)).toHaveLength(0);
      expect(repository.listDependencies(dependent.id)).toEqual([
        expect.objectContaining({ id: blocker.id, isOpen: false }),
      ]);
    });

    it('treats terminal and tombstoned prerequisites as absent from active blockers', () => {
      const canceled = make('Dropped approach');
      const archived = make('Parked work');
      const dependent = make('Downstream');
      repository.replaceDependencies(dependent.id, [canceled.id, archived.id]);

      repository.update(canceled.id, { status: 'canceled' });
      repository.archive(archived.id, false);

      expect(repository.listOpenDependencies(dependent.id).map((entry) => entry.id)).toEqual([]);
    });

    it('rejects a self-dependency', () => {
      const item = make('Alone');
      expect(() => repository.replaceDependencies(item.id, [item.id])).toThrow(WorkItemDependencyError);
      expect(repository.listDependencies(item.id)).toEqual([]);
    });

    it('rejects a prerequisite that does not exist', () => {
      const item = make('Real');
      expect(() => repository.replaceDependencies(item.id, ['00000000-0000-4000-8000-000000000000']))
        .toThrow(/existing task/i);
    });

    it('rejects a direct cycle and leaves the existing edges untouched', () => {
      const first = make('First');
      const second = make('Second');
      repository.replaceDependencies(second.id, [first.id]);

      expect(() => repository.replaceDependencies(first.id, [second.id])).toThrow(/cycle/i);
      // The rollback matters: a failed write must not strip the edge it replaced.
      expect(repository.listDependencies(first.id)).toEqual([]);
      expect(repository.listDependencies(second.id).map((entry) => entry.id)).toEqual([first.id]);
    });

    it('rejects an indirect cycle across three tasks', () => {
      const first = make('First');
      const second = make('Second');
      const third = make('Third');
      repository.replaceDependencies(second.id, [first.id]);
      repository.replaceDependencies(third.id, [second.id]);

      expect(() => repository.replaceDependencies(first.id, [third.id])).toThrow(/cycle/i);
      expect(repository.listDependencies(first.id)).toEqual([]);
    });

    it('replaces the whole edge set and de-duplicates repeated prerequisites', () => {
      const first = make('First');
      const second = make('Second');
      const dependent = make('Dependent');

      repository.replaceDependencies(dependent.id, [first.id, first.id]);
      expect(repository.listDependencies(dependent.id).map((entry) => entry.id)).toEqual([first.id]);

      repository.replaceDependencies(dependent.id, [second.id]);
      expect(repository.listDependencies(dependent.id).map((entry) => entry.id)).toEqual([second.id]);

      repository.replaceDependencies(dependent.id, []);
      expect(repository.listDependencies(dependent.id)).toEqual([]);
    });

    it('sets prerequisites through update() and rolls back the field changes when the edge is invalid', () => {
      const blocker = make('Blocker');
      const dependent = make('Dependent');

      expect(repository.update(dependent.id, { blockedByIds: [blocker.id] })!.blockedBy)
        .toEqual([expect.objectContaining({ id: blocker.id })]);

      // A rejected dependency edit must not leak a half-applied title change.
      expect(() => repository.update(dependent.id, { title: 'Renamed', blockedByIds: [dependent.id] }))
        .toThrow(WorkItemDependencyError);
      expect(repository.get(dependent.id)!.title).toBe('Dependent');
      expect(repository.listDependencies(dependent.id).map((entry) => entry.id)).toEqual([blocker.id]);
    });

    it('lists the work waiting on a blocker and drops the edge when a task is deleted', () => {
      const blocker = make('Blocker');
      const first = make('Waiting one');
      const second = make('Waiting two');
      repository.replaceDependencies(first.id, [blocker.id]);
      repository.replaceDependencies(second.id, [blocker.id]);

      expect(repository.listBlockedWork(blocker.id).map((entry) => entry.id).sort())
        .toEqual([first.id, second.id].sort());

      repository.delete(first.id);
      expect(repository.listBlockedWork(blocker.id).map((entry) => entry.id)).toEqual([second.id]);
      expect(repository.listDependencies(second.id).map((entry) => entry.id)).toEqual([blocker.id]);
    });

    it('excludes the task itself from its own prerequisite candidates', () => {
      const item = make('Self');
      const other = make('Other');

      const candidates = repository.searchDependencyCandidates(item.id);
      expect(candidates.map((entry) => entry.id)).toContain(other.id);
      expect(candidates.map((entry) => entry.id)).not.toContain(item.id);
      expect(repository.searchDependencyCandidates(item.id, 'Other').map((entry) => entry.id)).toEqual([other.id]);
    });

    it('counts only still-open dependents when building the planner context', () => {
      const blocker = make('Critical path');
      const open = make('Waiting');
      const finished = make('Already done');
      repository.replaceDependencies(open.id, [blocker.id]);
      repository.replaceDependencies(finished.id, [blocker.id]);
      repository.update(finished.id, { status: 'done' });

      expect(repository.buildQueueContext().openDependents.get(blocker.id)).toBe(1);
    });
  });
  describe('canonical project names', () => {
    const create = (title: string, projectName: string | null) =>
      repository.create({ title, description: '', priority: 2, status: 'ready', projectName, workspacePath: null, dueDate: null });

    it('stores one spelling however the project is typed', () => {
      const first = create('Established the project', 'Workbench');
      const variants = ['workbench', 'WORKBENCH', ' work bench ', 'wokrbench', 'wkbnch']
        .map((typed, index) => create(`Variant ${index}`, typed));

      for (const item of [first, ...variants]) expect(item.projectName).toBe('Workbench');
      expect(repository.listProjects().map((project) => project.name)).toEqual(['Workbench']);
    });

    it('keeps every spelling of the project in the Workbench stack and out of attention', () => {
      create('Typed correctly', 'Workbench');
      create('Typed badly', 'wokrbench');
      create('Abbreviated', 'wkbnch');
      create('A different project', 'Connectors');
      create('No project at all', null);

      expect(repository.listWorkbench().map((item) => item.title).sort())
        .toEqual(['Abbreviated', 'Typed badly', 'Typed correctly']);
      // The attention queue is the full canonical queue and Workbench is a
      // slice of it, so exclusion shows up in the paged view and the counts.
      const emptyFilter = { query: '', projectNames: [], statuses: [], assignees: [], sources: [], labels: [], dueStates: [] };
      expect(repository.listPage('active', 50, null, emptyFilter).items.map((item) => item.title).sort())
        .toEqual(['A different project', 'No project at all']);
      expect(repository.listPage('workbench', 50, null, emptyFilter).items.map((item) => item.title).sort())
        .toEqual(['Abbreviated', 'Typed badly', 'Typed correctly']);
      expect(repository.getWorkItemCounts()).toMatchObject({ active: 2, workbench: 3 });
    });

    it('leaves an unrelated name as its own project rather than guessing', () => {
      create('First', 'Workbench');
      const other = create('Second', 'Quarterly planning');

      expect(other.projectName).toBe('Quarterly planning');
      expect(repository.listProjects().map((project) => project.key).sort()).toEqual(['quarterlyplanning', 'workbench']);
    });

    it('canonicalises a project set after the fact, including through a bulk edit', () => {
      const item = create('Needs a project', null);
      expect(repository.update(item.id, { projectName: 'Workbench' })!.projectName).toBe('Workbench');

      const bulkTarget = create('Bulk target', null);
      repository.bulkUpdate({ action: 'set_project', ids: [bulkTarget.id], projectName: 'wkbnch' });
      expect(repository.get(bulkTarget.id)!.projectName).toBe('Workbench');

      expect(repository.update(item.id, { projectName: null })!.projectName).toBeNull();
      expect(repository.listWorkbench().map((entry) => entry.id)).toEqual([bulkTarget.id]);
    });

    it('remembers a resolved misspelling as an alias so it no longer depends on the matcher', () => {
      create('Established the project', 'Workbench');
      create('Typed badly', 'wkbnch');

      expect(database.prepare("SELECT alias_key, alias_text FROM project_aliases").all())
        .toEqual([{ alias_key: 'wkbnch', alias_text: 'wkbnch' }]);
    });

    it('unifies casing from Linear without merging two distinct provider projects', () => {
      const providerItem = {
        sourceIdentifier: 'ENG-1', sourceUrl: null, title: 'Imported', description: '',
        status: 'ready' as const, priority: 2, projectName: 'Workbench', labels: [], dueDate: null,
        providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {},
      };
      repository.upsertLinearItem(providerItem);
      repository.upsertLinearItem({ ...providerItem, sourceIdentifier: 'ENG-2', projectName: 'workbench' });
      // One edit from `Workbench`, but Linear owns its names: this is a real,
      // separate provider project and must not be folded into the other.
      repository.upsertLinearItem({ ...providerItem, sourceIdentifier: 'ENG-3', projectName: 'Workbenches' });

      expect(repository.searchLinear('ENG-2')[0].projectName).toBe('Workbench');
      expect(repository.searchLinear('ENG-3')[0].projectName).toBe('Workbenches');
      expect(repository.listProjects().map((project) => project.name).sort()).toEqual(['Workbench', 'Workbenches']);
    });

    it('does not log a provider conflict when a Linear task is re-typed in different casing', () => {
      repository.upsertLinearItem({
        sourceIdentifier: 'ENG-7', sourceUrl: null, title: 'Imported', description: '',
        status: 'ready' as const, priority: 2, projectName: 'Workbench', labels: [], dueDate: null,
        providerUpdatedAt: '2026-08-18T10:00:00.000Z', providerPayload: {},
      });
      const item = repository.searchLinear('ENG-7')[0];
      repository.update(item.id, { projectName: 'workbench' });

      expect(repository.get(item.id)!.projectName).toBe('Workbench');
      expect(repository.countProviderConflicts()).toBe(0);
    });

    it('ranks the vocabulary by live task count for the picker', () => {
      create('One', 'Connectors');
      create('Two', 'Workbench');
      create('Three', 'Workbench');

      expect(repository.listProjects().map((project) => ({ name: project.name, taskCount: project.taskCount })))
        .toEqual([{ name: 'Workbench', taskCount: 2 }, { name: 'Connectors', taskCount: 1 }]);
    });
  });
});
