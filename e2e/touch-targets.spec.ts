import { expect, test } from '@playwright/test';

// Apple HIG and WCAG 2.5.5 (AA) both treat 44x44 CSS px as the minimum
// comfortable tap target; below that, mis-taps on a phone become routine.
const MIN_TOUCH_TARGET_PX = 44;

test.describe('phone-viewport touch targets', () => {
  test('the bottom navigation tabs are each at least 44x44', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('#primary-nav nav');
    await expect(nav).toBeVisible();

    const tabs = nav.locator('> .nav-item');
    const count = await tabs.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const box = await tabs.nth(index).boundingBox();
      expect(box, `nav tab ${index} has a bounding box`).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
  });

  test('the "more destinations" toggle meets the minimum tap target', async ({ page }) => {
    await page.goto('/');
    const moreToggle = page.locator('.nav-item.mobile-nav-more');
    await expect(moreToggle).toBeVisible();

    const box = await moreToggle.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    await moreToggle.click();
    const secondaryItems = page.locator('#mobile-nav-more .nav-item');
    const count = await secondaryItems.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const itemBox = await secondaryItems.nth(index).boundingBox();
      expect(itemBox).not.toBeNull();
      expect(itemBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
  });
});
