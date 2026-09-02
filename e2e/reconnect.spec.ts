import { expect, test } from '@playwright/test';

test('warns that cached data is being shown while the browser reports it is offline', async ({ page }) => {
  await page.goto('/');
  await page.context().setOffline(true);
  await expect(page.getByText('Offline — showing cached data')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'Retry now' })).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.getByText('Offline — showing cached data')).toBeHidden({ timeout: 5_000 });
});

test('warns that cached data is being shown while the realtime connection reconnects', async ({ page }) => {
  await page.routeWebSocket('**/api/realtime', (socket) => socket.close());
  await page.goto('/');
  await expect(page.getByText('Reconnecting… showing cached data')).toBeVisible({ timeout: 5_000 });
});

test('falls back to HTTPS polling when reconnect attempts stay unavailable', async ({ page }) => {
  await page.routeWebSocket('**/api/realtime', (socket) => socket.close());
  await page.goto('/');
  await expect(page.getByText('Live agent updates are polling over HTTPS')).toBeVisible({ timeout: 12_000 });
});

test('retry now triggers an immediate reconnect attempt instead of waiting on backoff', async ({ page }) => {
  let connectionAttempts = 0;
  await page.routeWebSocket('**/api/realtime', (socket) => {
    connectionAttempts += 1;
    socket.close();
  });
  await page.goto('/');
  await expect(page.getByText('Reconnecting… showing cached data')).toBeVisible({ timeout: 5_000 });

  const attemptsBeforeRetry = connectionAttempts;
  await page.getByRole('button', { name: 'Retry now' }).click();
  await expect.poll(() => connectionAttempts, { timeout: 2_000 }).toBeGreaterThan(attemptsBeforeRetry);
});
