import { Router } from 'express';
import { z } from 'zod';
import { getGitHubPullRequestDiff, getGitHubPullRequestImage } from '../github-pull-request-diff.js';
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
  return router;
}
