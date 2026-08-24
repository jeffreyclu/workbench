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

  test('Archive stays tappable and selected after opening an archived conversation', async ({ page, request }, testInfo) => {
    const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
    const activeTitle = `Active pointer target ${suffix}`;
    const archivedTitle = `Archived pointer target ${suffix}`;
    const activeResponse = await request.post('/api/shared/conversations', { data: { title: activeTitle } });
    expect(activeResponse.ok()).toBe(true);
    const active = (await activeResponse.json()).conversation as { id: string; title: string };

    const archivedResponse = await request.post('/api/shared/conversations', { data: { title: archivedTitle } });
    expect(archivedResponse.ok()).toBe(true);
    const archived = (await archivedResponse.json()).conversation as { id: string; title: string };
    const archiveResponse = await request.post(`/api/shared/conversations/${archived.id}/archive`);
    expect(archiveResponse.ok()).toBe(true);

    await page.goto(`/conversations/${active.id}`);
    await page.getByRole('button', { name: 'Show conversations' }).click();

    const archiveView = page.getByRole('group', { name: 'Conversation view' }).getByRole('button', { name: 'Archive', exact: true });
    await expect(archiveView).toBeVisible();
    const archiveBox = await archiveView.boundingBox();
    expect(archiveBox).not.toBeNull();
    expect(archiveBox!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    await archiveView.click();

    await expect(archiveView).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: new RegExp(archived.title) })).toBeVisible();
    await page.getByRole('button', { name: new RegExp(archived.title) }).click();
    await expect(page).toHaveURL(new RegExp(`/conversations/${archived.id}$`));

    await page.getByRole('button', { name: 'Show conversations' }).click();
    const archiveViewAfterSelection = page.getByRole('button', { name: 'Archive', exact: true });
    await expect(archiveViewAfterSelection).toHaveAttribute('aria-pressed', 'true');
    const repeatedArchiveRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/shared/conversations' && url.searchParams.get('view') === 'archive';
    });
    await archiveViewAfterSelection.click();
    await repeatedArchiveRequest;

    await expect(archiveViewAfterSelection).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(new RegExp(`/conversations/${archived.id}$`));
    await expect(page.getByRole('heading', { name: archived.title })).toBeVisible();
  });

  test('the expanded desktop navigation cannot cover any part of Archive', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
    const activeResponse = await request.post('/api/shared/conversations', { data: { title: `Desktop active ${suffix}` } });
    expect(activeResponse.ok()).toBe(true);
    const active = (await activeResponse.json()).conversation as { id: string };

    await page.goto(`/conversations/${active.id}`);
    const primaryConversations = page.locator('#primary-nav').getByRole('button', { name: /Conversations/ });
    await primaryConversations.click();
    await expect(page.locator('#primary-nav')).toHaveCSS('width', '220px');

    const archiveView = page.getByRole('group', { name: 'Conversation view' }).getByRole('button', { name: 'Archive', exact: true });
    await expect(archiveView).toBeVisible();
    const exposedPoints = await archiveView.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const inset = 2;
      const points = [
        [rect.left + inset, rect.top + inset],
        [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset],
        [rect.right - inset, rect.bottom - inset],
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
      ];
      return points.map(([x, y]) => document.elementFromPoint(x, y)?.closest('button') === button);
    });
    expect(exposedPoints).toEqual([true, true, true, true, true]);

    await archiveView.click();
    await expect(archiveView).toHaveAttribute('aria-pressed', 'true');
  });
});
