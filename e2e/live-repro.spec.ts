import { expect, test } from '@playwright/test';

test('live: mutation-observer overlap watch', async ({ page }) => {
  await page.goto('http://localhost:5180/conversations/fb594030-66aa-4414-90a0-167a111a1f66');
  await expect(page.locator('.shared-message').first()).toBeVisible({ timeout: 15000 });

  const result = await page.evaluate(async () => {
    const overlaps: any[] = [];
    const check = () => {
      const boxes = Array.from(document.querySelectorAll('.shared-message')).map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent?.slice(0, 24), top: r.top, bottom: r.bottom };
      });
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (a.top < b.bottom - 2 && b.top < a.bottom - 2) {
            overlaps.push({ a, b, t: performance.now() });
          }
        }
      }
    };
    const thread = document.querySelector('.shared-thread');
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    const ro = new ResizeObserver(check);
    document.querySelectorAll('.shared-message').forEach((el) => ro.observe(el));
    await new Promise((resolve) => setTimeout(resolve, 15000));
    observer.disconnect();
    ro.disconnect();
    return overlaps.slice(0, 10);
  });

  console.log('overlaps found:', JSON.stringify(result, null, 2));
  expect(result.length, JSON.stringify(result)).toBe(0);
});
