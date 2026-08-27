import { describe, expect, it, vi } from 'vitest';
import { getGitHubPullRequestDiff, getGitHubPullRequestImage, parseGitHubPullRequestUrl } from './github-pull-request-diff.js';

describe('GitHub pull-request diffs', () => {
  it('parses GitHub pull-request URLs and rejects unrelated links', () => {
    expect(parseGitHubPullRequestUrl('https://github.com/writer/workbench/pull/24')).toEqual({ owner: 'writer', repository: 'workbench', number: 24 });
    expect(parseGitHubPullRequestUrl('https://github.com/writer/workbench/issues/24')).toBeNull();
  });

  it('loads PR metadata and patches with the configured GitHub credential', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(input);
      if (endpoint.endsWith('/pulls/24')) return new Response(JSON.stringify({ html_url: 'https://github.com/writer/workbench/pull/24', title: 'Render diffs', number: 24, base: { ref: 'main' }, head: { ref: 'feature/diff' }, changed_files: 2, additions: 8, deletions: 3 }), { status: 200 });
    if (endpoint.includes('page=1')) return new Response(JSON.stringify([{ filename: 'src/a.ts', status: 'modified', additions: 8, deletions: 3, patch: '@@ -1 +1 @@\n-old\n+new' }, { filename: 'image.png', status: 'modified', additions: 0, deletions: 0 }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const diff = await getGitHubPullRequestDiff('https://github.com/writer/workbench/pull/24', { token: 'secret', fetchForPolicy: () => fetchImpl as typeof fetch });
    expect(diff).toMatchObject({ repository: 'writer/workbench', number: 24, baseRef: 'main', headRef: 'feature/diff', changedFiles: 2 });
    expect(diff.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/a.ts', isBinary: false }),
      expect.objectContaining({ path: 'image.png', isBinary: true }),
    ]));
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer secret' }) });
  });

  it('returns one page at a time and exposes a next page for large pull requests', async () => {
    const files = Array.from({ length: 100 }, (_, index) => ({ filename: `src/${index}.ts`, status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new' }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const endpoint = String(input);
      if (endpoint.endsWith('/pulls/24')) return new Response(JSON.stringify({ html_url: 'https://github.com/writer/workbench/pull/24', title: 'Large', number: 24, base: { ref: 'main' }, head: { ref: 'feature/large' }, changed_files: 250, additions: 250, deletions: 0 }), { status: 200 });
      return new Response(JSON.stringify(files), { status: 200 });
    });
    const diff = await getGitHubPullRequestDiff('https://github.com/writer/workbench/pull/24', { token: 'secret', page: 2, fetchForPolicy: () => fetchImpl as typeof fetch });
    expect(diff.files).toHaveLength(100);
    expect(diff.nextPage).toBe(3);
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('page=2'))).toBe(true);
  });

  it('loads image bytes through the authenticated GitHub API for private pull requests', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const endpoint = String(input);
      if (endpoint.endsWith('/pulls/24')) return new Response(JSON.stringify({ html_url: 'https://github.com/writer/workbench/pull/24', title: 'Image', number: 24, base: { ref: 'main' }, head: { ref: 'feature/image' }, changed_files: 1, additions: 0, deletions: 0 }), { status: 200 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const image = await getGitHubPullRequestImage('https://github.com/writer/workbench/pull/24', 'assets/review.png', { token: 'secret', fetchForPolicy: () => fetchImpl as typeof fetch });
    expect(image).toMatchObject({ contentType: 'image/png', body: Buffer.from([1, 2, 3]) });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('/contents/assets/review.png?ref=feature%2Fimage'))).toBe(true);
  });

  it('turns GitHub authorization failures into an actionable error', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    await expect(getGitHubPullRequestDiff('https://github.com/writer/workbench/pull/24', { token: 'secret', fetchForPolicy: () => fetchImpl as typeof fetch })).rejects.toThrow('Reconnect GitHub in Sources');
  });
});
