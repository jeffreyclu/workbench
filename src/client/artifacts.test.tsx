// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactLibraryView } from './artifacts';
import { versionUrl } from './artifact-url';

const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');

afterEach(() => {
  cleanup();
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
      ? { artifacts, counts: { published: artifacts.length, revoked: 0, openComments: 1 } }
      : url === '/api/artifacts/abc123' ? detail
      : { artifact };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  return calls;
}

function renderLibrary(onOpenTask = vi.fn(), onOpenConversation = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ArtifactLibraryView onOpenTask={onOpenTask} onOpenConversation={onOpenConversation} /></QueryClientProvider>);
  return { onOpenTask, onOpenConversation };
}

describe('artifact library', () => {
  it('copies an artifact link with the fallback when the Clipboard API is unavailable', async () => {
    stubApi();
    const copy = vi.fn();
    vi.stubGlobal('navigator', { clipboard: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
    renderLibrary();

    fireEvent.click(await screen.findByRole('button', { name: /copy link/i }));

    await waitFor(() => expect(copy).toHaveBeenCalledWith('copy'));
    expect(screen.getByRole('button', { name: /copied/i })).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: /revoked/i }));
    await waitFor(() => expect(calls.some((call) => call.url === '/api/artifacts?view=revoked')).toBe(true));
  });
});
