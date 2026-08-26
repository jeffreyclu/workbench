import { Router } from 'express';
import { z } from 'zod';
import { getGitHubPullRequestDiff } from '../github-pull-request-diff.js';
import type { RouteContext } from '../route-context.js';

export function createGitHubRouter({ repository }: RouteContext) {
  const router = Router();
  router.get('/api/github/pull-request-diff', async (request, response, next) => {
    try {
      const url = z.string().url().max(2_000).parse(request.query.url);
      const token = repository.getSourceSettings('github')?.token ?? process.env.GITHUB_TOKEN;
      if (!token) return response.status(409).json({ error: 'GitHub is not connected. Connect it in Sources to view pull-request diffs.' });
      response.json({ diff: await getGitHubPullRequestDiff(url, { token }) });
    } catch (error) { next(error); }
  });
  return router;
}
