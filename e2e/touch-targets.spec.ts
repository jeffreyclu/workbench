import { expect, test } from '@playwright/test';

// Apple HIG and WCAG 2.5.5 (AA) both treat 44x44 CSS px as the minimum
// comfortable tap target; below that, mis-taps on a phone become routine.
const MIN_TOUCH_TARGET_PX = 44;

test.describe('phone-viewport touch targets', () => {
  test('keeps task drag handles available when the stack has another page', async ({ page, request }, testInfo) => {
    const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
    const created = await Promise.all(Array.from({ length: 51 }, (_, index) => request.post('/api/work-items', {
      data: {
        title: `Paginated drag task ${index + 1} ${suffix}`,
        description: '',
        status: 'ready',
        projectName: null,
        dueDate: null,
      },
    })));
    for (const response of created) expect(response.ok()).toBe(true);

    await page.goto('/');
    await page.getByRole('textbox', { name: 'Search tasks' }).fill(suffix);
    const firstTask = page.getByRole('listitem').filter({ hasText: suffix }).first();
    await expect(firstTask).toBeVisible();

    // A second page may exist, but the loaded task still has a valid server-side
    // neighbor and must be sortable instead of degrading to a static rank.
    const handle = firstTask.getByRole('button', { name: /^Reorder Paginated drag task/ });
    await expect(handle).toBeVisible();
    const firstTaskId = await firstTask.getAttribute('data-work-item-id');

    const thirdTask = page.getByRole('listitem').filter({ hasText: suffix }).nth(2);
    await expect(thirdTask).toBeVisible();
    const handleBox = await handle.boundingBox();
    const targetBox = await thirdTask.boundingBox();
    expect(handleBox).not.toBeNull();
    expect(targetBox).not.toBeNull();

    const savedOrder = page.waitForRequest((outgoing) => outgoing.method() === 'PUT'
      && new URL(outgoing.url()).pathname === '/api/queue/order'
      && outgoing.postDataJSON().itemId === firstTaskId);
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2 + 12);
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
    await page.mouse.up();

    expect((await savedOrder).postDataJSON()).toEqual(expect.objectContaining({ itemId: firstTaskId }));
  });

  test('persists a pointer drag in the Workbench stack', async ({ page, request }, testInfo) => {
    const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
    const created = await Promise.all([
      { position: 'first', status: 'ready' },
      { position: 'second', status: 'backlog' },
      { position: 'third', status: 'backlog' },
    ].map(({ position, status }) => request.post('/api/work-items', {
      data: {
        title: `Workbench drag ${position} ${suffix}`,
        description: '',
        status,
        projectName: 'Workbench',
        dueDate: null,
      },
    })));
    for (const response of created) expect(response.ok()).toBe(true);

    await page.goto('/workbench');
    await page.getByRole('textbox', { name: 'Search tasks' }).fill(suffix);
    const tasks = page.getByRole('listitem').filter({ hasText: suffix });
    const firstTask = tasks.first();
    const targetTask = tasks.last();
    const handle = firstTask.getByRole('button', { name: /^Reorder / });
    await expect(handle).toBeVisible();
    await expect(targetTask).toBeVisible();
    const firstTaskId = await firstTask.getAttribute('data-work-item-id');
    const targetTaskId = await targetTask.getAttribute('data-work-item-id');
    const handleBox = await handle.boundingBox();
    const targetBox = await targetTask.boundingBox();
    expect(handleBox).not.toBeNull();
    expect(targetBox).not.toBeNull();

    let releaseResponse = () => {};
    let markRequestPersisted = () => {};
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const requestPersisted = new Promise<void>((resolve) => { markRequestPersisted = resolve; });
    await page.route('**/api/queue/order', async (route) => {
      if (route.request().method() !== 'PUT' || route.request().postDataJSON().itemId !== firstTaskId) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      markRequestPersisted();
      await responseGate;
      await route.fulfill({ response });
    });
    const savedOrder = page.waitForResponse((incoming) => incoming.request().method() === 'PUT'
      && new URL(incoming.url()).pathname === '/api/queue/order'
      && incoming.request().postDataJSON().itemId === firstTaskId);
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2 + 12);
    await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height - 4, { steps: 8 });
    try {
      await page.mouse.up();
      await requestPersisted;
      const optimisticIds = await tasks.evaluateAll((cards) => cards.map((card) => card.getAttribute('data-work-item-id')));
      expect(optimisticIds.indexOf(firstTaskId)).toBeGreaterThan(optimisticIds.indexOf(targetTaskId));
      expect(await firstTask.evaluate((card) => card.getAnimations().filter((animation) => animation instanceof CSSTransition).length)).toBe(0);
    } finally {
      releaseResponse();
    }
    const saved = await savedOrder;
    expect(saved.ok()).toBe(true);
    expect(saved.request().postDataJSON()).toEqual(expect.objectContaining({ itemId: firstTaskId, stack: 'workbench' }));
    // A manual drop lands in its persisted slot. The separate FLIP motion is
    // reserved for automatic, server-driven reorders.
    expect(await firstTask.evaluate((card) => getComputedStyle(card).transitionProperty)).not.toContain('transform');
    const returnedItems = (await saved.json()) as { items: Array<{ id: string }> };
    const savedIds = returnedItems.items.map((item) => item.id);
    // The visible Attention section can contain ready and backlog work. Verify
    // the persisted order across that status boundary, not merely that a
    // request was made.
    expect(savedIds.indexOf(firstTaskId!)).toBeGreaterThan(savedIds.indexOf(targetTaskId!));
  });

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

  test('conversation stack rows never overlap when cards use their shared height', async ({ page, request }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
    const titles = Array.from({ length: 4 }, (_, index) => `A deliberately long conversation title ${index + 1} ${suffix} that wraps to two lines`);
    const created = await Promise.all(titles.map(async (title) => {
      const response = await request.post('/api/shared/conversations', { data: { title } });
      expect(response.ok()).toBe(true);
      return response.json() as Promise<{ conversation: { id: string } }>;
    }));

    await page.goto(`/conversations/${created[0].conversation.id}`);
    await expect(page.locator('.conversation-tabs').getByText('Attention stack', { exact: true })).toBeVisible();

    const overlaps = await page.locator('.conversation-tabs .virtual-row').evaluateAll((rows) => rows.slice(0, -1).map((row, index) => {
      const current = row.getBoundingClientRect();
      const next = rows[index + 1].getBoundingClientRect();
      return { currentBottom: current.bottom, nextTop: next.top };
    }).filter(({ currentBottom, nextTop }) => nextTop < currentBottom));

    expect(overlaps).toEqual([]);
  });
});
