// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, SharedWorkspace } from './App';
import { hideWorkbenchControlBlocks, humanizeRunOutput } from './run-output';

afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

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

  it('remembers a different model choice for each conversation', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/api/shared/conversations') ? { conversations: [
        { id: firstId, title: 'First task', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: secondId, title: 'Second task', workItemId: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      ] } : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={firstId} /></QueryClientProvider>);

    const modelChoice = await screen.findByLabelText('Model choice') as HTMLSelectElement;
    fireEvent.change(modelChoice, { target: { value: 'deep' } });
    expect(modelChoice.value).toBe('deep');
    fireEvent.click(screen.getByRole('button', { name: /Second task/i }));
    expect(modelChoice.value).toBe('auto');
    fireEvent.change(modelChoice, { target: { value: 'standard' } });
    fireEvent.click(screen.getByRole('button', { name: /First task/i }));
    expect(modelChoice.value).toBe('deep');
  });

  it('searches conversations, selects a result, and restores the list on clear', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const firstId = '00000000-0000-4000-8000-000000000001';
    const matchedId = '00000000-0000-4000-8000-000000000002';
    const searchMock = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/shared/search')) {
        searchMock(url);
        return new Response(JSON.stringify({
          results: [{ type: 'message', conversationId: matchedId, conversationTitle: 'Matched conversation', messageId: 'message-1', snippet: 'found the [needle] here', rank: 0 }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [
        { id: firstId, title: 'First task', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={firstId} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'First task' })).toBeTruthy();
    const searchInput = screen.getByLabelText('Search conversations');
    fireEvent.change(searchInput, { target: { value: 'needle' } });

    // Debounced: no request yet immediately after typing.
    expect(searchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith(expect.stringContaining('q=needle')), { timeout: 1000 });

    expect(await screen.findByText('Matched conversation')).toBeTruthy();
    expect(screen.getByText('needle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /First task/i })).toBeNull();

    fireEvent.click(screen.getByText('Matched conversation'));
    expect(await screen.findByRole('heading', { name: 'Matched conversation' })).toBeTruthy();
    expect((searchInput as HTMLInputElement).value).toBe('');

    fireEvent.change(searchInput, { target: { value: 'more' } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith(expect.stringContaining('q=more')));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('button', { name: /First task/i })).toBeTruthy();
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

describe('task execution', () => {
  it('replaces an active run with the canceled response immediately', async () => {
    const taskId = '00000000-0000-4000-8000-000000000010';
    const runId = '00000000-0000-4000-8000-000000000020';
    const item = {
      id: taskId, title: 'Fix canceled run controls', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', workspacePath: null,
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const runningRun = {
      id: runId, workItemId: taskId, kind: 'execute', requestedTarget: 'codex', agent: 'codex', status: 'running', instructions: '', output: '', error: '',
      startedAt: '2026-01-01T00:00:00Z', completedAt: null, createdAt: '2026-01-01T00:00:00Z', conversationId: null, messageId: null, model: null, executionProfile: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/agent-runs/${runId}/cancel`) return new Response(JSON.stringify({ run: { ...runningRun, status: 'canceled', completedAt: '2026-01-01T00:01:00Z' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes(`/api/work-items/${taskId}`)) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [runningRun], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [item], nextCursor: null, totalCount: 1, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-item-counts') return new Response(JSON.stringify({ active: 1, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('canceled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
