import { Router } from 'express';
import { z } from 'zod';
import { getGitHubCommitDiff, getGitHubPullRequestCommits, getGitHubPullRequestDiff, getGitHubPullRequestFile, getGitHubPullRequestImage } from '../github-pull-request-diff.js';
import type { RouteContext } from '../route-context.js';

export function createGitHubRouter({ repository }: RouteContext) {
  const router = Router();
  router.get('/api/github/pull-request-diff', async (request, response, next) => {
    try {
      const url = z.string().url().max(2_000).parse(request.query.url);
      const token = repository.getSourceSettings('github')?.token ?? process.env.GITHUB_TOKEN;
      if (!token) return response.status(409).json({ error: 'GitHub is not connected. Connect it in Sources to view pull-request diffs.' });
      const page = z.coerce.number().int().positive().max(30).default(1).parse(request.query.page);
      response.json({ diff: await getGitHubPullRequestDiff(url, { token, page }) });
    } catch (error) { next(error); }
  });
  router.get('/api/github/pull-request-commits', async (request, response, next) => {
    try {
      const url = z.string().url().max(2_000).parse(request.query.url);
      const token = repository.getSourceSettings('github')?.token ?? process.env.GITHUB_TOKEN;
      if (!token) return response.status(409).json({ error: 'GitHub is not connected. Connect it in Sources to view pull-request diffs.' });
      response.json({ commits: await getGitHubPullRequestCommits(url, { token }) });
    } catch (error) { next(error); }
  });
  router.get('/api/github/pull-request-commit-diff', async (request, response, next) => {
    try {
      const url = z.string().url().max(2_000).parse(request.query.url);
      const sha = z.string().trim().min(7).max(40).parse(request.query.sha);
      const token = repository.getSourceSettings('github')?.token ?? process.env.GITHUB_TOKEN;
      if (!token) return response.status(409).json({ error: 'GitHub is not connected. Connect it in Sources to view pull-request diffs.' });
      response.json(await getGitHubCommitDiff(url, sha, { token }));
    } catch (error) { next(error); }
  });
  router.get('/api/github/pull-request-image', async (request, response, next) => {
    try {
      const url = z.string().url().max(2_000).parse(request.query.url);
      const path = z.string().min(1).max(4_000).parse(request.query.path);
      const token = repository.getSourceSettings('github')?.token ?? process.env.GITHUB_TOKEN;
      if (!token) return response.status(409).json({ error: 'GitHub is not connected. Connect it in Sources to view pull-request diffs.' });
      const image = await getGitHubPullRequestImage(url, path, { token });
      response.set({ 'Cache-Control': 'no-store', 'Content-Type': image.contentType }).send(image.body);
    } catch (error) { next(error); }
  });
  router.get('/api/github/pull-request-file', async (request, response, next) => {
    try {
      const url = z.string().url().max(2_000).parse(request.query.url);
      const path = z.string().min(1).max(4_000).parse(request.query.path);
      const revision = z.string().regex(/^[0-9a-f]{7,40}$/).parse(request.query.revision);
      const token = repository.getSourceSettings('github')?.token ?? process.env.GITHUB_TOKEN;
      if (!token) return response.status(409).json({ error: 'GitHub is not connected. Connect it in Sources to view pull-request diffs.' });
      response.set('Cache-Control', 'no-store').json({ file: await getGitHubPullRequestFile(url, path, revision, { token }) });
    } catch (error) { next(error); }
  });
  return router;
}
