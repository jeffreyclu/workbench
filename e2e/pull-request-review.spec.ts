import { expect, test } from '@playwright/test';

test('reviews a pull-request diff from the task workspace review UI', async ({ page, request }, testInfo) => {
  const sourceUrl = 'https://github.com/example/workbench/pull/42';
  const created = await request.post('/api/work-items', { data: { title: `E2E PR review ${testInfo.project.name}-${Date.now().toString(36)}`, description: '', status: 'ready', projectName: null, dueDate: null, sourceUrl } });
  const { item } = await created.json();
  await page.goto(`/tasks/${item.id}`);
  await page.getByText('Workspace review').click();
  await page.getByRole('button', { name: 'GitHub PR' }).click();
  await expect(page.getByRole('heading', { name: 'feature/reconnect → main' })).toBeVisible();
  await expect(page.getByText('src/realtime.ts', { exact: true })).toHaveCount(2);
});

test('keeps a failed pull-request fetch visible and retryable', async ({ page, request }, testInfo) => {
  const created = await request.post('/api/work-items', { data: { title: `E2E missing PR ${testInfo.project.name}-${Date.now().toString(36)}`, description: '', status: 'ready', projectName: null, dueDate: null, sourceUrl: 'https://github.com/example/workbench/pull/404' } });
  const { item } = await created.json();
  await page.goto(`/tasks/${item.id}`);
  await page.getByText('Workspace review').click();
  await page.getByRole('button', { name: 'GitHub PR' }).click();
  await expect(page.getByText('Could not load this source.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
});
