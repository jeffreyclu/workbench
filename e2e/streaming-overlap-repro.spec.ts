import { expect, test } from '@playwright/test';

test('repro: bubbles overlap while a message is streaming', async ({ page }) => {
  const created = await page.request.post('/api/shared/conversations', { data: { title: 'Overlap repro' } });
  const { conversation } = await created.json();

  const seeds = [
    { author: 'jeffrey', status: 'completed', body: 'first message ' + 'x'.repeat(200) },
    { author: 'claude', status: 'completed', body: 'second message ' + 'y'.repeat(200) },
    { author: 'jeffrey', status: 'completed', body: 'third message ' + 'z'.repeat(200) },
    { author: 'codex', status: 'running', body: 'streaming output so far ' + 'w'.repeat(300) },
  ];
  for (const seed of seeds) {
    const posted = await page.request.post('/api/e2e/seed-message', { data: { conversationId: conversation.id, ...seed } });
    expect(posted.ok()).toBeTruthy();
  }

  await page.goto(`/conversations/${conversation.id}`);
  await expect(page.locator('.shared-message').first()).toBeVisible();
  await page.locator('.shared-thread').evaluate((thread) => thread.scrollTo(0, thread.scrollHeight));
  await page.waitForTimeout(500);

  const boxes = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.shared-message')).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent?.slice(0, 30), top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    });
  });
  console.log(JSON.stringify(boxes, null, 2));

  let overlapping = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const verticalOverlap = a.top < b.bottom - 2 && b.top < a.bottom - 2;
      if (verticalOverlap) {
        overlapping++;
        console.log('OVERLAP between', a.text, 'and', b.text);
      }
    }
  }
  expect(overlapping, `found ${overlapping} overlapping bubble pairs:\n${JSON.stringify(boxes, null, 2)}`).toBe(0);
});

test('repro: bubbles overlap during running -> completed transition', async ({ page }) => {
  const created = await page.request.post('/api/shared/conversations', { data: { title: 'Overlap transition repro' } });
  const { conversation } = await created.json();

  const seeds = [
    { author: 'jeffrey', status: 'completed', body: 'first message ' + 'x'.repeat(200) },
    { author: 'claude', status: 'completed', body: 'second message ' + 'y'.repeat(200) },
    { author: 'jeffrey', status: 'completed', body: 'third message ' + 'z'.repeat(200) },
    { author: 'codex', status: 'running', body: 'streaming...' },
  ];
  let runningId;
  for (const seed of seeds) {
    const posted = await page.request.post('/api/e2e/seed-message', { data: { conversationId: conversation.id, ...seed } });
    expect(posted.ok()).toBeTruthy();
    if (seed.status === 'running') {
      const { message } = await posted.json();
      runningId = message.id;
    }
  }

  await page.goto(`/conversations/${conversation.id}`);
  await expect(page.locator('.shared-message').first()).toBeVisible();
  await page.locator('.shared-thread').evaluate((thread) => thread.scrollTo(0, thread.scrollHeight));
  await page.waitForTimeout(500);

  // Simulate the stream finishing with a much longer, multi-section completed body.
  const completedBody = Array.from({ length: 20 }, (_, i) => `Section ${i}: ` + 'q'.repeat(80)).join('\n\n');
  const updated = await page.request.post('/api/e2e/update-message', {
    data: { id: runningId, status: 'completed', body: completedBody },
  });
  expect(updated.ok()).toBeTruthy();

  // Sample bounding rects across several frames right after the transition to catch a transient overlap.
  const samples = await page.evaluate(async () => {
    const results = [];
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const boxes = Array.from(document.querySelectorAll('.shared-message')).map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent?.slice(0, 30), top: r.top, bottom: r.bottom };
      });
      results.push(boxes);
    }
    return results;
  });

  let overlapping = 0;
  let overlapFrame = -1;
  let overlapDetail = '';
  for (let f = 0; f < samples.length; f++) {
    const boxes = samples[f];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const verticalOverlap = a.top < b.bottom - 2 && b.top < a.bottom - 2;
        if (verticalOverlap) {
          overlapping++;
          if (overlapFrame === -1) {
            overlapFrame = f;
            overlapDetail = `frame ${f}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
          }
        }
      }
    }
  }
  expect(overlapping, `found ${overlapping} overlapping bubble-pair-frames; first at ${overlapDetail}`).toBe(0);
});
