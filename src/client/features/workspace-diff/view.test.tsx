// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDiffView } from './view.js';

const REPOSITORY_A = '/tmp/repository-a';
const REPOSITORY_B = '/tmp/repository-b';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function file(path: string, value: string) {
  return {
    path,
    editorUrl: null,
    previousPath: null,
    status: 'modified' as const,
    additions: 1,
    deletions: 1,
    isBinary: false,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+${value}`,
  };
}

function diff(workspacePath: string, changedFile: ReturnType<typeof file>) {
  return {
    workspacePath,
    branch: workspacePath === REPOSITORY_A ? 'repository-a-branch' : 'repository-b-branch',
    revision: `revision:${workspacePath}`,
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null },
    files: [changedFile],
  };
}

function installFetch(options: { repositoryA?: Promise<Response> } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://workbench.test');
    if (url.pathname.endsWith('/workspaces/selection') && init?.method === 'PUT') {
      const selectedPath = JSON.parse(String(init.body)).workspacePath as string;
      return response({ selectedPath, workspaces: [] });
    }
    if (url.pathname.endsWith('/workspaces')) {
      return response({
        selectedPath: REPOSITORY_A,
        workspaces: [
          { path: REPOSITORY_A, label: 'repository-a', selected: true },
          { path: REPOSITORY_B, label: 'repository-b', selected: false },
        ],
      });
    }
    if (url.pathname.endsWith('/workspace-diff/snapshots')) return response({ snapshots: [] });
    if (url.pathname.endsWith('/workspace-diff/refs')) return response({ refs: { base: 'main', branches: [{ name: 'feature', current: true, ahead: 1 }], worktrees: [] } });
    if (url.pathname.endsWith('/workspace-diff/ref/commits')) return response({ commits: [] });
    if (url.pathname.endsWith('/workspace-diff/ref')) return response({ diff: diff(url.searchParams.get('workspacePath') ?? '', file('src/branch.ts', 'branch-change')) });
    if (url.pathname.endsWith('/workspace-diff')) {
      const workspacePath = url.searchParams.get('workspacePath') ?? '';
      if (workspacePath === REPOSITORY_A && options.repositoryA) return options.repositoryA;
      const changedFile = workspacePath === REPOSITORY_A ? file('src/repository-a.ts', 'repository-a-change') : file('src/repository-b.ts', 'repository-b-change');
      return response({ diff: diff(workspacePath, changedFile) });
    }
    throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ conversationId: 'conversation-1' }} /></QueryClientProvider>);
}

describe('WorkspaceDiffView', () => {
  it('switches repositories and displays only the selected repository document', async () => {
    const fetchMock = installFetch();
    renderView();

    expect(await screen.findAllByText('src/repository-a.ts')).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox', { name: 'Repository' }), { target: { value: REPOSITORY_B } });

    expect(await screen.findAllByText('src/repository-b.ts')).toHaveLength(2);
    expect(screen.queryAllByText('src/repository-a.ts')).toHaveLength(0);
    const diffRequests = fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => url.includes('/workspace-diff?'));
    expect(diffRequests.some((url) => url.includes('workspacePath=%2Ftmp%2Frepository-a'))).toBe(true);
    expect(diffRequests.some((url) => url.includes('workspacePath=%2Ftmp%2Frepository-b'))).toBe(true);
  });

  it('does not let a late response from the previous repository repaint the view', async () => {
    let resolveRepositoryA!: (value: Response) => void;
    const repositoryA = new Promise<Response>((resolve) => { resolveRepositoryA = resolve; });
    installFetch({ repositoryA });
    renderView();

    const selector = await screen.findByRole('combobox', { name: 'Repository' });
    fireEvent.change(selector, { target: { value: REPOSITORY_B } });
    expect(await screen.findAllByText('src/repository-b.ts')).toHaveLength(2);

    resolveRepositoryA(response({ diff: diff(REPOSITORY_A, file('src/repository-a.ts', 'late-change')) }));
    await waitFor(() => expect(screen.queryAllByText('src/repository-a.ts')).toHaveLength(0));
    expect(screen.getAllByText('src/repository-b.ts')).toHaveLength(2);
  });

  it('uses the same single-pane browser for branch changes', async () => {
    installFetch();
    const { container } = renderView();
    await screen.findAllByText('src/repository-a.ts');

    fireEvent.click(screen.getByRole('button', { name: 'Branch' }));

    expect(await screen.findAllByText('src/branch.ts')).toHaveLength(2);
    expect(container.querySelector('.workspace-diff-file')?.textContent).toContain('branch-change');
    expect(container.querySelectorAll('.workspace-diff-layout')).toHaveLength(1);
    expect(container.querySelector('.diff-review-layout')).toBeNull();
  });
});
