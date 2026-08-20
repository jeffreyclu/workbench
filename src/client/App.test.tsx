// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, SharedWorkspace } from './App';
import { hideWorkbenchControlBlocks, humanizeRunOutput } from './run-output';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('shared room', () => {
  it('renders its empty state without requiring scrollIntoView', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn(() => Promise.resolve()) });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations') ? { conversations: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Workbench', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }
        : url.includes('/api/shared/messages') ? { messages: [] } : { items: [], proposal: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(screen.getByRole('button', { name: /agent console/i }));
    expect((await screen.findByRole('main')).className).toContain('shared-workspace');
    expect(await screen.findByText('No messages yet. Ask Codex or Claude to get started.')).toBeTruthy();
  });

  it('opens the requested task conversation and still allows switching tabs', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const firstId = '00000000-0000-4000-8000-000000000001';
    const requestedId = '00000000-0000-4000-8000-000000000002';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations') ? { conversations: [
        { id: firstId, title: 'First task', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: requestedId, title: 'Requested task', workItemId: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      ] } : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={requestedId} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Requested task' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /First task/i }));
    expect(await screen.findByRole('heading', { name: 'First task' })).toBeTruthy();
  });

  it('opens and closes the conversation drawer with accessible keyboard controls', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000001';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/api/shared/conversations')
        ? { conversations: [{ id: conversationId, title: 'Mobile conversation', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }
        : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const toggle = await screen.findByRole('button', { name: 'Show conversations' });
    expect(toggle.getAttribute('aria-controls')).toBe('conversation-rail');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it('submits chat with Enter and keeps Shift+Enter for a newline', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000001';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Workbench', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages') && init?.method === 'POST') return new Response(JSON.stringify({ message: {}, replies: [] }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);
    const composer = await screen.findByPlaceholderText('Message Codex or Claude…');
    fireEvent.change(composer, { target: { value: 'First line' } });
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
  });

  it('shows the selected recipient on Jeffrey messages', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000001';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/api/shared/conversations')
        ? { conversations: [{ id: conversationId, title: 'Workbench', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }
        : { messages: [{ id: 'message-1', conversationId, author: 'jeffrey', body: 'Please review this.', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'both' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('To Codex + Claude')).toBeTruthy();
  });
});

describe('agent activity stream', () => {
  it('removes transport noise and converts legacy tool JSON to readable activity', () => {
    const output = ['Starting Claude…', 'Starting Claude…', 'Using Bash: {"command":"ls","description":"inspect repository"}'].join('\n\n');
    expect(humanizeRunOutput(output)).toBe('● Inspect repository');
  });

  it('hides machine-only task plans from the readable report', () => {
    const output = 'Readable findings.\n\n<workbench-plan>{"summary":"internal"}</workbench-plan>';
    expect(hideWorkbenchControlBlocks(output)).toBe('Readable findings.');
  });
});
