import { Router } from 'express';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { createStandaloneReviewSchema, upsertDiffBlockReviewSchema, upsertDiffHunkReviewsSchema, type StandaloneReview, type WorkspaceDiff } from '../../shared/contracts.js';
import { getWorkspaceCommitDiff, getWorkspaceDiff, getWorkspaceDiffRevision, getWorkspaceFileSource, getWorkspaceRefDiff, listWorkspaceRefCommits, listWorkspaceRefs } from '../workspace-diff.js';
import { listCandidateWorkspaces } from '../workspace-candidates.js';
import type { RouteContext } from '../route-context.js';

/** A pull-request review has no local checkout, and asking for the working
 * tree of one is a real question with an empty answer — not an error. The
 * review still resolves its diff from the pull request itself. */
const EMPTY_DIFF: WorkspaceDiff = {
  workspacePath: '',
  branch: '',
  revision: 'pull-request',
  files: [],
  changedFiles: 0,
  additions: 0,
  deletions: 0,
  publish: { branch: null, hasOrigin: false, ahead: 0, hasChanges: false, reason: 'This review reads a pull request, not a local checkout.' },
};

const usableRepository = (path: string) => {
  try { return existsSync(path) && statSync(path).isDirectory(); }
  catch { return false; }
};

/**
 * Reviews that exist without a conversation.
 *
 * A review is created from what it reads — a pull request link, or a
 * repository and optionally the branch or worktree to open on — and then reads
 * its diff through the same endpoints Changes and the review stack already
 * use, scoped to the review itself. Nothing here touches conversation or
 * task-scoped review state.
 */
export function createReviewRouter({ repository }: RouteContext) {
  const router = Router();

  // Registered before `/api/reviews/:id/*` so the picker's own path is never
  // read as a review id.
  router.get('/api/reviews/repositories', (_request, response, next) => {
    try {
      response.json({ repositories: listCandidateWorkspaces().map((path) => ({ path, label: basename(path) })) });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/repositories/refs', async (request, response, next) => {
    try {
      const path = resolve(z.string().trim().min(1).parse(request.query.repositoryPath));
      if (!listCandidateWorkspaces().includes(path) || !usableRepository(path)) return response.status(400).json({ error: 'Pick a repository from this machine.' });
      response.json({ refs: await listWorkspaceRefs(path) });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews', (_request, response) => {
    response.json({ reviews: repository.listStandaloneReviews() });
  });

  router.post('/api/reviews', (request, response, next) => {
    try {
      const input = createStandaloneReviewSchema.parse(request.body);
      if (input.repositoryPath) {
        const path = resolve(input.repositoryPath);
        if (!listCandidateWorkspaces().includes(path) || !usableRepository(path)) return response.status(400).json({ error: 'Pick a repository from this machine.' });
        return response.status(201).json({ review: repository.createStandaloneReview({ ...input, repositoryPath: path }) });
      }
      response.status(201).json({ review: repository.createStandaloneReview(input) });
    } catch (error) { next(error); }
  });

  router.delete('/api/reviews/:id', (request, response) => {
    if (!repository.deleteStandaloneReview(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
    response.json({ deleted: true });
  });

  const review = (id: string): StandaloneReview | null => repository.getStandaloneReview(id);
  /** The checkout a review reads, or null for a pull-request review, which has
   * none by construction. */
  const workingDirectory = (id: string) => {
    const found = review(id);
    if (!found || found.source.kind !== 'repository') return null;
    return usableRepository(found.source.repositoryPath) ? found.source.repositoryPath : null;
  };

  router.get('/api/reviews/:id', (request, response) => {
    const found = review(request.params.id);
    if (!found) return response.status(404).json({ error: 'Review not found.' });
    response.json({ review: found });
  });

  router.get('/api/reviews/:id/workspace-diff', async (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      const directory = workingDirectory(request.params.id);
      const diff = directory ? await getWorkspaceDiff(directory) : EMPTY_DIFF;
      if (diff.changedFiles > 0) repository.captureStandaloneReviewDiffSnapshot(request.params.id, diff);
      response.json({ diff });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/:id/workspace-diff/snapshots', (request, response) => {
    if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
    response.json({ snapshots: repository.listStandaloneReviewDiffSnapshots(request.params.id) });
  });

  router.get('/api/reviews/:id/workspace-diff/refs', async (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      const directory = workingDirectory(request.params.id);
      response.json({ refs: directory ? await listWorkspaceRefs(directory) : { base: null, branches: [], worktrees: [] } });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/:id/workspace-diff/ref', async (request, response, next) => {
    try {
      const directory = workingDirectory(request.params.id);
      if (!directory) return response.status(409).json({ error: 'This review has no repository to read a branch from.' });
      const ref = typeof request.query.ref === 'string' ? request.query.ref : '';
      if (!ref) return response.status(400).json({ error: 'Specify which branch or worktree to review.' });
      const diff = await getWorkspaceRefDiff(directory, ref);
      if (diff.changedFiles > 0) repository.captureStandaloneReviewDiffSnapshot(request.params.id, diff);
      response.json({ diff });
    } catch (error) { next(error); }
  });

  // A branch is reviewable whole or one commit at a time; these two answer the
  // second reading without moving what the whole-branch reading shows.
  router.get('/api/reviews/:id/workspace-diff/ref/commits', async (request, response, next) => {
    try {
      const directory = workingDirectory(request.params.id);
      if (!directory) return response.status(409).json({ error: 'This review has no repository to read commits from.' });
      const ref = typeof request.query.ref === 'string' ? request.query.ref : '';
      if (!ref) return response.status(400).json({ error: 'Specify which branch to list commits for.' });
      response.json({ commits: await listWorkspaceRefCommits(directory, ref) });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/:id/workspace-diff/commit', async (request, response, next) => {
    try {
      const directory = workingDirectory(request.params.id);
      if (!directory) return response.status(409).json({ error: 'This review has no repository to read a commit from.' });
      const commit = z.string().trim().min(1).max(200).parse(request.query.commit);
      const diff = await getWorkspaceCommitDiff(directory, commit);
      if (diff.changedFiles > 0) repository.captureStandaloneReviewDiffSnapshot(request.params.id, diff);
      response.json({ diff });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/:id/workspace-diff/status', async (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      const directory = workingDirectory(request.params.id);
      if (!directory) return response.json({ changed: false });
      response.json({ changed: await getWorkspaceDiffRevision(directory) !== request.query.revision });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/:id/workspace-diff/file', async (request, response, next) => {
    try {
      const directory = workingDirectory(request.params.id);
      if (!directory) return response.status(409).json({ error: 'This review has no repository to read files from.' });
      const path = typeof request.query.path === 'string' ? request.query.path : '';
      const revision = typeof request.query.revision === 'string' && request.query.revision ? request.query.revision : null;
      response.json({ file: await getWorkspaceFileSource(directory, path, revision) });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/:id/workspace-diff/hunk-reviews', (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      const revision = z.string().trim().min(1).parse(request.query.revision);
      response.json({ reviews: repository.listDiffHunkReviews({ reviewId: request.params.id }, revision) });
    } catch (error) { next(error); }
  });
  router.put('/api/reviews/:id/workspace-diff/hunk-reviews', (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      const input = z.object({
        revision: z.string().trim().min(1),
        filePath: z.string().trim().min(1),
        hunkRange: z.string().trim().min(1),
        contentHash: z.string().trim().min(1).max(64),
        state: z.enum(['reviewed', 'needs_changes', 'commented']),
        note: z.string().trim().min(1).optional(),
      }).parse(request.body);
      response.json({ review: repository.upsertDiffHunkReview({ reviewId: request.params.id }, input) });
    } catch (error) { next(error); }
  });
  router.put('/api/reviews/:id/workspace-diff/hunk-reviews/batch', (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      response.json({ reviews: repository.upsertDiffHunkReviews({ reviewId: request.params.id }, upsertDiffHunkReviewsSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  router.get('/api/reviews/:id/workspace-diff/block-reviews', (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      const revision = z.string().trim().min(1).parse(request.query.revision);
      response.json({ reviews: repository.listDiffBlockReviews({ reviewId: request.params.id }, revision) });
    } catch (error) { next(error); }
  });
  router.put('/api/reviews/:id/workspace-diff/block-reviews', (request, response, next) => {
    try {
      if (!review(request.params.id)) return response.status(404).json({ error: 'Review not found.' });
      response.json({ review: repository.upsertDiffBlockReview({ reviewId: request.params.id }, upsertDiffBlockReviewSchema.parse(request.body)) });
    } catch (error) { next(error); }
  });

  return router;
}
