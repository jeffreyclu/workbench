import { expect, test } from '@playwright/test';

test('loads and mutates Workbench state without browser REST traffic', async ({ page }, testInfo) => {
  const applicationHttpRequests: string[] = [];
  const sockets: string[] = [];
  const socketRequests: Array<{ operation?: string; input?: { method?: string; path?: string } }> = [];
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    if (['fetch', 'xhr', 'eventsource'].includes(resourceType) && new URL(request.url()).pathname.startsWith('/api/')) {
      applicationHttpRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  page.on('websocket', (socket) => {
    sockets.push(socket.url());
    socket.on('framesent', (frame) => {
      if (typeof frame.payload !== 'string') return;
      try {
        const payload = JSON.parse(frame.payload) as { type?: string; operation?: string; input?: { method?: string; path?: string } };
        if (payload.type === 'request') socketRequests.push(payload);
      } catch { /* Ignore WebSocket control/non-JSON frames. */ }
    });
  });

  const title = `Socket-only task ${testInfo.project.name}-${Date.now().toString(36)}`;
  await page.goto('/');
  await page.getByRole('button', { name: /add task|new task/i }).click();
  await page.getByRole('button', { name: 'Manual task' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await page.getByRole('listitem').filter({ hasText: title }).evaluate((row) => (row as HTMLElement).click());

  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const detailPath = socketRequests.find((request) => request.input?.method === 'GET' && /^\/api\/work-items\/[^/?]+$/.test(request.input.path ?? ''))?.input?.path;
  expect(detailPath).toBeTruthy();

  await page.getByRole('button', { name: 'Attention stack' }).click();
  await page.getByRole('list', { name: 'Work stacks' }).getByText(title, { exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  expect(socketRequests.filter((request) => request.input?.method === 'GET' && request.input.path === detailPath)).toHaveLength(1);
  expect(sockets.some((url) => new URL(url).pathname === '/api/realtime')).toBe(true);
  expect(applicationHttpRequests).toEqual([]);
});
