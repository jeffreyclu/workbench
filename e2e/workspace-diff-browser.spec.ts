import { expect, test } from '@playwright/test';

const REPOSITORY_A = '/tmp/e2e-repository-a';
const REPOSITORY_B = '/tmp/e2e-repository-b';

function diff(workspacePath: string) {
  const repository = workspacePath === REPOSITORY_A ? 'repository-a' : 'repository-b';
  const path = `src/${repository}.ts`;
  return {
    workspacePath,
    branch: `${repository}-branch`,
    revision: `${repository}-revision`,
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    publish: { branch: `${repository}-branch`, hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
    files: [{ path, editorUrl: null, previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: `@@ -1 +1 @@\n-before\n+${repository}-change` }],
  };
}

test('switching repositories replaces the complete diff document', async ({ page, request }, testInfo) => {
  const created = await request.post('/api/work-items', { data: { title: `E2E repository browser ${testInfo.project.name}-${Date.now().toString(36)}`, description: '', status: 'ready', projectName: null, workspacePath: null, dueDate: null } });
  const { item } = await created.json();
  const diffReads: string[] = [];

  await page.route(`**/api/work-items/${item.id}/workspaces{,/**}`, async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ json: { selectedPath: REPOSITORY_B, workspaces: [] } });
      return;
    }
    await route.fulfill({ json: { selectedPath: REPOSITORY_A, workspaces: [
      { path: REPOSITORY_A, label: 'repository-a', selected: true },
      { path: REPOSITORY_B, label: 'repository-b', selected: false },
    ] } });
  });
  await page.route(`**/api/work-items/${item.id}/workspace-diff**`, async (route) => {
    const url = new URL(route.request().url());
    const workspacePath = url.searchParams.get('workspacePath') ?? '';
    diffReads.push(url.pathname + url.search);
    if (url.pathname.endsWith('/snapshots')) await route.fulfill({ json: { snapshots: [] } });
    else if (url.pathname.endsWith('/refs')) await route.fulfill({ json: { refs: { base: 'main', branches: [], worktrees: [] } } });
    else if (url.pathname.endsWith('/ref/commits')) await route.fulfill({ json: { commits: [] } });
    else await route.fulfill({ json: { diff: diff(workspacePath) } });
  });

  await page.goto(`/tasks/${item.id}`);
  await page.getByText('Workspace review').click();
  await expect(page.getByRole('heading', { name: 'repository-a-branch' })).toBeVisible();
  await expect(page.getByText('src/repository-a.ts', { exact: true })).toHaveCount(2);

  await page.getByRole('combobox', { name: 'Repository' }).selectOption(REPOSITORY_B);
  await expect(page.getByRole('heading', { name: 'repository-b-branch' })).toBeVisible();
  await expect(page.getByText('src/repository-b.ts', { exact: true })).toHaveCount(2);
  await expect(page.getByText('src/repository-a.ts', { exact: true })).toHaveCount(0);
  expect(diffReads.some((url) => url.includes(`workspacePath=${encodeURIComponent(REPOSITORY_A)}`))).toBe(true);
  expect(diffReads.some((url) => url.includes(`workspacePath=${encodeURIComponent(REPOSITORY_B)}`))).toBe(true);
  expect(diffReads.every((url) => url.includes('workspacePath='))).toBe(true);
});
