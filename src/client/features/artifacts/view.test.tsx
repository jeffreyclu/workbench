// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactLibraryView } from './view';
import { versionUrl } from './artifact-url';
import { getToasts, toast } from '../../state/toast-store';

const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');

afterEach(() => {
  cleanup();
  toast.clear();
  vi.unstubAllGlobals();
  if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor);
  else Reflect.deleteProperty(document, 'execCommand');
});

const artifact = {
  id: 'abc123',
  title: 'Connector rollout',
  url: 'https://artifacts.example.com/abc123/',
  sourcePath: '/Users/jeffrey.lu/notes/rollout.md',
  version: 2,
  versionCount: 2,
  workItemId: '00000000-0000-4000-8000-000000000001',
  workItemTitle: 'Ship connectors V2',
  conversationId: '00000000-0000-4000-8000-000000000002',
  conversationTitle: 'Rollout review',
  publishedAt: '2026-08-20T12:00:00.000Z',
  revokedAt: null,
  favoritedAt: null,
  commentCount: 1,
  openCommentCount: 1,
};

const detail = {
  artifact,
  versions: [
    { id: 'version-2', artifactId: 'abc123', version: 2, title: 'Connector rollout', url: artifact.url, contentHash: 'hash-b', note: '', publishedAt: '2026-08-20T12:00:00.000Z' },
    { id: 'version-1', artifactId: 'abc123', version: 1, title: 'Connector rollout', url: artifact.url, contentHash: 'hash-a', note: '', publishedAt: '2026-08-18T12:00:00.000Z' },
  ],
  events: [
    { id: 'event-2', artifactId: 'abc123', kind: 'republished', version: 2, detail: '', createdAt: '2026-08-20T12:00:00.000Z' },
    { id: 'event-1', artifactId: 'abc123', kind: 'published', version: 1, detail: '', createdAt: '2026-08-18T12:00:00.000Z' },
  ],
  comments: [
    { id: 'comment-1', artifactId: 'abc123', version: 2, author: 'Ashley', body: 'The rollout section needs dates.', resolvedAt: null, createdAt: '2026-08-20T13:00:00.000Z' },
  ],
  sourceAvailable: true,
  sourceChanged: false,
};

function stubApi(overrides: { artifacts?: unknown[] } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const artifacts = overrides.artifacts ?? [artifact];
    const body = url.startsWith('/api/artifacts?')
      ? { artifacts, counts: { published: artifacts.length, revoked: 0, favorited: 0, openComments: 1 } }
      : url === '/api/artifacts/abc123' ? detail
      : url.endsWith('/favorite') ? { artifact: { ...artifact, favoritedAt: init?.body ? (JSON.parse(String(init.body)).favorited ? '2026-08-21T09:00:00.000Z' : null) : null } }
      : { artifact };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

function renderLibrary(onOpenTask = vi.fn(), onOpenConversation = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(<QueryClientProvider client={client}><ArtifactLibraryView onOpenTask={onOpenTask} onOpenConversation={onOpenConversation} /></QueryClientProvider>);
  return { onOpenTask, onOpenConversation, ...result };
}

describe('artifact library', () => {
  it('copies an artifact link with the fallback when the Clipboard API is unavailable', async () => {
    stubApi();
    const copy = vi.fn();
    const clearTimeout = vi.spyOn(window, 'clearTimeout');
    vi.stubGlobal('navigator', { clipboard: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
    const { unmount } = renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: /copy link/i }));

    await waitFor(() => expect(copy).toHaveBeenCalledWith('copy'));
    expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy();
    unmount();
    expect(clearTimeout).toHaveBeenCalled();
  });

  it('builds a version URL under the artifact identity', () => {
    expect(versionUrl('https://artifacts.example.com/abc123/', 2)).toBe('https://artifacts.example.com/abc123/v2/');
    expect(versionUrl('https://artifacts.example.com/abc123', 1)).toBe('https://artifacts.example.com/abc123/v1/');
  });

  it('lists a shared artifact with its version, relationships, and open feedback', async () => {
    stubApi();
    const { onOpenTask } = renderLibrary();

    expect(await screen.findByRole('heading', { name: 'Connector rollout' })).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('2 versions')).toBeTruthy();
    expect(screen.getByText('1 open')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ship connectors V2' }));
    expect(onOpenTask).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
  });

  it('opens the conversation an artifact came out of', async () => {
    stubApi();
    const { onOpenConversation } = renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: 'Rollout review' }));
    expect(onOpenConversation).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002');
  });

  it('shows version history, the publication timeline, and coworker feedback on demand', async () => {
    stubApi();
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: /history & feedback/i }));

    expect(await screen.findByRole('link', { name: 'Open version 2' })).toHaveProperty('href', 'https://artifacts.example.com/abc123/v2/');
    expect(screen.getByRole('link', { name: 'Open version 1' })).toHaveProperty('href', 'https://artifacts.example.com/abc123/v1/');
    expect(screen.getByText('Republished')).toBeTruthy();
    expect(screen.getByText('Published')).toBeTruthy();
    expect(screen.getByText('Ashley')).toBeTruthy();
    expect(screen.getByText('The rollout section needs dates.')).toBeTruthy();
  });

  it('keeps comments on the shared page instead of duplicating the composer in Workbench', async () => {
    stubApi();
    renderLibrary();

    await screen.findByRole('link', { name: 'Open' });
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /history & feedback/i }));
    expect(await screen.findByText('The rollout section needs dates.')).toBeTruthy();
    expect(screen.queryByLabelText('Add a note about this artifact')).toBeNull();
  });

  it('reports a failure when resolving feedback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/artifacts?')) return new Response(JSON.stringify({ artifacts: [artifact], counts: { published: 1, revoked: 0, openComments: 1 } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/artifacts/abc123') return new Response(JSON.stringify(detail), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/artifacts/abc123/comments/comment-1' && init?.method === 'PATCH') return new Response(JSON.stringify({ error: 'Comment was already resolved.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: /history & feedback/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(getToasts().map((entry) => entry.message)).toContain('Could not update that comment.'));
  });

  it('republishes an artifact from the library without needing the file path', async () => {
    const calls = stubApi();
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: /republish/i }));

    await waitFor(() => expect(calls.some((call) => call.url === '/api/artifacts/abc123/republish' && call.method === 'POST')).toBe(true));
  });

  it('uses the app dialog before revoking, because the link stops working for everyone', async () => {
    const calls = stubApi();
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: /^Revoke$/ }));
    expect(await screen.findByRole('dialog', { name: 'Revoke this shared artifact?' })).toBeTruthy();
    expect(screen.getByText('The link stops working for everyone.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /^Revoke$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke artifact' }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/artifacts/abc123' && call.method === 'DELETE')).toBe(true));
  });

  it('favorites an artifact from the library', async () => {
    const calls = stubApi();
    renderLibrary();

    const toggle = await screen.findByRole('button', { name: 'Favorite artifact' });
    fireEvent.click(toggle);

    await waitFor(() => expect(calls.some((call) => call.url === '/api/artifacts/abc123/favorite' && call.method === 'PATCH')).toBe(true));
  });

  it('offers a restore instead of a republish once an artifact is revoked', async () => {
    stubApi({ artifacts: [{ ...artifact, revokedAt: '2026-08-20T15:00:00.000Z' }] });
    renderLibrary();

    expect(await screen.findByRole('button', { name: /restore/i })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open/i })).toBeNull();
    expect(screen.getByText('revoked')).toBeTruthy();
  });

  it('explains the empty library instead of showing a blank page', async () => {
    stubApi({ artifacts: [] });
    renderLibrary();

    expect(await screen.findByRole('heading', { name: 'No shared artifacts yet' })).toBeTruthy();
  });
});

describe('artifact library requests', () => {
  it('asks for live artifacts first and switches views on demand', async () => {
    const calls = stubApi();
    renderLibrary();

    await waitFor(() => expect(calls.some((call) => call.url === '/api/artifacts?view=published')).toBe(true));
    const tablist = await screen.findByRole('tablist', { name: 'Artifact view' });
    const revoked = within(tablist).getByRole('tab', { name: /revoked/i });
    expect(revoked).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(revoked);
    expect(revoked).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', revoked.id);
    await waitFor(() => expect(calls.some((call) => call.url === '/api/artifacts?view=revoked')).toBe(true));

    const favorites = within(tablist).getByRole('tab', { name: /favorites/i });
    fireEvent.click(favorites);
    await waitFor(() => expect(calls.some((call) => call.url === '/api/artifacts?view=favorites')).toBe(true));
  });
});
