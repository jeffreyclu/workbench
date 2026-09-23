import { expect, test } from '@playwright/test';

test('creates a task in the UI, starts an agent, and receives its output', async ({ page }, testInfo) => {
  const title = `E2E agent task ${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto('/');
  await page.getByRole('button', { name: /add task|new task/i }).click();
  await page.getByRole('button', { name: 'Manual task' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Add to queue' }).click();
  const detailHeading = page.getByRole('heading', { name: title });
  // Concurrent server events can reconcile the stack between creation and the
  // navigation effect. Dispatching the selected row's own click is safe even
  // if its detail sheet has already covered the row.
  await page.getByRole('listitem').filter({ hasText: title }).evaluate((row) => (row as HTMLElement).click());
  await expect(detailHeading).toBeVisible();

  await page.getByRole('button', { name: 'Execute task' }).click();
  await expect(page.getByText('Task executed')).toBeVisible();
  await page.getByRole('button', { name: 'Open conversation' }).click();
  const running = page.getByLabel('Live agent activity');
  await expect(running).toBeVisible();
  const list = await page.request.get(`/api/work-items?view=active&query=${encodeURIComponent(title)}`);
  const listed = await list.json();
  const taskId = listed.items.find((item: { title: string }) => item.title === title)?.id as string | undefined;
  expect(taskId).toBeTruthy();
  const detail = await page.request.get(`/api/work-items/${taskId}`);
  const { runs } = await detail.json();
  const finished = await page.request.post('/api/e2e/complete-run', { data: { runId: runs[0].id, output: 'Implemented the reconnect retry guard.' } });
  expect(finished.ok()).toBe(true);
  await expect(page.getByText('Implemented the reconnect retry guard.')).toBeVisible();
});

test('shows a stable execution error when the agent service rejects the run', async ({ page, request }, testInfo) => {
  const title = `E2E rejected run ${testInfo.project.name}-${Date.now().toString(36)}`;
  const created = await request.post('/api/work-items', { data: { title, description: '', status: 'ready', projectName: null, dueDate: null } });
  const { item } = await created.json();
  await page.goto(`/tasks/${item.id}`);
  await page.getByRole('button', { name: 'Execute task' }).click();
  await expect(page.getByText('Could not start the run.')).toBeVisible();
  await expect(page.locator('.detail-panel .error-message')).toHaveText('Agent service is unavailable.');
});
