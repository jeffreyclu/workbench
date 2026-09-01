import { expect, test } from '@playwright/test';

test('creates a task in the UI, starts an agent, and receives its output', async ({ page }, testInfo) => {
  const title = `E2E agent task ${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto('/');
  await page.getByRole('button', { name: /add task|new task/i }).click();
  await page.getByRole('button', { name: 'Manual task' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await page.getByText(title, { exact: true }).click();

  await page.getByRole('button', { name: 'Execute task' }).click();
  await expect(page.getByText('Task executed')).toBeVisible();
  await page.getByRole('button', { name: 'Open conversation' }).click();
  const running = page.getByLabel('Live agent activity');
  await expect(running).toBeVisible();
  const runId = await page.evaluate(() => {
    const request = performance.getEntriesByType('resource').map((entry) => entry.name).find((url) => /\/api\/work-items\/[^/]+\/execute$/.test(url));
    return request?.match(/work-items\/([^/]+)\/execute$/)?.[1] ?? null;
  });
  expect(runId).not.toBeNull();
  const detail = await page.request.get(`/api/work-items/${runId}`);
  const { runs } = await detail.json();
  const finished = await page.request.post('/api/e2e/complete-run', { data: { runId: runs[0].id, output: 'Implemented the reconnect retry guard.' } });
  expect(finished.ok()).toBe(true);
  await expect(page.getByText('Implemented the reconnect retry guard.')).toBeVisible();
});

test('shows a stable execution error when the agent service rejects the run', async ({ page, request }, testInfo) => {
  const title = `E2E rejected run ${testInfo.project.name}-${Date.now().toString(36)}`;
  const created = await request.post('/api/work-items', { data: { title, description: '', status: 'ready', projectName: null, dueDate: null } });
  const { item } = await created.json();
  await page.route(`**/api/work-items/${item.id}/execute`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Agent service is unavailable.' }) }));
  await page.goto(`/tasks/${item.id}`);
  await page.getByRole('button', { name: 'Execute task' }).click();
  await expect(page.getByText('Could not start the run.')).toBeVisible();
  await expect(page.getByText('Agent service is unavailable.')).toBeVisible();
});
