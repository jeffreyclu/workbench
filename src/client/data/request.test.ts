import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './request';
import { sourceClient } from './source-client';
import { taskClient } from './task-client';

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  it('merges JSON and caller headers, and forwards abort signals', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/api/test', { headers: { Authorization: 'Bearer test' }, signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith('/api/test', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
      signal: controller.signal,
    }));
  });

  it('returns undefined for 204 responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(request<void>('/api/test', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('keeps JSON API errors stable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'No access' }), { status: 403, headers: { 'Content-Type': 'application/json' } })));
    await expect(request('/api/test')).rejects.toThrow('No access');
  });

  it('formats non-JSON API errors and rejects unexpected successful bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(' gateway   unavailable ', { status: 502, statusText: 'Bad Gateway' })));
    await expect(request('/api/test')).rejects.toThrow('Request failed (502): gateway unavailable');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html />', { status: 200, headers: { 'Content-Type': 'text/html' } })));
    await expect(request('/api/test')).rejects.toThrow('The API returned an invalid response. Refresh the preview and try again.');
  });
});

describe('domain-client contracts', () => {
  it('preserves work item query, filter, and cursor encoding', async () => {
    let requestedPath = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedPath = String(input);
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await taskClient.listWorkItems('active', 'ignored', 'page + 1', {
      projectNames: ['A & B'], statuses: [], assignees: [], sources: [], labels: [], dueStates: [], query: '',
    });

    const url = new URL(requestedPath, 'http://localhost');
    expect(url.pathname).toBe('/api/work-items');
    expect(url.searchParams.get('view')).toBe('active');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('cursor')).toBe('page + 1');
    expect(JSON.parse(url.searchParams.get('filter') ?? '')).toEqual(expect.objectContaining({ projectNames: ['A & B'] }));
  });

  it('forwards source-search abort signals and request body', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await sourceClient.searchSources('roadmap', ['figma'], controller.signal);

    expect(fetchMock).toHaveBeenCalledWith('/api/sources/search', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ query: 'roadmap', sources: ['figma'] }), signal: controller.signal,
    }));
  });
});
