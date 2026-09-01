import { expect, test } from '@playwright/test';

test('returns a successful isolated commit-and-push result', async ({ request }) => {
  const response = await request.post('/api/e2e/commit-and-push', { data: { revision: 'e2e-revision', message: 'feat: publish workspace changes' } });
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toEqual({ result: { committed: true, pushed: true, commit: 'e2e1234' } });
});

test('returns the partial-failure detail when the isolated push is rejected', async ({ request }) => {
  const response = await request.post('/api/e2e/commit-and-push', { data: { revision: 'e2e-revision', fail: true } });
  expect(response.status()).toBe(502);
  await expect(response.json()).resolves.toEqual({ error: 'Commit created, but push failed. remote: permission denied' });
});
