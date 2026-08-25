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

test('repro: large gap appears after interjecting a message while another is streaming', async ({ page }) => {
  // Mirrors the "interject repro message while running" scenario: a short
  // prior message, then a reply that streams in over several chunks (each
  // chunk changes the row's threadLayoutSignature), then settles.
  await page.setViewportSize({ width: 800, height: 500 });
  const created = await page.request.post('/api/shared/conversations', { data: { title: 'Gap repro' } });
  const { conversation } = await created.json();

  // Enough tall prior messages (and a small viewport) that the virtualizer's
  // own "in range" window is narrow, so clearing its whole itemSizeCache on
  // every streamed chunk leaves rows outside that window stuck at the 220px
  // estimate instead of their real (much taller) heights.
  const priorSeeds = Array.from({ length: 10 }, (_, i) => ({
    author: i % 2 === 0 ? 'jeffrey' : 'claude',
    status: 'completed',
    body: `filler message ${i} ` + 'x'.repeat(600),
  }));
  priorSeeds.push({ author: 'jeffrey', status: 'completed', body: 'interject repro message while running' });
  for (const seed of priorSeeds) {
    const posted = await page.request.post('/api/e2e/seed-message', { data: { conversationId: conversation.id, ...seed } });
    expect(posted.ok()).toBeTruthy();
  }

  const runningSeed = await page.request.post('/api/e2e/seed-message', {
    data: { conversationId: conversation.id, author: 'claude', status: 'running', body: 'Working on it' },
  });
  expect(runningSeed.ok()).toBeTruthy();
  const { message: runningMessage } = await runningSeed.json();

  await page.goto(`/conversations/${conversation.id}`);
  await expect(page.locator('.shared-message').first()).toBeVisible();
  await page.locator('.shared-thread').evaluate((thread) => thread.scrollTo(0, thread.scrollHeight));

  // Simulate several streamed chunks arriving while the message is running,
  // which repeatedly changes threadLayoutSignature before it settles.
  let streamedBody = 'Working on it';
  for (let i = 0; i < 8; i++) {
    streamedBody += ` chunk-${i} ` + 'a'.repeat(40);
    const chunkUpdate = await page.request.post('/api/e2e/update-message', {
      data: { id: runningMessage.id, status: 'running', body: streamedBody },
    });
    expect(chunkUpdate.ok()).toBeTruthy();
    await page.waitForTimeout(50);
  }

  const finalUpdate = await page.request.post('/api/e2e/update-message', {
    data: { id: runningMessage.id, status: 'completed', body: streamedBody + ' final chunk' },
  });
  expect(finalUpdate.ok()).toBeTruthy();

  // Sample across several frames right after the running -> completed
  // transition (the flow-mode -> virtualized-mode switch): if the
  // itemSizeCache is stale/corrupted for the interjected row at the instant
  // the switch happens, the gap should show up transiently even if a
  // subsequent `.measure()` self-corrects it a frame or two later.
  const samples = await page.evaluate(async () => {
    const results = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const boxes = Array.from(document.querySelectorAll('.shared-message')).map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent?.slice(0, 60), top: r.top, bottom: r.bottom };
      });
      results.push(boxes);
    }
    return results;
  });

  let worstGap = -Infinity;
  let worstFrame = -1;
  let worstDetail = '';
  for (let f = 0; f < samples.length; f++) {
    const sorted = [...samples[f]].sort((a, b) => a.top - b.top);
    const interjectedIndex = sorted.findIndex((box) => box.text?.includes('interject repro message'));
    if (interjectedIndex === -1 || interjectedIndex + 1 >= sorted.length) continue;
    const interjected = sorted[interjectedIndex];
    const streamed = sorted[interjectedIndex + 1];
    const gap = streamed.top - interjected.bottom;
    if (gap > worstGap) {
      worstGap = gap;
      worstFrame = f;
      worstDetail = JSON.stringify(sorted, null, 2);
    }
  }
  expect(worstFrame, 'never found both the interjected message and a following message rendered together').toBeGreaterThanOrEqual(0);
  expect(worstGap, `largest gap between the interjected message and the streamed reply was ${worstGap}px at frame ${worstFrame}:\n${worstDetail}`).toBeLessThan(60);
});
