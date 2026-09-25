import { expect, test } from '@playwright/test';

test('every agent run in the conversation shows an elapsed timer that ticks live and freezes on completion', async ({ page }) => {
  const created = await page.request.post('/api/shared/conversations', { data: { title: 'Elapsed timer' } });
  const { conversation } = await created.json();

  await page.request.post('/api/e2e/seed-message', { data: { conversationId: conversation.id, author: 'jeffrey', status: 'completed', body: 'Run something' } });
  const posted = await page.request.post('/api/e2e/seed-message', { data: { conversationId: conversation.id, author: 'claude', status: 'running', body: 'working…' } });
  const { message: running } = await posted.json();

  await page.goto(`/conversations/${conversation.id}`);
  const reply = page.locator(`[data-message-id="${running.id}"]`);
  const liveTimer = reply.locator('.run-elapsed-timer.running');
  await expect(liveTimer).toBeVisible();
  // Jeffrey's own message is not an agent run and gets no timer.
  await expect(page.locator('.shared-jeffrey .run-elapsed-timer')).toHaveCount(0);

  const firstReading = await liveTimer.textContent();
  await expect(liveTimer).not.toHaveText(firstReading ?? '', { timeout: 5_000 });

  const updated = await page.request.post('/api/e2e/update-message', { data: { id: running.id, status: 'completed', body: 'Done.' } });
  expect(updated.ok()).toBeTruthy();

  const finalTimer = reply.locator('.run-elapsed-timer:not(.running)');
  await expect(finalTimer).toBeVisible();
  await expect(finalTimer).toHaveAttribute('aria-label', /^Run took \d+s$/);
  const finalReading = await finalTimer.textContent();
  await page.waitForTimeout(2_000);
  await expect(finalTimer).toHaveText(finalReading ?? '');
});
