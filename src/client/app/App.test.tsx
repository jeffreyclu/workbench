import '@testing-library/jest-dom/vitest';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, SharedWorkspace, TaskDetail } from './App';
import { hideWorkbenchControlBlocks, humanizeRunOutput } from '../lib/run-output';
import { Toaster } from '../components/toast/toast';
import { getToasts, toast } from '../state/toast-store';

class TestWebSocket {
  static instances: TestWebSocket[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor() { TestWebSocket.instances.push(this); }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  close() { this.emit('close'); }
  emit(type: string, data?: unknown) { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
}

// The URL is real navigation state now, so it has to be reset between tests
// the same way the store and the DOM are.
afterEach(() => { cleanup(); toast.clear(); TestWebSocket.instances = []; window.localStorage.clear(); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });

describe('primary navigation', () => {
  it('opens keyboard help from Settings or ? but not while typing', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], conversations: [], messages: [], active: 0, workbench: 0, archive: 0, proposal: null, nextCursor: null }), { headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View shortcuts' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close keyboard shortcuts' }));
    const taskSearch = screen.getByRole('textbox', { name: 'Search tasks' });
    fireEvent.keyDown(taskSearch, { key: '?' });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('keeps Search everything available on the task stack and refetches with the entered query', async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedPaths.push(url);
      const body = url.startsWith('/api/work-items?')
        ? { items: [], nextCursor: null, totalCount: 0, proposal: null }
        : url.includes('/api/work-items/counts')
          ? { active: 0, workbench: 0, archive: 0 }
          : url.includes('/api/shared/conversations')
            ? { conversations: [] }
            : { messages: [] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    for (const name of ['Reorder stack', 'New task']) {
      const control = screen.getByRole('button', { name });
      expect(control.textContent).toBe('');
      expect(control).toHaveAttribute('title', name);
    }
    const search = screen.getByRole('textbox', { name: 'Search tasks' });
    expect(search).toHaveAttribute('placeholder', 'Search everything…');
    fireEvent.change(search, { target: { value: 'card consistency' } });

    await waitFor(() => expect(requestedPaths.some((path) => new URL(path, 'http://localhost').searchParams.get('query') === 'card consistency')).toBe(true));
    expect(await screen.findByText('No tasks match “card consistency”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear task search' }));
    expect(search).toHaveValue('');
  });

  it('plans only the Workbench stack from the Workbench reorder control', async () => {
    window.history.replaceState(null, '', '/workbench');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/queue/plan') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe(JSON.stringify({ stack: 'workbench' }));
        return new Response(JSON.stringify({ proposal: { id: 'proposal-1' }, items: [] }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      const body = url.startsWith('/api/work-items?')
        ? { items: [], nextCursor: null, totalCount: 0, proposal: null }
        : url.includes('/api/work-items/counts')
          ? { active: 0, workbench: 0, archive: 0 }
          : url.includes('/api/shared/conversations')
            ? { conversations: [] }
            : { messages: [] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Reorder stack' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/queue/plan', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stack: 'workbench' }) })));
  });

  it('keeps a resolved Workbench proposal in the Workbench tab', async () => {
    window.history.replaceState(null, '', '/workbench');
    const proposal = { id: 'workbench-proposal', stack: 'workbench', rationale: 'Workbench items need attention first.', explanations: [] };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/queue/proposals/${proposal.id}/accepted`) {
        return new Response(JSON.stringify({ proposal, items: [] }), { headers: { 'Content-Type': 'application/json' } });
      }
      const body = url.startsWith('/api/work-items?')
        ? { items: [], nextCursor: null, totalCount: 0, proposal }
        : url.includes('/api/work-items/counts')
          ? { active: 0, workbench: 0, archive: 0 }
          : url.includes('/api/shared/conversations')
            ? { conversations: [] }
            : { messages: [] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Keep order' }));
    await waitFor(() => expect(window.location.pathname).toBe('/workbench'));
  });

  it('opens nav tabs without restoring saved task or conversation details', async () => {
    const attentionId = '00000000-0000-4000-8000-000000000101';
    const workbenchId = '00000000-0000-4000-8000-000000000102';
    const conversationId = '00000000-0000-4000-8000-000000000103';
    window.localStorage.setItem('workbench:last-opened-attention-item', attentionId);
    window.localStorage.setItem('workbench:last-opened-workbench-item', workbenchId);
    window.localStorage.setItem('workbench:last-opened-conversation', conversationId);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], conversations: [], messages: [], active: 0, workbench: 0, archive: 0, proposal: null, nextCursor: null }), { headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(screen.getByRole('button', { name: /Attention stack/i }));
    expect(window.location.pathname).toBe('/');
    window.history.replaceState(null, '', '/insights');
    fireEvent.click(screen.getByRole('button', { name: /Workbench/i }));
    expect(window.location.pathname).toBe('/workbench');
    window.history.replaceState(null, '', '/insights');
    fireEvent.click(screen.getByRole('button', { name: /Conversations/i }));
    expect(window.location.pathname).toBe('/conversations');
    expect(await screen.findByRole('heading', { name: 'New conversation' })).toBeTruthy();
  });

  it('opens the active stack and scrolls to pinned tasks from the reminder toast', async () => {
    const pinnedItem = {
      id: '00000000-0000-4000-8000-000000000401', title: 'Return to this later', description: '', status: 'pinned', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, stack: 'attention', workspacePath: null,
      strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const scrollTo = vi.fn();
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/work-items?')
        ? { items: [pinnedItem], nextCursor: null, totalCount: 1, proposal: null }
        : url.includes('/api/work-items/counts')
          ? { active: 1, workbench: 0, archive: 0 }
          : url.includes('/api/shared/conversations')
            ? { conversations: [] }
            : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Open pinned: 1 pinned task waiting for you.' }));

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' })));
    expect(document.querySelector('.stack-header-pinned')?.textContent).toContain('Pinned for you');
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it('opens the Insights dashboard from the navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/insights')
        ? { windowDays: 30, retryRate: 0, fallbackRate: 0, byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0, medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] } }
        : url.includes('/api/work-items/counts')
          ? { active: 0, workbench: 0, archive: 0 }
          : url.includes('/api/shared/conversations/unread-count')
            ? { count: 0 }
            : url.includes('/api/shared/conversations')
              ? { conversations: [] }
              : { items: [], proposal: null, nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Insights' }));
    expect(await screen.findByRole('heading', { name: 'Insights' })).toBeTruthy();
  });

  it('opens the Discovery inbox from a socket notification', async () => {
    vi.stubGlobal('WebSocket', TestWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/discovery')
        ? { candidates: [], pendingCount: 0, reviewedCount: 0, lastRun: null, running: false, queueProposal: null }
        : url.includes('/api/work-items/counts')
          ? { active: 0, workbench: 0, archive: 0 }
          : url.includes('/api/shared/conversations')
            ? { conversations: [] }
            : { items: [], proposal: null, nextCursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    const socket = TestWebSocket.instances[0];
    act(() => socket.emit('message', JSON.stringify({
      type: 'notification', tone: 'info', message: '1 new discovery ready to review.',
      action: { label: 'Review discoveries', route: '/discovery' },
    })));

    expect(await screen.findByText('1 new discovery ready to review.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Review discoveries: 1 new discovery ready to review/i }));
    expect(await screen.findByRole('heading', { name: 'Discovered overnight' })).toBeTruthy();
  });
});

describe('shared room', () => {
  it('opens a newly created conversation and prevents duplicate creates while it is pending', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000097';
    let finishCreate: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/shared/conversations' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => { finishCreate = resolve; });
      }
      const body = url.includes('/api/shared/conversations')
        ? { conversations: [], nextCursor: null }
        : { messages: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace /></QueryClientProvider>);

    const newConversation = await screen.findByRole('button', { name: 'New conversation' });
    fireEvent.click(newConversation);
    await waitFor(() => expect(newConversation).toBeDisabled());
    fireEvent.click(newConversation);
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === '/api/shared/conversations' && init?.method === 'POST')).toHaveLength(1);

    finishCreate?.(new Response(JSON.stringify({ conversation: { id: conversationId, title: 'New conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    expect(await screen.findByRole('heading', { name: 'New conversation' })).toBeTruthy();
  });

  it('uses the app dialog before permanently deleting a manual conversation', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000099';
    const conversation = { id: conversationId, title: 'Disposable conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${conversationId}` && init?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
      const body = url.includes('/api/shared/conversations') ? { conversations: deleted ? [] : [conversation], nextCursor: null } : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation' }));
    expect(await screen.findByRole('dialog', { name: 'Delete this conversation?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/shared/conversations/${conversationId}` && init?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this conversation?' })).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/shared/conversations/${conversationId}` && init?.method === 'DELETE')).toBe(true));
    expect(await screen.findByRole('heading', { name: 'New conversation' })).toBeTruthy();
    expect(screen.queryByText(/This conversation could not be found/)).toBeNull();
  });

  it('offers an Undo action on the delete toast that restores the conversation', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000098';
    const conversation = { id: conversationId, title: 'Disposable conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    let deleted = false;
    let undeleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${conversationId}` && init?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
      if (url === `/api/shared/conversations/${conversationId}/undelete` && init?.method === 'POST') { deleted = false; undeleted = true; return new Response(JSON.stringify({ conversation }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      const body = url.includes('/api/shared/conversations') ? { conversations: deleted ? [] : [conversation], nextCursor: null } : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Toaster /><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this conversation?' })).getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => expect(deleted).toBe(true));

    const undoButton = await screen.findByRole('button', { name: 'Undo: Conversation deleted.' });
    fireEvent.click(undoButton);

    await waitFor(() => expect(undeleted).toBe(true));
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/shared/conversations/${conversationId}/undelete` && init?.method === 'POST')).toBe(true);
    expect(await screen.findByText('Conversation restored.')).toBeTruthy();
  });

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

    fireEvent.click(screen.getByRole('button', { name: /conversations/i }));
    fireEvent.click(await within(screen.getByLabelText('Conversations')).findByRole('button', { name: /Workbench/ }));
    expect((await screen.findByRole('main')).className).toContain('shared-workspace');
    expect(await screen.findByText('No messages yet. Choose a provider to get started.')).toBeTruthy();
  });

  it('renders an interjection inside the matching live agent stream', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000110';
    const agentReply = { id: 'reply-1', conversationId, author: 'codex', body: '● Inspecting the active stream', pinned: false, status: 'running', error: '', createdAt: '2025-12-31T23:59:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none', queuePriority: 0 };
    const interjection = { id: 'interjection-1', conversationId, author: 'jeffrey', body: 'aada', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'codex', queuePriority: 1 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Live steering', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [agentReply, interjection] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('You interjected')).toBeTruthy();
    expect(screen.getByText('Interjected')).toBeTruthy();
    expect(screen.getAllByText('aada')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();
  });

  it('plays the exit state before removing a canceled queued draft', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000112';
    const queuedDraft = { id: 'queued-draft', conversationId, author: 'jeffrey', body: 'Do this after the active response.', pinned: false, status: 'queued', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'codex', queuePriority: 0 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Cancel queued draft', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/queued-draft/cancel')) return new Response(JSON.stringify({ message: { ...queuedDraft, status: 'canceled' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [queuedDraft] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel queued message' }));

    expect(document.querySelector('.shared-message-exiting')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/queued-draft/cancel') && init?.method === 'POST')).toBe(true));
  });

  it('keeps the interjected chip on the reply after it completes', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000111';
    const agentReply = { id: 'reply-1', conversationId, author: 'codex', body: 'Applied the direction.', pinned: false, status: 'completed', error: '', createdAt: '2025-12-31T23:59:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none', queuePriority: 0 };
    const interjection = { id: 'interjection-1', conversationId, author: 'jeffrey', body: 'Keep it inline.', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'codex', queuePriority: 1 };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Completed steering', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [agentReply, interjection] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Interjected')).toBeTruthy();
    expect(screen.getByText('Applied the direction.')).toBeTruthy();
  });

  it('does not offer preview approval from a new empty conversation when changes are pending elsewhere', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000006';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/runtime/preview-status') return new Response(JSON.stringify({ pending: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Manual release', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'Manual release' });
    expect(screen.queryByRole('button', { name: 'Approve preview' })).toBeNull();
  });

  it('offers preview approval after completed agent work when changes are pending', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000006';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/runtime/preview-status') return new Response(JSON.stringify({ pending: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Manual release', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [{ id: 'agent-1', conversationId, author: 'codex', body: 'Completed the change.', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: 'auto', dispatchTarget: 'none' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Approve preview' })).toBeTruthy();
  });

  it('does not recreate preview approval from a stale pending response after that work promoted', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-0000-000000000096';
    const timestamp = '2026-01-01T00:00:00Z';
    const agentReply = { id: 'agent-before-promotion', conversationId, author: 'codex', body: 'Completed the change.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: 'auto', dispatchTarget: 'none' };
    const promotion = { id: 'promotion-complete', conversationId, author: 'system', body: 'Preview approved and promoted.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'promotion' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/runtime/preview-status') return new Response(JSON.stringify({ pending: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Promoted work', archivedAt: null, createdAt: timestamp, updatedAt: timestamp }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [agentReply, promotion] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByText('Preview approved and promoted.');
    expect(screen.queryByRole('button', { name: 'Approve preview' })).toBeNull();
  });

  it('offers task completion after an approval was combined into another successful promotion', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000097';
    const taskId = '00000000-0000-4000-8000-000000000098';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Merged approval', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const item = { id: taskId, title: 'Linked task', description: '', status: 'in_progress', priority: 2, queuePosition: 0, source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: 'finished', sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'attention', workspacePath: null, strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [], createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp };
    const mergedPromotion = { id: 'promotion-combined', conversationId, author: 'system', body: 'Preview approval was combined into the release that just promoted.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'promotion' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], references: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [mergedPromotion] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ pending: false }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Complete the linked task?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete task' })).toBeTruthy();
  });

  it('pins a manual conversation from the conversation window', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000095';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Pinned from conversation', workItemId: null, pinned: false, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${conversationId}/pin` && init?.method === 'PATCH') return new Response(JSON.stringify({ conversation: { ...conversation, pinned: true } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Pin conversation' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === `/api/shared/conversations/${conversationId}/pin` && init?.method === 'PATCH' && init.body === JSON.stringify({ pinned: true }))).toBe(true));
  });

  it('keeps the thread in document flow for queued promotion and completed messages', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000099';
    let approvalQueued = false;
    const agentReply = { id: 'agent-approval-source', conversationId, author: 'codex', body: 'Completed the change.', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: 'auto', dispatchTarget: 'none' };
    const approval = { id: 'approval-message', conversationId, author: 'jeffrey', body: 'Approve the Workbench preview.', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:01:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' };
    const promotion = { id: 'promotion-queued', conversationId, author: 'system', body: 'Promotion queued. It will build once active agent work reaches a durable terminal state.', pinned: false, status: 'queued', error: '', createdAt: '2026-01-01T00:01:01Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'promotion' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/runtime/preview-status') return new Response(JSON.stringify({ pending: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/shared/messages' && init?.method === 'POST') {
        approvalQueued = true;
        return new Response(JSON.stringify({ message: approval, replies: [promotion] }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Manual release', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: approvalQueued ? [agentReply, approval, promotion] : [agentReply] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Completed the change.')).toBeTruthy();
    const thread = document.querySelector('.thread-virtualizer');
    expect(thread).toHaveClass('thread-live-flow');
    expect(Array.from(thread!.children).every((row) => !row.hasAttribute('style') && !row.hasAttribute('data-index'))).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve preview' }));
    await screen.findByText('Promotion queued. It will build once active agent work reaches a durable terminal state.');
    expect(document.querySelector('.thread-virtualizer')).toHaveClass('thread-live-flow');
    expect(document.querySelector('.thread-virtual-row')).not.toHaveAttribute('style');
    expect(document.querySelector('.shared-system-queued')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Interrupt the current agent and send this queued message now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel queued message' })).toBeNull();
  });

  it('keeps task extraction on completed synthesis findings', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000096';
    const synthesis = { id: 'synthesis-1', conversationId, author: 'system', body: 'Synthesis:\n\n1. Fix the missing control.', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' };
    let extractionStarted = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/shared/messages/${synthesis.id}/create-tasks` && init?.method === 'POST') {
        extractionStarted = true;
        return new Response(JSON.stringify({ plan: null }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Findings', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [synthesis] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Turn findings into tasks' }));
    await waitFor(() => expect(extractionStarted).toBe(true));
  });

  it('does not show session feedback after a dual-agent response is synthesized', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000095';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Dual response', workItemId: null, archivedAt: null, state: 'finished', createdAt: timestamp, updatedAt: timestamp };
    const messages = [
      { id: 'codex-1', conversationId, author: 'codex', body: 'Codex completed the change.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: 'auto', dispatchTarget: 'none' },
      { id: 'claude-1', conversationId, author: 'claude', body: 'Claude completed the change.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: 'auto', dispatchTarget: 'none' },
      { id: 'synthesis-1', conversationId, author: 'system', body: 'Synthesis:\n\nThe change is complete.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations') && !url.includes('/feedback')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages }), { headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/feedback')) return new Response(JSON.stringify({ feedback: null }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('The change is complete.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'How did we do?' })).toBeNull());
  });

  it('shows the agent, model, account profile, usage, and duration on an agent reply', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000005';
    const reply = { id: 'agent-proof', conversationId, author: 'claude', body: 'Completed.', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:02Z', attachments: [], model: 'sonnet', accountProfile: 'personal', executionProfile: 'standard', inputTokens: 1, outputTokens: 1, fallbackFrom: 'codex', fallbackReason: 'quota', dispatchTarget: 'none' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Identity proof', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [reply] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Claude · sonnet (standard) · personal · 1 in · 1 out · 2.0s · fallback from codex (quota)')).toBeTruthy();
  });

  it('keeps the approved-awaiting-promotion badge on the conversation card while promotion runs', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000007';
    // The promotion system message is itself a running message, so the card is
    // "active"; the promotion state still has to win over the generic Working label.
    const promotionMessage = { id: 'promotion-running', conversationId, author: 'system', body: 'Approval received. Preparing the Workbench preview for promotion…', pinned: false, status: 'running', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'promotion' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Manual release', workItemId: null, archivedAt: null, state: 'promoting', isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [promotionMessage] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ items: [], proposal: null, nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Approved · promoting preview')).toBeTruthy();
    expect(screen.queryByText('Agent working…')).toBeNull();
  });

  it('shows the linked task pin in the conversation stack', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000008';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Pinned task conversation', workItemId: '00000000-0000-4000-8000-000000000108', linkedWorkItemPinned: true, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByTitle('Pinned task')).toBeTruthy();
  });

  it('keeps an icon-only cancel control on a running conversation reply and sends its cancellation request', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000208';
    const replyId = '00000000-0000-4000-8000-000000000209';
    let canceled = false;
    const conversation = { id: conversationId, title: 'Cancelable reply', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const runningReply = { id: replyId, conversationId, author: 'codex', body: 'Working on it.', pinned: false, status: 'running', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/shared/messages/${replyId}/cancel` && init?.method === 'POST') {
        canceled = true;
        return new Response(JSON.stringify({ message: { ...runningReply, status: 'canceled' } }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [{ ...runningReply, status: canceled ? 'canceled' : 'running' }] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ conversation }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const cancel = await screen.findByRole('button', { name: 'Cancel response' });
    expect(cancel).toHaveTextContent('');
    expect(cancel).toHaveClass('cancel-response');
    fireEvent.click(cancel);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/shared/messages/${replyId}/cancel` && init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel response' })).toBeNull());
  });

  it('uses the linked task project color in the conversation stack', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000109';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Project conversation', workItemId: '00000000-0000-4000-8000-000000000110', linkedProjectName: 'Workbench', archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const projectColor = await screen.findByLabelText('Workbench project');
    expect(projectColor).toHaveStyle({ background: '#c06ca8' });
  });

  it('groups active conversations into progress, attention, and pinned sections', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversations = [
      { id: '00000000-0000-4000-8000-000000000011', title: 'Running conversation', workItemId: null, state: 'working', archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: '00000000-0000-4000-8000-000000000012', title: 'Needs review', workItemId: null, state: 'waiting_approval', archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: '00000000-0000-4000-8000-000000000013', title: 'Pinned conversation', workItemId: '00000000-0000-4000-8000-000000000113', linkedWorkItemPinned: true, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations, nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace /></QueryClientProvider>);

    expect(await screen.findAllByText('Running conversation')).toHaveLength(2);
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Attention stack')).toBeTruthy();
    expect(screen.getByText('Pinned for you')).toBeTruthy();
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.getByText('Pinned conversation')).toBeTruthy();
  });

  it('keeps the pinned section visible in the conversation rail even with no pinned conversations', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversations = [{ id: '00000000-0000-4000-8000-000000000014', title: 'Unpinned conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations, nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace /></QueryClientProvider>);

    expect((await screen.findAllByText('Unpinned conversation')).length).toBeGreaterThan(0);
    expect(screen.getByText('Pinned for you')).toBeTruthy();
  });

  it('keeps a finished conversation visible in the attention stack instead of dropping it', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversations = [{ id: '00000000-0000-4000-8000-000000000015', title: 'Finished conversation', workItemId: null, state: 'finished', archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations, nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace /></QueryClientProvider>);

    expect((await screen.findAllByText('Finished conversation')).length).toBeGreaterThan(0);
    expect(screen.getByText('Awaiting')).toBeTruthy();
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
    const { rerender } = render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={requestedId} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Requested task' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /First task/i }));
    expect(await screen.findByRole('heading', { name: 'First task' })).toBeTruthy();
    rerender(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={requestedId} /></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'First task' })).toBeTruthy();
  });

  it('closing an open conversation on mobile reveals the conversation stack', async () => {
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
    const workspace = () => document.querySelector('.shared-workspace') as Element;

    await screen.findByRole('heading', { name: 'Mobile conversation' });
    expect(workspace().classList.contains('rail-open')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Close conversation' }));
    expect(workspace().classList.contains('rail-open')).toBe(true);
  });

  it('shows only the conversation stack after archiving', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000009';
    const active = { id: conversationId, title: 'Conversation to archive', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, archivedAt: '2026-01-02T00:00:00Z' };
    const retainedOne = { ...active, id: '00000000-0000-4000-8000-000000000019', title: 'Unrelated conversation one' };
    const retainedTwo = { ...active, id: '00000000-0000-4000-8000-000000000029', title: 'Unrelated conversation two' };
    let isArchived = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/shared/conversations/${conversationId}/archive`) && init?.method === 'POST') { isArchived = true; return new Response(JSON.stringify({ conversation: archived }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: url.includes('view=archive') ? [archived] : isArchived ? [retainedOne, retainedTwo] : [active, retainedOne, retainedTwo], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive conversation' }));

    await waitFor(() => expect(document.querySelector('.shared-workspace')).toHaveClass('stack-only'));
    expect(screen.queryByRole('heading', { name: 'Unrelated conversation one' })).toBeNull();
    expect(screen.getByText('Unrelated conversation two')).toBeTruthy();
    expect(screen.queryByText(/Archived conversation · restore or fork it to continue/)).toBeNull();

    fireEvent.click(within(screen.getByRole('tablist', { name: 'Conversation view' })).getByRole('tab', { name: 'Archive' }));
    const archivedCard = (await screen.findAllByText('Conversation to archive')).map((node) => node.closest('button')).find(Boolean);
    expect(archivedCard).not.toHaveClass('conversation-exiting');
  });

  it('refetches the archive rail when Archive is selected again', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const active = { id: '00000000-0000-4000-8000-000000000041', title: 'Active conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, id: '00000000-0000-4000-8000-000000000042', title: 'Archived conversation', archivedAt: '2026-01-02T00:00:00Z' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations')
        ? (url.includes('view=archive') ? { conversations: [archived], nextCursor: null } : { conversations: [active], nextCursor: null })
        : { messages: [] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={active.id} /></QueryClientProvider>);

    const viewTabs = await screen.findByRole('tablist', { name: 'Conversation view' });
    const archiveView = within(viewTabs).getByRole('tab', { name: 'Archive' });
    fireEvent.click(archiveView);
    await waitFor(() => expect(archiveView.getAttribute('aria-selected')).toBe('true'));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', archiveView.id);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/shared/conversations?') && String(input).includes('view=archive')).length).toBeGreaterThan(0));
    const archiveRequestsBeforeRepeat = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/shared/conversations?') && String(input).includes('view=archive')).length;

    const archiveViewAfterSelection = within(screen.getByRole('tablist', { name: 'Conversation view' })).getByRole('tab', { name: 'Archive' });
    archiveViewAfterSelection.focus();
    fireEvent.click(archiveViewAfterSelection);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/shared/conversations?') && String(input).includes('view=archive')).length).toBeGreaterThan(archiveRequestsBeforeRepeat));
  });

  it('does not reselect an active conversation while the archive rail is loading', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const active = { id: '00000000-0000-4000-8000-000000000043', title: 'Active conversation that must not return', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, id: '00000000-0000-4000-8000-000000000044', title: 'Archived conversation that should open', archivedAt: '2026-01-02T00:00:00Z' };
    let releaseArchiveRequest!: () => void;
    const archiveRequest = new Promise<void>((resolve) => { releaseArchiveRequest = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?') && url.includes('view=archive')) {
        await archiveRequest;
        return new Response(JSON.stringify({ conversations: [archived], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      }
      const body = url.includes('/api/shared/conversations') ? { conversations: [active], nextCursor: null } : { messages: [] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={active.id} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: active.title })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Conversation view' })).getByRole('tab', { name: 'Archive' }));
    releaseArchiveRequest();

    expect(await screen.findByRole('heading', { name: archived.title })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: active.title })).toBeNull();
  });

  it('keeps the archive view selected while conversation URL state follows the rail', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const active = { id: '00000000-0000-4000-8000-000000000045', title: 'Active URL conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, id: '00000000-0000-4000-8000-000000000046', title: 'Archived URL conversation', archivedAt: '2026-01-02T00:00:00Z' };
    window.history.replaceState(null, '', `/conversations/${active.id}`);
    window.localStorage.setItem('workbench:last-opened-conversation', active.id);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations?')
        ? { conversations: url.includes('view=archive') ? [archived] : [active], nextCursor: null }
        : { ok: true, mode: 'live', runtimeWorkActive: false, buildId: 'test', items: [], conversations: [], messages: [], active: 0, workbench: 0, archive: 1, count: 0, pending: false, proposal: null, nextCursor: null };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: active.title })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Conversation view' })).getByRole('tab', { name: 'Archive' }));
    expect(await screen.findByRole('heading', { name: archived.title })).toBeTruthy();
    expect(window.location.pathname).toBe(`/conversations/${archived.id}`);

    const archiveRequestsBeforeRepeat = fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/shared/conversations?') && String(input).includes('view=archive')).length;
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Conversation view' })).getByRole('tab', { name: 'Archive' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/shared/conversations?') && String(input).includes('view=archive')).length).toBeGreaterThan(archiveRequestsBeforeRepeat));
    expect(screen.getByRole('heading', { name: archived.title })).toBeTruthy();
    expect(window.location.pathname).toBe(`/conversations/${archived.id}`);
  });

  it('keeps the selected archived conversation open when Archive is selected again', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const active = { id: '00000000-0000-4000-8000-000000000051', title: 'Active conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, id: '00000000-0000-4000-8000-000000000052', title: 'Archived conversation', archivedAt: '2026-01-02T00:00:00Z' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations')
        ? { conversations: url.includes('view=archive') ? [archived] : [active], nextCursor: null }
        : { messages: [] };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={active.id} /></QueryClientProvider>);

    const viewTabs = await screen.findByRole('tablist', { name: 'Conversation view' });
    fireEvent.click(within(viewTabs).getByRole('tab', { name: 'Archive' }));
    fireEvent.click(await screen.findByRole('button', { name: /Archived conversation/i }));
    expect(await screen.findByRole('heading', { name: 'Archived conversation' })).toBeTruthy();

    fireEvent.click(within(screen.getByRole('tablist', { name: 'Conversation view' })).getByRole('tab', { name: 'Archive' }));

    expect(screen.getByRole('heading', { name: 'Archived conversation' })).toBeTruthy();
  });

  // Switching rails clears the selection first, so the address briefly drops to
  // `/conversations` before the new rail settles on a conversation. The
  // workspace used to be remounted on that intermediate address, which reset the
  // rail to Active and reopened an unrelated conversation. It only reproduced
  // after both rails had been visited once, so a single Active -> Archive switch
  // looked fine.
  it('stays on the archive rail when Archive is reselected after returning to Active', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const active = { id: '00000000-0000-4000-8000-000000000061', title: 'Active rail conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, id: '00000000-0000-4000-8000-000000000062', title: 'Archived rail conversation', archivedAt: '2026-01-02T00:00:00Z' };
    window.history.replaceState(null, '', `/conversations/${active.id}`);
    window.localStorage.setItem('workbench:last-opened-conversation', active.id);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations?')
        ? { conversations: url.includes('view=archive') ? [archived] : [active], nextCursor: null }
        : { ok: true, mode: 'live', runtimeWorkActive: false, buildId: 'test', items: [], conversations: [], messages: [], active: 0, workbench: 0, archive: 1, count: 0, pending: false, proposal: null, nextCursor: null };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
    const viewTabs = () => screen.getByRole('tablist', { name: 'Conversation view' });
    const tab = (name: 'Active' | 'Archive') => within(viewTabs()).getByRole('tab', { name });

    expect(await screen.findByRole('heading', { name: active.title })).toBeTruthy();

    // Three switches, because the rail only lost the selection once both rails
    // had been rendered at least once.
    for (const step of [1, 2, 3]) {
      fireEvent.click(tab('Archive'));
      await waitFor(() => expect(tab('Archive').getAttribute('aria-selected')).toBe('true'), { timeout: 3000 });
      expect(tab('Active').getAttribute('aria-selected')).toBe('false');
      expect(await screen.findByRole('heading', { name: archived.title })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: active.title })).toBeNull();
      expect(step).toBeGreaterThan(0);

      fireEvent.click(tab('Active'));
      await waitFor(() => expect(tab('Active').getAttribute('aria-selected')).toBe('true'), { timeout: 3000 });
      expect(await screen.findByRole('heading', { name: active.title })).toBeTruthy();
    }
  });

  // On phones the conversation list is a drawer over the console. Switching the
  // Active/Archive rail used to remount the workspace, and the drawer's open
  // state lived inside that remount, so the list Jeffrey was browsing slid shut
  // on every switch and he had to reopen it to pick the next conversation.
  it('keeps the conversation drawer open while switching the Active/Archive rail', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const active = { id: '00000000-0000-4000-8000-000000000071', title: 'Active drawer conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, id: '00000000-0000-4000-8000-000000000072', title: 'Archived drawer conversation', archivedAt: '2026-01-02T00:00:00Z' };
    window.history.replaceState(null, '', `/conversations/${active.id}`);
    window.localStorage.setItem('workbench:last-opened-conversation', active.id);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations?')
        ? { conversations: url.includes('view=archive') ? [archived] : [active], nextCursor: null }
        : { ok: true, mode: 'live', runtimeWorkActive: false, buildId: 'test', items: [], conversations: [], messages: [], active: 0, workbench: 0, archive: 1, count: 0, pending: false, proposal: null, nextCursor: null };
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
    const workspace = () => container.querySelector('.shared-workspace')!;
    const drawerOpen = () => workspace().classList.contains('rail-open');
    const viewTabs = () => screen.getByRole('tablist', { name: 'Conversation view' });
    const tab = (name: 'Active' | 'Archive') => within(viewTabs()).getByRole('tab', { name });

    expect(await screen.findByRole('heading', { name: active.title })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close conversation' }));
    expect(drawerOpen()).toBe(true);

    for (const _step of [1, 2, 3]) {
      fireEvent.click(tab('Archive'));
      await waitFor(() => expect(tab('Archive').getAttribute('aria-selected')).toBe('true'), { timeout: 3000 });
      await screen.findByRole('heading', { name: archived.title });
      expect(drawerOpen()).toBe(true);

      fireEvent.click(tab('Active'));
      await waitFor(() => expect(tab('Active').getAttribute('aria-selected')).toBe('true'), { timeout: 3000 });
      await screen.findByRole('heading', { name: active.title });
      expect(drawerOpen()).toBe(true);
    }

    // Picking a conversation is still a commit, so the drawer gets out of the way.
    fireEvent.click(screen.getByRole('button', { name: /Active drawer conversation/i }));
    await waitFor(() => expect(drawerOpen()).toBe(false));
  });

  it('distinguishes manual conversations from task-linked conversations', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const manualId = '00000000-0000-4000-8000-000000000010';
    const linkedId = '00000000-0000-4000-8000-000000000011';
    const taskId = '00000000-0000-4000-8000-000000000012';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/api/shared/conversations') ? { conversations: [
        { id: manualId, title: 'Scratch conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: linkedId, title: 'Generated task conversation', workItemId: taskId, archivedAt: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      ] } : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={manualId} /></QueryClientProvider>);

    expect((await screen.findAllByText('Manual')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Task-linked')).toBeTruthy();
    expect(screen.getByTitle('Created automatically for a task')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Generated task conversation/ }));
    const deleteButton = await screen.findByRole('button', { name: 'Delete conversation' });
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('tooltip').textContent).toBe('Delete the related task to delete this conversation.');
    expect(deleteButton.parentElement?.classList.contains('is-disabled')).toBe(true);
  });

  it('filters linkable tasks in the conversation typeahead and links the keyboard-selected match', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000025';
    const alphaTaskId = '00000000-0000-4000-8000-000000000026';
    const conversation = { id: conversationId, title: 'Link a task', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const makeTask = (id: string, title: string) => ({
      id, title, description: '', status: 'ready', priority: 2, queuePosition: 0, source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, stack: 'attention', workspacePath: null, strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [makeTask(alphaTaskId, 'Prepare release notes'), makeTask('00000000-0000-4000-8000-000000000027', 'Review mobile controls')], nextCursor: null, totalCount: 2, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}/task` && init?.method === 'PATCH') return new Response(JSON.stringify({ conversation: { ...conversation, workItemId: alphaTaskId } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Link conversation to task' }));
    const search = screen.getByRole('combobox', { name: 'Search tasks to link' });
    expect(await screen.findByRole('option', { name: 'Prepare release notes' })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'release' } });
    expect(screen.queryByRole('option', { name: 'Review mobile controls' })).toBeNull();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Search tasks to link' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Link conversation to task' }));
    const reopenedSearch = screen.getByRole('combobox', { name: 'Search tasks to link' });
    fireEvent.change(reopenedSearch, { target: { value: 'release' } });
    fireEvent.keyDown(reopenedSearch, { key: 'ArrowDown' });
    fireEvent.keyDown(reopenedSearch, { key: 'Enter' });

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/shared/conversations/${conversationId}/task` && init?.method === 'PATCH' && init.body === JSON.stringify({ workItemId: alphaTaskId }))).toBe(true));
  });

  it('includes Workbench-project tasks alongside attention-stack tasks in the conversation link picker', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000028';
    const attentionTaskId = '00000000-0000-4000-8000-000000000029';
    const workbenchTaskId = '00000000-0000-4000-8000-000000000030';
    const conversation = { id: conversationId, title: 'Link a task', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const makeTask = (id: string, title: string) => ({
      id, title, description: '', status: 'ready', priority: 2, queuePosition: 0, source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', workspacePath: null, strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/work-items?')) {
        const params = new URL(url, 'http://local').searchParams;
        const items = params.get('view') === 'workbench' ? [makeTask(workbenchTaskId, 'Fix Workbench bug')] : [makeTask(attentionTaskId, 'Attention task')];
        return new Response(JSON.stringify({ items, nextCursor: null, totalCount: items.length, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Link conversation to task' }));
    expect(await screen.findByRole('option', { name: 'Attention task' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Fix Workbench bug' })).toBeTruthy();
  });

  it('completes a linked task from its conversation and shows only the conversation stack', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000013';
    const taskId = '00000000-0000-4000-8000-000000000014';
    const timestamp = '2026-01-01T00:00:00Z';
    const activeConversation = { id: conversationId, title: 'Finish from chat', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const baseItem = {
      id: taskId, title: 'Linked task', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: 'finished', sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'attention', workspacePath: null,
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const completedItem = { ...baseItem, status: 'done', archivedAt: timestamp, completedAt: timestamp, completionStatus: 'completed' };
    let completed = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}/complete` && init?.method === 'POST') {
        completed = true;
        return new Response(JSON.stringify({ item: completedItem }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item: completed ? completedItem : baseItem, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [activeConversation], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) {
        const conversations = url.includes('view=archive') && completed
          ? [{ ...activeConversation, archivedAt: timestamp }]
          : completed ? [] : [activeConversation];
        return new Response(JSON.stringify({ conversations, nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ conversation: activeConversation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    // Keep task controls compact and icon-only; accessible names and tooltips
    // distinguish them from the adjacent conversation actions.
    expect((await screen.findByRole('button', { name: 'Unlink task' })).textContent).toBe('');
    const completeTask = await screen.findByRole('button', { name: 'Complete linked task' });
    expect(completeTask.textContent).toBe('');
    fireEvent.click(completeTask);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/work-items/${taskId}/complete` && init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(document.querySelector('.shared-workspace')).toHaveClass('stack-only'));
    expect(screen.queryByText(/Archived conversation · restore or fork it to continue/)).toBeNull();
  });

  it('opens workspace changes for a conversation without a linked task', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000213';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Standalone implementation', workItemId: null, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const message = { id: 'standalone-message', conversationId, author: 'codex', body: 'Implemented the standalone change.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff`) return new Response(JSON.stringify({ diff: { workspacePath: '/tmp/workbench', branch: 'conversation-diff', changedFiles: 1, additions: 1, deletions: 0, publish: { branch: 'conversation-diff', hasOrigin: true, ahead: 0, hasChanges: true, reason: null }, files: [{ path: 'src/client/standalone.tsx', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+standalone' }] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [message] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const changes = await screen.findByRole('button', { name: 'Changes' });
    await waitFor(() => expect(changes).toBeEnabled());
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/shared/conversations/${conversationId}/workspace-diff`)).toBe(true);

    fireEvent.click(changes);
    expect(await screen.findByText('Workspace review')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Review workspace decisions' })).toBeNull();
    expect(screen.queryByText('Review behavior decisions in priority order before publishing these workspace changes.')).toBeNull();
    expect(await screen.findAllByRole('button', { name: /src\/client\/standalone\.tsx/ })).not.toHaveLength(0);
    expect(screen.getByLabelText('Conversation changes')).toBeTruthy();
  });

  it('opens a linked GitHub pull-request diff inside the conversation window on demand', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000214';
    const taskId = '00000000-0000-4000-8000-000000000215';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Review pull request', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const item = {
      id: taskId, title: 'Review GitHub changes', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: 'https://github.com/writer/workbench/pull/42', sourceTags: ['GitHub'], projectName: 'Workbench', stack: 'attention', workspacePath: null,
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const message = { id: 'review-message', conversationId, author: 'codex', body: 'The implementation is ready to review.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff`) return new Response(JSON.stringify({ diff: { workspacePath: '/tmp/workbench', branch: 'diff-in-chat', changedFiles: 1, additions: 2, deletions: 1, publish: { branch: 'diff-in-chat', hasOrigin: true, ahead: 0, hasChanges: true, reason: null }, files: [{ path: 'src/client/App.tsx', previousPath: null, status: 'modified', additions: 2, deletions: 1, isBinary: false, patch: '@@ -1 +1,2 @@\n-old\n+new\n+next' }] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/github/pull-request-diff')) return new Response(JSON.stringify({ diff: { url: item.sourceUrl, repository: 'writer/workbench', number: 42, title: 'Conversation review', baseRef: 'main', headRef: 'diff-in-chat', changedFiles: 1, additions: 2, deletions: 1, files: [{ path: 'src/client/App.tsx', previousPath: null, status: 'modified', additions: 2, deletions: 1, isBinary: false, patch: '@@ -1 +1,2 @@\n-old\n+new\n+next' }] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [message] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('The implementation is ready to review.')).toBeTruthy();
    const changes = await screen.findByRole('button', { name: 'Changes' });
    await waitFor(() => expect(changes).toBeEnabled());
    expect(changes).toHaveAttribute('aria-pressed', 'false');
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/github/pull-request-diff'))).toBe(true);

    fireEvent.click(changes);
    expect(await screen.findByText('Workspace review')).toBeTruthy();
    // The linked pull request is an explicit review source, so it opens on demand rather than by default.
    fireEvent.click(screen.getByRole('button', { name: 'GitHub PR' }));
    fireEvent.change(await screen.findByLabelText('Pull request'), { target: { value: item.sourceUrl } });
    expect(await screen.findByRole('heading', { name: 'Conversation review' })).toBeTruthy();
    // The queue chip and the diff block header. A lone decision has no relationships, so the change map contributes no node.
    expect((await screen.findAllByRole('button', { name: /src\/client\/App\.tsx/ })).map((button) => button.getAttribute('aria-label'))).toEqual([
      'Decision 1: Changes behavior in src/client/App.tsx. \u2014 Pending',
      'Select the decision at Lines 1\u20132 in src/client/App.tsx',
    ]);
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull();
    expect(screen.getByLabelText('Message an agent').closest('.conversation-review-layout')).toHaveClass('layout-changes');
    expect(document.querySelectorAll('#conversation-composer')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    expect(await screen.findByText('The implementation is ready to review.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Conversation review' })).toBeNull();
  });

  it('opens the linked task workspace diff in the conversation even without a pull request', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000216';
    const taskId = '00000000-0000-4000-8000-000000000217';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Implement task', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const item = {
      id: taskId, title: 'Local implementation', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'attention', workspacePath: '/tmp/workbench',
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff`) return new Response(JSON.stringify({ diff: { workspacePath: item.workspacePath, branch: 'feature/local-diff', changedFiles: 1, additions: 1, deletions: 1, publish: { branch: 'feature/local-diff', hasOrigin: true, ahead: 0, hasChanges: true, reason: null }, files: [{ path: 'src/client/feature.tsx', previousPath: null, status: 'modified', additions: 1, deletions: 1, isBinary: false, patch: '@@ -1 +1 @@\n-before\n+after' }] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const changes = await screen.findByRole('button', { name: 'Changes' });
    await waitFor(() => expect(changes).toBeEnabled());
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/workspace-diff'))).toBe(true);

    fireEvent.click(changes);
    expect(await screen.findByText('Workspace review')).toBeTruthy();
    expect(await screen.findAllByRole('button', { name: /src\/client\/feature\.tsx/ })).not.toHaveLength(0);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/shared/conversations/${conversationId}/workspace-diff`)).toBe(true);
    expect(screen.queryByText('GitHub reports no changed files for this pull request.')).toBeNull();
  });

  it('keeps Changes available when the linked task has no local or pull-request diff', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000218';
    const taskId = '00000000-0000-4000-8000-000000000219';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'No changes', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const item = {
      id: taskId, title: 'No diff available', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'attention', workspacePath: '/tmp/workbench',
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff`) return new Response(JSON.stringify({ diff: { workspacePath: item.workspacePath, branch: 'clean', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'clean', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const changes = await screen.findByRole('button', { name: 'Changes' });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/shared/conversations/${conversationId}/workspace-diff`)).toBe(true));
    expect(changes).not.toBeDisabled();
    expect(changes).toHaveAttribute('title', 'No changes to review');
    fireEvent.click(changes);
    expect(await screen.findByLabelText('Current workspace changes')).toBeTruthy();
  });

  it('keeps Changes enabled for a recorded workspace diff after commit and push', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000230';
    const taskId = '00000000-0000-4000-8000-000000000231';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Recorded change', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const item = {
      id: taskId, title: 'Committed implementation', description: '', status: 'ready', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'attention', workspacePath: '/tmp/workbench',
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [], createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff`) return new Response(JSON.stringify({ diff: { workspacePath: item.workspacePath, branch: 'main', revision: 'current-clean', changedFiles: 0, additions: 0, deletions: 0, publish: { branch: 'main', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff/snapshots`) return new Response(JSON.stringify({ snapshots: [{ id: 'snapshot-1', capturedAt: timestamp, diff: { workspacePath: item.workspacePath, branch: 'main', revision: 'committed-change', changedFiles: 1, additions: 1, deletions: 0, publish: { branch: 'main', hasOrigin: true, ahead: 0, hasChanges: false, reason: null }, files: [{ path: 'src/client/fixed.tsx', previousPath: null, status: 'added', additions: 1, deletions: 0, isBinary: false, patch: '@@ -0,0 +1 @@\n+fixed' }] } }] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const changes = await screen.findByRole('button', { name: 'Changes' });
    await waitFor(() => expect(changes).toBeEnabled());
    fireEvent.click(changes);
    // A clean checkout with a recorded version opens that version instead of an empty state.
    expect(await screen.findByRole('heading', { name: 'Workspace review record' })).toBeTruthy();
    expect(screen.getByLabelText('Workspace diff history')).toHaveValue('snapshot-1');
    expect(screen.getByRole('option', { name: /1 files/ })).toBeTruthy();
  });

  it('does not duplicate the conversation pin in the top action bar', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000017';
    const taskId = '00000000-0000-4000-8000-000000000018';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Pin from conversation', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const baseItem = {
      id: taskId, title: 'Linked task', description: '', status: 'ready', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'attention', workspacePath: null,
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    let pinned = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}` && init?.method === 'PATCH') {
        pinned = true;
        return new Response(JSON.stringify({ item: { ...baseItem, status: 'pinned' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item: { ...baseItem, status: pinned ? 'pinned' : 'ready' }, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ ...conversation, linkedWorkItemPinned: pinned }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ conversation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('button', { name: 'Complete linked task' });
    expect(screen.queryByRole('button', { name: 'Put a pin in it' })).toBeNull();
  });

  it('ignores a stale owner-mutation response that resolves after a newer one', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000016';
    const taskId = '00000000-0000-4000-8000-000000000017';
    const timestamp = '2026-01-01T00:00:00Z';
    const activeConversation = { id: conversationId, title: 'Owner race', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const baseItem = {
      id: taskId, title: 'Owner-raced task', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'attention', workspacePath: null,
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    // The first PATCH (to "claude") resolves after the second (to "both"),
    // simulating an out-of-order network response to a rapid double-click.
    let resolveFirstPatch: (() => void) | null = null;
    const firstPatchGate = new Promise<void>((resolve) => { resolveFirstPatch = resolve; });
    let patchCount = 0;
    const patchedAssignees: string[][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}` && init?.method === 'PATCH') {
        const assignees = (JSON.parse(String(init.body)) as { assignees: string[] }).assignees;
        patchedAssignees.push(assignees);
        patchCount += 1;
        if (patchCount === 1) await firstPatchGate;
        return new Response(JSON.stringify({ item: { ...baseItem, assignees } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item: baseItem, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [activeConversation], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [activeConversation], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ conversation: activeConversation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    // Let the conversation's dispatch-target initialization settle first so the
    // background effect that derives it from the linked task's assignees
    // doesn't clobber the deliberate selection made below.
    await screen.findByRole('button', { name: 'Complete linked task' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const select = await screen.findByLabelText('Provider') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude' } });
    fireEvent.change(select, { target: { value: 'both' } });
    await waitFor(() => expect(patchCount).toBe(2));

    const getCallsBeforeFirstPatchSettles = fetchMock.mock.calls.filter(([input, init]) => String(input) === `/api/work-items/${taskId}` && !init?.method).length;
    resolveFirstPatch!();
    // The optimistic value from the second (latest) change must win even
    // though its request settled before the stale first one is unblocked.
    await waitFor(() => expect(select.value).toBe('both'));
    expect(patchedAssignees).toEqual([['claude'], ['codex', 'claude']]);
    // Only the newer response should trigger a refetch; the stale first
    // response settling afterward must not re-invalidate the query.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const getCallsAfterSettling = fetchMock.mock.calls.filter(([input, init]) => String(input) === `/api/work-items/${taskId}` && !init?.method).length;
    expect(getCallsAfterSettling).toBe(getCallsBeforeFirstPatchSettles);
  });

  it('asks to complete an incomplete linked task after its preview is promoted', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000015';
    const taskId = '00000000-0000-4000-8000-000000000016';
    const timestamp = '2026-01-01T00:00:00Z';
    const conversation = { id: conversationId, title: 'Promoted task', workItemId: taskId, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
    const item = { id: taskId, title: 'Linked task', description: '', status: 'in_progress', priority: 2, queuePosition: 0, source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: 'finished', sourceIdentifier: null, sourceUrl: null, sourceTags: ['Manual'], projectName: 'Workbench', stack: 'workbench', workspacePath: null, strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [], createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [
        { id: 'agent-1', conversationId, author: 'codex', body: 'Fixed the bug.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' },
        { id: 'promotion-1', conversationId, author: 'system', body: 'Preview approved and promoted. The live Workbench switched to the verified release without changing its URL.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/runtime/preview-status') return new Response(JSON.stringify({ pending: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Complete the linked task?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete task' })).toBeTruthy();
    expect(screen.queryByText('Workbench preview has unpublished changes')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not yet' }));
    expect(screen.queryByText('Complete the linked task?')).toBeNull();
  });

  it('renders the accessible rich-message composer', async () => {
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
    const composer = await screen.findByLabelText('Message an agent');
    expect(composer.getAttribute('contenteditable')).toBe('true');
  });

  it('opens the mobile conversation tray from one centered control and collapses it with an upward swipe', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(max-width: 820px) and (pointer: coarse)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const conversationId = '00000000-0000-4000-8000-000000000031';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff`) return new Response(JSON.stringify({ diff: { workspacePath: '/tmp/workbench', branch: 'mobile-changes', changedFiles: 1, additions: 1, deletions: 0, publish: { branch: 'mobile-changes', hasOrigin: true, ahead: 0, hasChanges: true, reason: null }, files: [{ path: 'src/client/mobile.tsx', previousPath: null, status: 'modified', additions: 1, deletions: 0, isBinary: false, patch: '@@ -1 +1 @@\n-old\n+new' }] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [{ id: 'mobile-agent-reply', conversationId, author: 'codex', recipient: 'jeffrey', kind: 'execute', status: 'completed', body: 'Implemented the mobile change.', attachments: [], createdAt: '2026-01-01T00:01:00Z', updatedAt: '2026-01-01T00:01:00Z' }] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Compact mobile conversation', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: 'Compact mobile conversation' });
    expect(heading.closest('header')).toHaveClass('is-mobile-header-collapsed');
    const composer = screen.getByLabelText('Message an agent').closest('form');
    expect(composer).toHaveClass('is-mobile-composer-collapsed');

    const trayGrabber = screen.getByRole('button', { name: 'Expand conversation tray' });
    expect(trayGrabber.querySelector('svg')).toBeNull();
    expect(trayGrabber.querySelector('span')).not.toBeNull();
    fireEvent.click(trayGrabber);
    expect(heading.closest('header')).not.toHaveClass('is-mobile-header-collapsed');
    expect(screen.getByRole('button', { name: 'Collapse conversation tray' })).toBeInTheDocument();
    const executionType = await screen.findByRole('button', { name: 'Execution type: Execute' });
    expect(executionType.closest('.conversation-window-actions')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Execution type: Execute' })).toHaveLength(1);

    // JSDOM does not preserve PointerEvent client coordinates, so the swipe
    // threshold itself is covered by the production handler while this test
    // verifies the same state transition through its keyboard-accessible
    // control.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation tray' }));
    expect(heading.closest('header')).toHaveClass('is-mobile-header-collapsed');

    expect(screen.getByRole('button', { name: 'Expand composer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    expect(composer).not.toHaveClass('is-mobile-composer-collapsed');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse composer' }));
    expect(composer).toHaveClass('is-mobile-composer-collapsed');
    const mobileReviewToggle = document.querySelector('.mobile-review-toggle');
    expect(mobileReviewToggle).toBeInTheDocument();
    const changes = within(mobileReviewToggle as HTMLElement).getByRole('button', { name: 'Changes' });
    await waitFor(() => expect(changes).toBeEnabled());
    fireEvent.click(changes);
    fireEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    expect(composer).not.toHaveClass('is-mobile-composer-collapsed');
    expect(screen.getByRole('button', { name: 'Collapse composer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand composer' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse composer' }));
    expect(composer).toHaveClass('is-mobile-composer-collapsed');

    fireEvent.click(screen.getByRole('button', { name: 'Expand composer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss composer' }));
    expect(composer).toHaveClass('is-mobile-composer-collapsed');
  });

  it('shows the task-type robot in a task-linked mobile conversation', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(max-width: 820px) and (pointer: coarse)', media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const conversationId = '00000000-0000-4000-8000-000000000043';
    const taskId = '00000000-0000-4000-8000-000000000044';
    const conversation = { id: conversationId, title: 'Linked mobile conversation', workItemId: taskId, pinned: false, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const item = { id: taskId, title: 'Linked mobile task', description: '', status: 'ready', priority: 2, queuePosition: 1, source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null, classificationKind: 'review', sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, stack: 'attention', workspacePath: null, strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [conversation], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'Linked mobile conversation' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand conversation tray' }));
    const taskType = await screen.findByRole('button', { name: 'Task type: Review' });
    expect(taskType.closest('.conversation-window-actions')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Task type: Review' })).toHaveLength(1);
  });

  it('sends an ordinary composer message without turning it into an interjection', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000026';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Normal send', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/shared/messages' && init?.method === 'POST') return new Response(JSON.stringify({ message: { id: 'human-1', status: 'completed' }, replies: [{ id: 'reply-1' }] }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'Normal send' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['normal message'], 'message.txt', { type: 'text/plain' })] } });
    await screen.findByText('message.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/shared/messages' && init?.method === 'POST')).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/interject'))).toBe(false);
  });

  it('returns to Conversation when sending from Changes', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000032';
    const conversation = { id: conversationId, title: 'Send from changes', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${conversationId}/workspace-diff`) return new Response(JSON.stringify({ diff: { workspacePath: '/tmp/workbench', branch: 'send-from-changes', changedFiles: 1, additions: 1, deletions: 0, publish: { branch: 'send-from-changes', hasOrigin: true, ahead: 0, hasChanges: true, reason: null }, files: [{ path: 'src/client/change.tsx', previousPath: null, status: 'modified', additions: 1, deletions: 0, isBinary: false, patch: '@@ -1 +1 @@\n-old\n+new' }] } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}`) return new Response(JSON.stringify({ conversation }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/shared/messages' && init?.method === 'POST') return new Response(JSON.stringify({ message: { id: 'human-from-changes', status: 'completed' }, replies: [{ id: 'reply-from-changes' }] }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'Send from changes' });
    const changes = screen.getByRole('button', { name: 'Changes' });
    await waitFor(() => expect(changes).toBeEnabled());
    fireEvent.click(changes);
    expect(changes).toHaveAttribute('aria-pressed', 'true');

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['follow-up'], 'follow-up.txt', { type: 'text/plain' })] } });
    await screen.findByText('follow-up.txt');
    const sendMessage = screen.getByRole('button', { name: 'Send message' });
    await waitFor(() => expect(sendMessage).toBeEnabled());
    fireEvent.click(sendMessage);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Conversation' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'false');
    // The pane returns on mutate, but the POST only leaves after the attachment
    // finishes base64 encoding, so the send is awaited rather than assumed.
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/shared/messages' && init?.method === 'POST')).toBe(true));
  });

  it('sends an ordinary composer message without exposing a separate Queue action', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000027';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Queue test', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages') && init?.method === 'POST') return new Response(JSON.stringify({ message: { id: 'human-queue', status: 'queued' }, replies: [] }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'Queue test' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['queued message'], 'queued.txt', { type: 'text/plain' })] } });
    await screen.findByText('queued.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/shared/messages' && init?.method === 'POST')).toBe(true));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/interject'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull();
  });

  it('resolves an archived conversation that is not on the loaded page via a detail lookup', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const loadedId = '00000000-0000-4000-8000-000000000020';
    const archivedId = '00000000-0000-4000-8000-000000000021';
    const archivedConversation = { id: archivedId, title: 'Archived deep link', workItemId: null, archivedAt: '2026-01-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${archivedId}`) return new Response(JSON.stringify({ conversation: archivedConversation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: loadedId, title: 'Active conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={archivedId} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Archived deep link' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/shared/conversations/${archivedId}`)).toBe(true);
  });

  it('shows an explicit error state, not the empty state, when a deep-linked conversation cannot be found', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const missingId = '00000000-0000-4000-8000-000000000022';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${missingId}`) return new Response(JSON.stringify({ error: 'Conversation not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={missingId} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Conversation not found' })).toBeTruthy();
    expect(await screen.findByText(/This conversation could not be found/)).toBeTruthy();
    expect(screen.queryByText('No messages yet. Choose a provider to get started.')).toBeNull();
  });

  it('clears a pending attachment when switching conversations', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const firstId = '00000000-0000-4000-8000-000000000023';
    const secondId = '00000000-0000-4000-8000-000000000024';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [
        { id: firstId, title: 'First conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
        { id: secondId, title: 'Second conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
      ], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={firstId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'First conversation' });
    expect(screen.getByRole('button', { name: 'Attach files' }).textContent).toBe('');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['content'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(await screen.findByText('notes.txt')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Second conversation/ }));
    await screen.findByRole('heading', { name: 'Second conversation' });
    expect(screen.queryByText('notes.txt')).toBeNull();
  });

  it('blocks sending until the conversation has finished initializing', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000025';
    let resolveMessages: (() => void) | null = null;
    const messagesGate = new Promise<void>((resolve) => { resolveMessages = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Slow to init', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) {
        await messagesGate;
        return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'Slow to init' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['content'], 'notes.txt', { type: 'text/plain' })] } });
    await screen.findByText('notes.txt');

    const sendButton = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);

    resolveMessages!();
    await waitFor(() => expect(sendButton.disabled).toBe(false));
  });

  it('autoscrolls only the message thread so conversation controls stay in the viewport', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    const scrollTo = vi.fn();
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const conversationId = '00000000-0000-4000-8000-000000000030';
    let pollCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Streaming thread', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages') && url.includes(`conversationId=${conversationId}`)) {
        pollCount += 1;
        const message = { id: 'streaming-1', conversationId, author: 'codex', body: `chunk ${'x'.repeat(pollCount)}`, pinned: false, status: 'running', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' };
        return new Response(JSON.stringify({ messages: [message] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'Streaming thread' });
    await waitFor(() => expect(pollCount).toBeGreaterThan(0));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' })));
    expect(scrollIntoView).not.toHaveBeenCalled();

    const container = document.querySelector('.shared-thread') as HTMLElement;
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2000 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 0, writable: true });
    fireEvent.scroll(container);
    scrollTo.mockClear();

    const pollBeforeScrollAway = pollCount;
    await waitFor(() => expect(pollCount).toBeGreaterThan(pollBeforeScrollAway), { timeout: 2000 });
    expect(scrollTo).not.toHaveBeenCalled();
    const jumpToLatest = screen.getByRole('button', { name: /New activity · Jump to latest/i });
    expect(jumpToLatest.parentElement).toHaveClass('conversation-thread-pane');

    fireEvent.click(jumpToLatest);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'smooth' });
    expect(screen.queryByRole('button', { name: /New activity · Jump to latest/i })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it('autoscrolls after opening another conversation with the same message shape', async () => {
    const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
      const requestedTop = typeof options.top === 'number' ? options.top : this.scrollTop;
      this.scrollTop = Math.min(requestedTop, Math.max(0, this.scrollHeight - this.clientHeight));
    });
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const firstConversationId = '00000000-0000-4000-8000-000000000032';
    const secondConversationId = '00000000-0000-4000-8000-000000000033';
    const conversations = [
      { id: firstConversationId, title: 'First same-size thread', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: secondConversationId, title: 'Second same-size thread', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations, nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) {
        const conversationId = url.includes(secondConversationId) ? secondConversationId : firstConversationId;
        return new Response(JSON.stringify({ messages: [{ id: `message-${conversationId}`, conversationId, author: 'codex', body: 'same length', pinned: false, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={firstConversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'First same-size thread' });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' })));
    const container = document.querySelector('.shared-thread') as HTMLElement;
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 400, writable: true });
    Object.defineProperty(container, 'scrollTop', { configurable: true, value: 0, writable: true });
    scrollTo.mockClear();

    fireEvent.click(screen.getByText('Second same-size thread').closest('button')!);
    (container as unknown as { scrollHeight: number }).scrollHeight = 2000;

    await screen.findByRole('heading', { name: 'Second same-size thread' });
    await waitFor(() => expect(container.scrollTop).toBe(1600));
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it('keeps a completed structured report visible after replacing live stream text', async () => {
    const conversationId = '00000000-0000-4000-8000-000000000031';
    let messageFetches = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Summary transition', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages') && url.includes(`conversationId=${conversationId}`)) {
        messageFetches += 1;
        const completed = messageFetches > 1;
        return new Response(JSON.stringify({ messages: [{ id: 'summary-transition', conversationId, author: 'codex', body: completed ? '## Decision\nThe completed report remains visible.\n\n## Verification\nThe normal-flow row expanded without overlap.' : 'Working on the report…', pinned: false, status: completed ? 'completed' : 'running', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByText('Working on the report…');
    expect(await screen.findByText('The normal-flow row expanded without overlap.', {}, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.getByLabelText('Agent response in 2 parts')).toBeInTheDocument();
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

  it('shows legacy pinned messages without exposing manual pinning controls', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000001';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const body = String(input).includes('/api/shared/conversations')
        ? { conversations: [{ id: conversationId, title: 'Automatic memory', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }
        : { messages: [{ id: 'message-1', conversationId, author: 'jeffrey', body: 'Keep this existing memory.', pinned: true, status: 'completed', error: '', createdAt: '2026-01-01T00:00:00Z', attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Keep this existing memory.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /pin message/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /show pinned/i })).toBeNull();
  });

  it('remembers a different model choice for each conversation', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const firstId = '00000000-0000-4000-8000-000000000001';
    const secondId = '00000000-0000-4000-8000-000000000002';
    const conversations = [
      { id: firstId, title: 'First task', workItemId: null, preferredExecutionProfile: 'deep', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: secondId, title: 'Second task', workItemId: null, preferredExecutionProfile: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations, nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${firstId}` || url === `/api/shared/conversations/${secondId}`) return new Response(JSON.stringify({ conversation: conversations.find((conversation) => conversation.id === url.split('/').at(-1)) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={firstId} /></QueryClientProvider>);

    const modelChoice = await screen.findByLabelText('Model choice') as HTMLSelectElement;
    fireEvent.change(modelChoice, { target: { value: 'deep' } });
    expect(modelChoice.value).toBe('deep');
    fireEvent.click(screen.getByRole('button', { name: /Second task/i }));
    expect((await screen.findByLabelText('Model choice') as HTMLSelectElement).value).toBe('auto');
    fireEvent.change(screen.getByLabelText('Model choice'), { target: { value: 'standard' } });
    fireEvent.click(screen.getByRole('button', { name: /First task/i }));
    expect((await screen.findByLabelText('Model choice') as HTMLSelectElement).value).toBe('deep');
  });

  it('offers Palmyra as a Composer provider and never as a tier', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000091';
    let conversation = { id: conversationId, title: 'Palmyra composer', workItemId: null, preferredExecutionProfile: 'deep' as string | null, preferredDispatchTarget: 'both', preferredAiProvider: 'auto', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const preferenceBodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/ai/providers?')) return new Response(JSON.stringify({ accountProfile: 'default', resolved: 'palmyra', palmyra: { available: true, reason: null, model: 'palmyra-x5' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/preferences') && init?.method === 'PATCH') {
        preferenceBodies.push(String(init.body));
        const updates = JSON.parse(String(init.body));
        conversation = { ...conversation, preferredExecutionProfile: updates.executionProfile ?? conversation.preferredExecutionProfile, preferredDispatchTarget: updates.dispatchTarget ?? conversation.preferredDispatchTarget, preferredAiProvider: updates.aiProvider ?? conversation.preferredAiProvider };
        return new Response(JSON.stringify({ conversation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}`) return new Response(JSON.stringify({ conversation }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const modelChoice = await screen.findByLabelText('Model choice') as HTMLSelectElement;
    expect(Array.from(modelChoice.options).map((option) => option.value)).toEqual(['auto', 'economy', 'standard', 'deep']);
    expect(modelChoice.querySelector('option[value="palmyra"]')).toBeNull();

    const provider = screen.getByLabelText('Provider') as HTMLSelectElement;
    expect(Array.from(provider.options).map((option) => option.textContent)).toEqual(['Codex', 'Claude', 'Palmyra', 'Codex + Claude']);
    await waitFor(() => expect(provider.querySelector('option[value="palmyra"]')).not.toBeDisabled());
    fireEvent.change(provider, { target: { value: 'palmyra' } });
    expect(provider.value).toBe('palmyra');
    await waitFor(() => expect(preferenceBodies.some((body) => body.includes('"dispatchTarget":"palmyra"') && body.includes('"aiProvider":"palmyra"'))).toBe(true));
    expect(screen.getByLabelText('Model choice')).toHaveValue('palmyra-x5');
    expect(screen.queryByText(/Palmyra is chat-only/)).toBeNull();
    expect(screen.queryByLabelText('Account profile')).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('keeps Both selected after switching away from and back to a conversation', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const firstId = '00000000-0000-4000-8000-000000000041';
    const secondId = '00000000-0000-4000-8000-000000000042';
    const conversations = [
      { id: firstId, title: 'Both recipients', workItemId: null, preferredDispatchTarget: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: secondId, title: 'Other conversation', workItemId: null, preferredDispatchTarget: 'claude', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/shared/conversations/${firstId}/preferences`) && init?.method === 'PATCH') {
        conversations[0] = { ...conversations[0], preferredDispatchTarget: 'both' };
        return new Response(JSON.stringify({ conversation: conversations[0] }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `/api/shared/conversations/${firstId}` || url === `/api/shared/conversations/${secondId}`) return new Response(JSON.stringify({ conversation: conversations.find((conversation) => conversation.id === url.split('/').at(-1)) }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations, nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={firstId} /></QueryClientProvider>);

    const recipient = await screen.findByLabelText('Provider') as HTMLSelectElement;
    fireEvent.change(recipient, { target: { value: 'both' } });
    await waitFor(() => expect(recipient.value).toBe('both'));
    fireEvent.click(screen.getByRole('button', { name: /Other conversation/i }));
    await waitFor(() => expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('claude'));
    fireEvent.click(screen.getByRole('button', { name: /Both recipients/i }));
    await waitFor(() => expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('both'));
  });

  it('restores the last recipient and model choice from conversation history', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000031';
    const timestamp = '2026-01-01T00:00:00Z';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Continue with Claude', workItemId: null, preferredExecutionProfile: 'deep', preferredAccountProfile: 'default', preferredDispatchTarget: 'claude', createdAt: timestamp, updatedAt: timestamp }], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [
        { id: 'request-1', conversationId, author: 'jeffrey', body: 'Please investigate.', pinned: false, status: 'completed', error: '', createdAt: timestamp, completedAt: timestamp, attachments: [], model: null, accountProfile: 'default', executionProfile: 'deep', inputTokens: null, outputTokens: null, fallbackFrom: null, fallbackReason: null, dispatchTarget: 'claude' },
        { id: 'reply-1', conversationId, author: 'claude', body: 'I found the regression.', pinned: false, status: 'completed', error: '', createdAt: timestamp, completedAt: timestamp, attachments: [], model: 'opus', accountProfile: 'default', executionProfile: 'deep', inputTokens: null, outputTokens: null, fallbackFrom: null, fallbackReason: null, dispatchTarget: 'none' },
      ] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByLabelText('Provider');
    await waitFor(() => expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('claude'));
    expect((screen.getByLabelText('Account profile') as HTMLSelectElement).value).toBe('default');
    expect((screen.getByLabelText('Model choice') as HTMLSelectElement).value).toBe('deep');
  });

  it('starts an empty conversation with Ask both and Auto', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000032';
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'New conversation', workItemId: null, preferredExecutionProfile: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    await screen.findByRole('heading', { name: 'New conversation' });
    expect(screen.getByRole('button', { name: 'Execution type: Execute' })).toBeInTheDocument();
    await waitFor(() => expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('both'));
    expect((screen.getByLabelText('Account profile') as HTMLSelectElement).value).toBe('default');
    expect((screen.getByLabelText('Model choice') as HTMLSelectElement).value).toBe('auto');
  });

  it('sends the execution type selected before the first response', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000042';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/shared/messages' && init?.method === 'POST') return new Response(JSON.stringify({ message: { status: 'completed' }, replies: [] }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'New conversation', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Execution type: Execute' }));
    const executionMenu = screen.getByRole('listbox', { name: 'Execution type' });
    expect(within(executionMenu).getByRole('option', { name: 'Execute' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(executionMenu).getByRole('option', { name: 'Review' }));
    const attachmentInput = document.querySelector('#conversation-composer input[type="file"]') as HTMLInputElement;
    fireEvent.change(attachmentInput, { target: { files: [new File(['review'], 'change.txt', { type: 'text/plain' })] } });
    fireEvent.submit(screen.getByLabelText('Message an agent').closest('form')!);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/shared/messages' && init?.method === 'POST' && JSON.parse(String(init.body)).executionKind === 'review')).toBe(true));
  });

  it.each([
    ['task comment', '00000000-0000-4000-8000-000000000047', undefined],
    ['conversation message', null, undefined],
    ['plan execution command', null, 'execute'],
  ])('keeps failed %s text in the composer and retries without moving focus', async (_label, workItemId, executionKind) => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = `00000000-0000-4000-8000-00000000004${executionKind === 'review' ? '8' : workItemId ? '7' : '6'}`;
    const conversation = { id: conversationId, title: `Failed ${_label}`, workItemId, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const draft = `Recover ${_label}`;
    window.localStorage.setItem('workbench:conversation-drafts', JSON.stringify({ [conversationId]: draft }));
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/shared/messages' && init?.method === 'POST') {
        attempts += 1;
        if (attempts === 1) return new Response(JSON.stringify({ error: 'Network unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ message: { id: 'recovered-message', status: 'completed' }, replies: [] }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }
      if (workItemId && url === `/api/work-items/${workItemId}`) return new Response(JSON.stringify({ item: { id: workItemId, archivedAt: null, status: 'ready' } }), { headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/shared/conversations/${conversationId}`) return new Response(JSON.stringify({ conversation }), { headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [conversation], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const composer = await screen.findByLabelText('Message an agent');
    composer.focus();
    fireEvent.submit(composer.closest('form')!);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(composer).toHaveTextContent(draft);
    expect(document.activeElement).toBe(composer);
    fireEvent.mouseDown(retry);
    fireEvent.click(retry);

    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
    expect(composer).toHaveTextContent('');
    expect(document.activeElement).toBe(composer);
    const retries = fetchMock.mock.calls.filter(([input, init]) => String(input) === '/api/shared/messages' && init?.method === 'POST');
    expect(JSON.parse(String(retries[1][1]?.body))).toMatchObject({ conversationId, body: draft, ...(executionKind ? { executionKind } : {}) });
  });

  it('keeps retry available for each failed parallel agent reply', async () => {
    const conversationId = '00000000-0000-4000-8000-000000000033';
    const timestamp = '2026-01-01T00:00:00Z';
    let resolveRetry!: () => void;
    const retryResponse = new Promise<Response>((resolve) => {
      resolveRetry = () => resolve(new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } }));
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Parallel retry', workItemId: null, createdAt: timestamp, updatedAt: timestamp }], nextCursor: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages/') && url.endsWith('/retry')) return retryResponse;
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [
        { id: 'codex-failed', conversationId, author: 'codex', body: 'Codex stopped.', pinned: false, status: 'failed', error: 'stopped', createdAt: timestamp, attachments: [], model: null, executionProfile: 'auto', dispatchTarget: 'none' },
        { id: 'claude-canceled', conversationId, author: 'claude', body: 'Claude stopped.', pinned: false, status: 'canceled', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: 'auto', dispatchTarget: 'none' },
      ] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    const retryButtons = await screen.findAllByRole('button', { name: 'Retry / continue' });
    expect(retryButtons).toHaveLength(2);
    fireEvent.click(retryButtons[0]);
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry / continue' })).toBeEnabled();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === '/api/shared/messages/codex-failed/retry' && init?.method === 'POST')).toBe(true));
    resolveRetry();
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
          results: [{ type: 'message', conversationId: matchedId, conversationTitle: 'Matched conversation', messageId: 'message-1', snippet: 'found the needle here', rank: 1 }],
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
    expect(screen.getByText('found the needle here')).toBeTruthy();
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
  it.each(['running', 'completed'] as const)('keeps the execution chat enabled and clickable while a run is %s', async (status) => {
    const taskId = `00000000-0000-4000-8000-0000000000${status === 'running' ? '31' : '32'}`;
    const conversationId = `00000000-0000-4000-8000-0000000000${status === 'running' ? '41' : '42'}`;
    const timestamp = '2026-01-01T00:00:00Z';
    const item = {
      id: taskId, title: `${status} execution chat`, description: '', status: status === 'running' ? 'in_progress' : 'ready', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', workspacePath: null,
      strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const run = {
      id: `${taskId}-run`, workItemId: taskId, kind: 'execute', requestedTarget: 'codex', requestedAgent: 'codex', agent: 'codex', status,
      instructions: '', output: '', error: '', startedAt: timestamp, completedAt: status === 'completed' ? timestamp : null, createdAt: timestamp,
      conversationId, messageId: null, model: null, accountProfile: 'default', executionProfile: null, inputTokens: null, outputTokens: null,
      fallbackFrom: null, fallbackReason: null, attempt: 0, maxAttempts: 3, nextAttemptAt: null, resolvedWorkspace: null, origin: 'manual',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === '/api/agent-accounts'
        ? { accounts: [{ name: 'default', providers: {} }] }
        : { item, parentItem: null, children: [], activity: [], runs: [run], executionPlan: null, classification: null, conversations: [], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] },
    ), { headers: { 'Content-Type': 'application/json' } })));
    const onOpenConversation = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={onOpenConversation} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    const chatExecution = await screen.findByRole('button', { name: 'Open execution chat' });
    expect(chatExecution).toBeEnabled();
    fireEvent.click(chatExecution);
    expect(onOpenConversation).toHaveBeenCalledWith(conversationId);
  });

  it('marks Agent Runs with their author so the task view can apply the conversation palette', async () => {
    const taskId = '00000000-0000-4000-8000-000000000009';
    const item = {
      id: taskId, title: 'Palette task', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', workspacePath: null,
      strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const baseRun = {
      workItemId: taskId, kind: 'execute' as const, requestedTarget: 'codex' as const, status: 'completed' as const, instructions: '', output: '', error: '',
      startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', createdAt: '2026-01-01T00:00:00Z', conversationId: null, messageId: null,
      model: null, executionProfile: null, inputTokens: null, outputTokens: null, fallbackFrom: null, fallbackReason: null,
      attempt: 0, maxAttempts: 3, nextAttemptAt: null, resolvedWorkspace: null, origin: 'manual' as const,
    };
    const runs = [
      { ...baseRun, id: '00000000-0000-4000-8000-000000000011', requestedAgent: 'codex' as const, agent: 'codex' as const },
      { ...baseRun, id: '00000000-0000-4000-8000-000000000012', requestedAgent: 'claude' as const, agent: 'claude' as const },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === '/api/agent-accounts'
        ? { accounts: [{ name: 'default', providers: { codex: { configured: true, loggedIn: true, email: null }, claude: { configured: true, loggedIn: true, email: 'jeffrey@example.com' } } }] }
        : { item, parentItem: null, children: [], activity: [], runs, executionPlan: null, classification: null, conversations: [], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] },
    ), { headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    await screen.findByText('Agent runs');
    expect(document.querySelector('.run-card[data-agent="codex"]')).toBeTruthy();
    expect(document.querySelector('.run-card[data-agent="claude"]')).toBeTruthy();

    const editProfile = await screen.findByRole('button', { name: 'Edit profile' });
    expect(editProfile).toHaveTextContent('');
    const execute = document.querySelector<HTMLButtonElement>('.execute-button');
    expect(execute).toBeTruthy();
    expect(execute).toHaveTextContent('');
    expect(screen.queryByText('ChatGPT account')).toBeNull();
    fireEvent.click(editProfile);
    expect(await screen.findByText('ChatGPT account')).toBeTruthy();
    expect(editProfile.getAttribute('aria-expanded')).toBe('true');
  });

  it('replaces an active run with the canceled response immediately', async () => {
    const taskId = '00000000-0000-4000-8000-000000000010';
    const runId = '00000000-0000-4000-8000-000000000020';
    const item = {
      id: taskId, title: 'Fix canceled run controls', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: 'https://grid-writerai.enterprise.slack.com/archives/C0BRQV6LG2V/p1787262493047899', sourceTags: ['Slack'], projectName: 'Workbench', workspacePath: null,
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const runningRun = {
      id: runId, workItemId: taskId, kind: 'execute', requestedTarget: 'codex', agent: 'codex', status: 'running', instructions: '', output: '', error: '',
      startedAt: '2026-01-01T00:00:00Z', completedAt: null, createdAt: '2026-01-01T00:00:00Z', conversationId: null, messageId: null, model: null, executionProfile: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/agent-runs/${runId}/cancel`) return new Response(JSON.stringify({ run: { ...runningRun, status: 'canceled', completedAt: '2026-01-01T00:01:00Z' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes(`/api/work-items/${taskId}`)) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [runningRun], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [item], nextCursor: null, totalCount: 1, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-item-counts') return new Response(JSON.stringify({ active: 1, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    // Opening a stack no longer opens its top task for you, so the task the
    // rest of this test inspects has to be selected first.
    fireEvent.click(await screen.findByText(item.title));
    expect(await screen.findByText('grid-writerai.enterprise.slack.com')).toBeTruthy();
    expect(screen.getByText('source')).toBeTruthy();
    expect(screen.queryByText('No Linear issues, pull requests, Slack threads, or documents linked yet.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Archive task' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete task' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('canceled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('optimistically promotes a task to the in-progress queue section as soon as it is executed', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const taskId = '00000000-0000-4000-8000-000000000021';
    let status: 'ready' | 'in_progress' = 'ready';
    const item = {
      id: taskId, title: 'Task to execute', description: '', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', workspacePath: null,
      strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    let resolveExecute: (value: Response) => void = () => {};
    const executeResponse = new Promise<Response>((resolve) => { resolveExecute = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}/execute`) return executeResponse;
      if (url === `/api/agent-accounts`) return new Response(JSON.stringify({ accounts: [{ name: 'default', providers: {} }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes(`/api/work-items/${taskId}`)) return new Response(JSON.stringify({ item: { ...item, status }, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [], providerConflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [{ ...item, status }], nextCursor: null, totalCount: 1, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-item-counts') return new Response(JSON.stringify({ active: 1, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByText(item.title));
    expect(document.querySelector('.stack-header-progress')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Execute task' }));

    await waitFor(() => expect(document.querySelector('.stack-header-progress')).toBeTruthy());

    status = 'in_progress';
    resolveExecute(new Response(JSON.stringify({
      run: { id: 'run-1', workItemId: taskId, kind: 'execute', status: 'running' },
      runs: [],
      classification: null,
      conversation: { id: 'conversation-1', title: '', messages: [] },
      activity: { id: 'activity-1', workItemId: taskId, kind: 'execution', body: '', createdAt: '2026-01-01T00:00:00Z' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Executing task' })).toBeTruthy());
  });
});

describe('task prerequisites', () => {
  it('shows toast feedback for task-detail saves and errors', async () => {
    const taskId = '00000000-0000-4000-8000-000000000039';
    const candidateId = '00000000-0000-4000-8000-000000000038';
    const timestamp = '2026-01-01T00:00:00Z';
    let item = {
      id: taskId, title: 'Editable task', description: '', status: 'backlog', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', stack: 'attention', workspacePath: null,
      strategy: '', assignees: [] as string[], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [] as Array<{ id: string; title: string; status: string; isOpen: boolean }>,
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const candidate = { ...item, id: candidateId, title: 'A prerequisite', blockedBy: [] };
    const dependency = { id: candidateId, title: 'A prerequisite', status: 'backlog', isOpen: true };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/dependency-candidates')) return new Response(JSON.stringify({ items: [candidate] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/work-items/${taskId}` && init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as { title?: string; description?: string; assignees?: string[]; blockedByIds?: string[] };
        if (patch.assignees?.includes('claude')) return new Response(JSON.stringify({ error: 'Owner is already assigned.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        item = {
          ...item,
          ...patch,
          blockedBy: patch.blockedByIds ? [dependency] : item.blockedBy,
        };
        return new Response(JSON.stringify({ item }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [], providerConflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onOpenTask = vi.fn();
    render(<QueryClientProvider client={client}><Toaster /><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={onOpenTask} onCreated={vi.fn()} /></QueryClientProvider>);

    fireEvent.click(await screen.findByTitle('Click to edit title'));
    fireEvent.change(screen.getByDisplayValue('Editable task'), { target: { value: 'Saved title' } });
    fireEvent.blur(screen.getByDisplayValue('Saved title'));
    expect(await screen.findByText('Title saved.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'codex' }));
    expect(await screen.findByText('Owners saved.')).toBeTruthy();

    const search = screen.getByRole('textbox', { name: 'Search tasks to add as a prerequisite' });
    fireEvent.change(search, { target: { value: 'prerequisite' } });
    fireEvent.click(await screen.findByRole('button', { name: /A prerequisite/ }));
    expect(await screen.findByText('Prerequisites saved.')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Open A prerequisite'));
    expect(onOpenTask).toHaveBeenCalledWith(candidateId);

    fireEvent.click(screen.getByRole('button', { name: 'claude' }));
    expect(await screen.findByText('Could not save the owners.')).toBeTruthy();
    expect(screen.getByText('Owner is already assigned.')).toBeTruthy();
    expect(screen.queryByText(/Could not save changes:/)).toBeNull();
  });

  it('offers an Undo action on the archive and complete toasts that restores the task', async () => {
    const taskId = '00000000-0000-4000-8000-000000000042';
    const timestamp = '2026-01-01T00:00:00Z';
    let item = {
      id: taskId, title: 'Archivable task', description: '', status: 'backlog', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null as string | null, completedAt: null as string | null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', stack: 'attention', workspacePath: null,
      strategy: '', assignees: [] as string[], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [] as Array<{ id: string; title: string; status: string; isOpen: boolean }>,
      createdAt: timestamp, updatedAt: timestamp, lastTouchedAt: timestamp,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}/archive` && init?.method === 'POST') { item = { ...item, archivedAt: timestamp, completionStatus: 'incomplete' }; return new Response(JSON.stringify({ item }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      if (url === `/api/work-items/${taskId}/restore` && init?.method === 'POST') { item = { ...item, archivedAt: null, completionStatus: 'incomplete' }; return new Response(JSON.stringify({ item }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [], providerConflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = vi.fn();
    render(<QueryClientProvider client={client}><Toaster /><TaskDetail id={taskId} onClose={onClose} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive task' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/work-items/${taskId}/archive` && init?.method === 'POST')).toBe(true));

    const undoButton = await screen.findByRole('button', { name: 'Undo: Task archived.' });
    fireEvent.click(undoButton);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/work-items/${taskId}/restore` && init?.method === 'POST')).toBe(true));
    expect(await screen.findByText('Task restored.')).toBeTruthy();
  });

  it('only loads addable tasks after an explicit search', async () => {
    const taskId = '00000000-0000-4000-8000-000000000040';
    const candidateId = '00000000-0000-4000-8000-000000000041';
    const item = {
      id: taskId, title: 'Dependent task', description: '', status: 'backlog', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', stack: 'attention', workspacePath: null,
      strategy: '', assignees: ['jeffrey'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const candidate = { ...item, id: candidateId, title: 'Matching blocker' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/dependency-candidates')
        ? { items: [candidate] }
        : { item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [], providerConflicts: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    const search = await screen.findByRole('textbox', { name: 'Search tasks to add as a prerequisite' });
    expect(screen.queryByText('Matching blocker')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/dependency-candidates'))).toBe(false);

    fireEvent.change(search, { target: { value: '  blocker  ' } });

    expect(await screen.findByText('Matching blocker')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/work-items/${taskId}/dependency-candidates?q=blocker`)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Matching blocker/ }));
    expect((search as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(screen.queryByText('Matching blocker')).toBeNull());
  });
});

describe('task linked items', () => {
  it('links an existing task and an unlinked artifact from the relationship section', async () => {
    const taskId = '00000000-0000-4000-8000-000000000050';
    const linkedTaskId = '00000000-0000-4000-8000-000000000051';
    const item = {
      id: taskId, title: 'Current task', description: '', status: 'backlog', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null,
      sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', stack: 'attention', workspacePath: null, strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const linkedTask = { ...item, id: linkedTaskId, title: 'Related task' };
    const artifact = { id: 'artifact-1', title: 'Implementation notes', url: 'https://artifacts.example.com/notes', version: 1, workItemId: null, workItemTitle: null, conversationId: null, conversationTitle: null, publishedAt: item.createdAt, revokedAt: null, versionCount: 1, commentCount: 0, openCommentCount: 0 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      void init;
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [linkedTask], nextCursor: null, totalCount: 1, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/artifacts?view=published') return new Response(JSON.stringify({ artifacts: [artifact], counts: { published: 1, revoked: 0, openComments: 0 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Link another task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks to link' }), { target: { value: 'related' } });
    fireEvent.click(await screen.findByRole('button', { name: /Related task/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === `/api/work-items/${taskId}/linked-tasks` && init?.method === 'POST')).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Link an artifact' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search unlinked artifacts' }), { target: { value: 'notes' } });
    fireEvent.click(await screen.findByRole('button', { name: /Implementation notes/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/artifacts/artifact-1' && init?.method === 'PATCH' && init.body === JSON.stringify({ workItemId: taskId }))).toBe(true));
  });

  it('shows a distinct inline error for every failed relationship mutation', async () => {
    const taskId = '00000000-0000-4000-8000-000000000052';
    const linkedTaskId = '00000000-0000-4000-8000-000000000053';
    const item = {
      id: taskId, title: 'Current task', description: '', status: 'backlog', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null,
      sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: 'Workbench', stack: 'attention', workspacePath: null, strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const linkedTask = { ...item, id: linkedTaskId, title: 'Related task' };
    const taskCandidate = { ...item, id: '00000000-0000-4000-8000-000000000054', title: 'Task to link' };
    const reference = { id: 'reference-1', workItemId: taskId, type: 'document' as const, url: 'https://example.com/reference', title: 'Reference', createdAt: item.createdAt };
    const artifact = { id: 'artifact-1', title: 'Implementation notes', url: 'https://artifacts.example.com/notes', version: 1, workItemId: null, workItemTitle: null, conversationId: null, conversationTitle: null, publishedAt: item.createdAt, revokedAt: null, versionCount: 1, commentCount: 0, openCommentCount: 0 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [taskCandidate], nextCursor: null, totalCount: 1, proposal: null }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/artifacts?view=published') return new Response(JSON.stringify({ artifacts: [artifact], counts: { published: 1, revoked: 0, openComments: 0 } }), { headers: { 'Content-Type': 'application/json' } });
      if ((url === `/api/work-items/${taskId}/references` && init?.method === 'POST')
        || (url === `/api/work-items/${taskId}/references/${reference.id}` && init?.method === 'DELETE')
        || (url === `/api/work-items/${taskId}/linked-tasks` && init?.method === 'POST')
        || (url === `/api/work-items/${taskId}/linked-tasks/${linkedTaskId}` && init?.method === 'DELETE')
        || (url === `/api/artifacts/${artifact.id}` && init?.method === 'PATCH')) {
        return new Response(JSON.stringify({ error: 'Relationship request failed.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], linkedTasks: [linkedTask], references: [reference], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    async function expectRelationshipError(action: () => void, message: string) {
      action();
      expect(await screen.findByText(`${message}: Relationship request failed.`)).toHaveClass('error-message');
    }

    await screen.findByText('Reference');
    fireEvent.click(screen.getByRole('button', { name: 'Link Linear, PR, Slack, or a document' }));
    fireEvent.change(screen.getByPlaceholderText('https://…'), { target: { value: 'https://example.com/new-reference' } });
    await expectRelationshipError(() => fireEvent.click(screen.getByRole('button', { name: 'Link' })), 'Could not add reference');

    await expectRelationshipError(() => fireEvent.click(screen.getByRole('button', { name: 'Remove reference' })), 'Could not remove reference');

    fireEvent.click(screen.getByRole('button', { name: 'Link another task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks to link' }), { target: { value: 'related' } });
    const taskLinkCandidate = (await screen.findAllByRole('button', { name: /Task to link/ })).find((button) => button.closest('li'));
    if (!taskLinkCandidate) throw new Error('Expected a task-link candidate.');
    await expectRelationshipError(() => fireEvent.click(taskLinkCandidate), 'Could not link task');

    await expectRelationshipError(() => fireEvent.click(screen.getByRole('button', { name: 'Remove linked task Related task' })), 'Could not remove linked task');

    fireEvent.click(screen.getByRole('button', { name: 'Link an artifact' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search unlinked artifacts' }), { target: { value: 'notes' } });
    await expectRelationshipError(() => fireEvent.click(screen.getByRole('button', { name: /Implementation notes/ })), 'Could not link artifact');
  });
});

describe('task activity log', () => {
  it('labels each entry by kind and marks agent decisions', async () => {
    const taskId = '00000000-0000-4000-8000-000000000060';
    const item = {
      id: taskId, title: 'Logged task', description: '', status: 'in_progress', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, stack: 'attention', workspacePath: null,
      strategy: '', assignees: ['codex'], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    const activity = [
      { id: 'act-1', workItemId: taskId, actor: 'system', kind: 'model_selected', body: 'Model: codex gpt-5.6-terra · standard tier, medium effort (matched to the task context). Running execute.', createdAt: '2026-01-01T00:02:00Z' },
      { id: 'act-2', workItemId: taskId, actor: 'system', kind: 'execution_started', body: 'Execution type: execute (AI classifier: the deliverable is code changes). Agent: codex (auto-picked to balance agent load). Model tier: auto (picked when the run starts).', createdAt: '2026-01-01T00:01:00Z' },
      { id: 'act-3', workItemId: taskId, actor: 'jeffrey', kind: 'edited', body: 'Status: ready → in_progress.', createdAt: '2026-01-01T00:00:30Z' },
      { id: 'act-4', workItemId: taskId, actor: 'jeffrey', kind: 'completed', body: 'Completed and moved to the archive.', createdAt: '2026-01-01T00:00:20Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ item, parentItem: null, children: [], activity, runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [], providerConflicts: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    expect(await screen.findByText(/AI classifier: the deliverable is code changes/)).toBeTruthy();
    expect(screen.getByText(/codex gpt-5.6-terra/)).toBeTruthy();
    expect(screen.getByText('Status: ready → in_progress.')).toBeTruthy();

    const decisionLabels = screen.getAllByText(/^(routing|model)$/).map((node) => node.closest('.activity')?.className);
    expect(decisionLabels).toEqual(['activity decision', 'activity decision']);
    expect(screen.getByText('edit').closest('.activity')?.className).toBe('activity');

    // Jeffrey's own lifecycle moves are logged, but they are his changes rather
    // than routing decisions, so they stay unhighlighted and out of the count.
    expect(screen.getByText('Completed and moved to the archive.')).toBeTruthy();
    expect(screen.getByText('done').closest('.activity')?.className).toBe('activity');
    expect(screen.getByText(/4 events · 2 agent decisions/)).toBeTruthy();
  });
});

describe('task creation from search', () => {
  const searchResult = { source: 'linear' as const, title: 'ENG · Search-created task', summary: 'Imported from search.', url: 'https://linear.app/team/issue/ENG-1', occurredAt: null };

  function renderSearchCreate(fetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(fetchMock));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  }

  async function searchForTask() {
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.click(screen.getByRole('button', { name: /From search/i }));
    fireEvent.change(screen.getByPlaceholderText('Search Linear, Slack, Atlassian, and GitHub…'), { target: { value: 'search-created' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    return await screen.findByRole('button', { name: /Search-created task/ });
  }

  it('shows an error toast when a searched task cannot be created', async () => {
    renderSearchCreate(async (input, init) => {
      const url = String(input);
      if (url === '/api/sources/search') {
        const { sources } = JSON.parse(String(init?.body)) as { sources: string[] };
        return new Response(JSON.stringify({ results: sources[0] === 'linear' ? [searchResult] : [], errors: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items' && init?.method === 'POST') return new Response(JSON.stringify({ error: 'Title must not be empty.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [], nextCursor: null, totalCount: 0, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/counts') return new Response(JSON.stringify({ active: 0, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const addResult = await searchForTask();
    fireEvent.click(addResult);

    expect(await screen.findByText('Could not add the task from search.')).toBeTruthy();
    expect(screen.getByText('Title must not be empty.')).toBeTruthy();
    await waitFor(() => expect((addResult as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows a success toast after creating a searched task', async () => {
    let created = false;
    const item = {
      id: '00000000-0000-4000-8000-000000000031', title: 'Search-created task', description: searchResult.summary, status: 'backlog', priority: 2, queuePosition: 0,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null,
      sourceIdentifier: null, sourceUrl: searchResult.url, sourceTags: ['Linear'], projectName: null, stack: 'attention', workspacePath: null,
      strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    renderSearchCreate(async (input, init) => {
      const url = String(input);
      if (url === '/api/sources/search') {
        const { sources } = JSON.parse(String(init?.body)) as { sources: string[] };
        return new Response(JSON.stringify({ results: sources[0] === 'linear' ? [searchResult] : [], errors: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === '/api/work-items' && init?.method === 'POST') {
        created = true;
        return new Response(JSON.stringify({ item }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `/api/work-items/${item.id}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: created ? [item] : [], nextCursor: null, totalCount: created ? 1 : 0, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-items/counts') return new Response(JSON.stringify({ active: 1, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    fireEvent.click(await searchForTask());

    await waitFor(() => expect(getToasts()).toContainEqual(expect.objectContaining({ tone: 'success', message: 'Task added to queue.', description: 'Search-created task' })));
    expect(await screen.findByText('Task added to queue.')).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(`/tasks/${item.id}`));
  });
});

describe('stack navigation', () => {
  it('returns from a conversation to the task’s stack card and centers it', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    const taskId = '00000000-0000-4000-8000-000000000029';
    const conversationId = '00000000-0000-4000-8000-000000000028';
    const item = {
      id: taskId, title: 'Conversation-linked task', description: '', status: 'backlog', priority: 2, queuePosition: 7,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, workspacePath: null,
      strategy: '', assignees: ['jeffrey'], labels: [], dueDate: null, providerUpdatedAt: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/shared/conversations')) return new Response(JSON.stringify({ conversations: [{ id: conversationId, title: 'Task conversation', workItemId: taskId, createdAt: item.createdAt, updatedAt: item.updatedAt }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === `/api/work-items/${taskId}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [item], nextCursor: null, totalCount: 1, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-item-counts') return new Response(JSON.stringify({ active: 1, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: /conversations/i }));
    fireEvent.click(await within(screen.getByLabelText('Conversations')).findByRole('button', { name: /Task conversation/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Back to task' }));

    expect(await screen.findByRole('heading', { name: 'Attention stack' })).toBeTruthy();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
  });

  it('centers a newly created task at its scored position', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    const item = {
      id: '00000000-0000-4000-8000-000000000030', title: 'Scored task', description: '', status: 'backlog', priority: 2, queuePosition: 7,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, workspacePath: null,
      strategy: '', assignees: ['jeffrey'], labels: [], dueDate: null, providerUpdatedAt: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    };
    let created = false;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/work-items' && init?.method === 'POST') {
        created = true;
        return new Response(JSON.stringify({ item }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      if (url === `/api/work-items/${item.id}`) return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: created ? [item] : [], nextCursor: null, totalCount: created ? 1 : 0, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-item-counts') return new Response(JSON.stringify({ active: 0, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual task/i }));
    fireEvent.change(screen.getByPlaceholderText('What needs to happen?'), { target: { value: item.title } });
    fireEvent.change(screen.getByLabelText('Task type'), { target: { value: 'bugfix' } });
    fireEvent.click(screen.getByRole('button', { name: /Add to queue/i }));

    await waitFor(() => expect(screen.getByText(item.title)).toBeTruthy());
    const createCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input, init]) => String(input) === '/api/work-items' && (init as RequestInit | undefined)?.method === 'POST');
    expect(JSON.parse((createCall?.[1] as RequestInit).body as string)).toEqual(expect.objectContaining({ classificationKind: 'bugfix' }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
  });

  it('opens the add-task dialog on the manual task view by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === '/api/work-item-counts' ? { active: 0, workbench: 0, archive: 0 }
        : url.startsWith('/api/work-items?') ? { items: [], nextCursor: null, totalCount: 0, proposal: null }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));

    expect(screen.getByRole('button', { name: /Manual task/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /From search/i }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByPlaceholderText('What needs to happen?')).toBeTruthy();
  });

  it('moves roving focus between queue rows with ArrowDown/ArrowUp and opens the focused row with Enter', async () => {
    const makeItem = (id: string, title: string, queuePosition: number) => ({
      id, title, description: '', status: 'backlog', priority: 2, queuePosition,
      source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
      agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, workspacePath: null,
      strategy: '', assignees: ['jeffrey'], labels: [], dueDate: null, providerUpdatedAt: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
    });
    const itemA = makeItem('00000000-0000-4000-8000-000000000041', 'First queue row', 0);
    const itemB = makeItem('00000000-0000-4000-8000-000000000042', 'Second queue row', 1);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/work-items?')) return new Response(JSON.stringify({ items: [itemA, itemB], nextCursor: null, totalCount: 2, proposal: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/work-item-counts') return new Response(JSON.stringify({ active: 2, workbench: 0, archive: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    await screen.findByText(itemA.title);
    await screen.findByText(itemB.title);
    const rowA = document.querySelector<HTMLElement>(`[data-work-item-id="${itemA.id}"]`)!;
    const rowB = document.querySelector<HTMLElement>(`[data-work-item-id="${itemB.id}"]`)!;
    // The first rendered row is focusable by default (roving tabindex).
    expect(rowA.tabIndex).toBe(0);
    expect(rowB.tabIndex).toBe(-1);

    fireEvent.keyDown(rowA, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowB);

    fireEvent.keyDown(rowB, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rowA);

    fireEvent.keyDown(rowA, { key: 'Enter' });
    expect(window.location.pathname).toBe(`/tasks/${itemA.id}`);
  });
});

describe('primary nav hover rail', () => {
  function stubEmptyQueue() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === '/api/work-item-counts' ? { active: 0, workbench: 0, archive: 0 }
        : url.startsWith('/api/work-items?') ? { items: [], nextCursor: null, totalCount: 0, proposal: null }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  }

  it('releases pointer focus after changing tabs so the rail closes on mouse-out', async () => {
    stubEmptyQueue();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    const workbench = await screen.findByRole('button', { name: /workbench/i });
    workbench.focus();
    expect(document.activeElement).toBe(workbench);

    fireEvent.click(workbench, { detail: 1 });
    expect(document.activeElement).not.toBe(workbench);
    expect(await screen.findByRole('heading', { name: 'Workbench focus' })).toBeTruthy();
  });

  it('makes Archive a filter in the task stack, not a nav destination', async () => {
    stubEmptyQueue();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    expect(document.querySelector('#primary-nav')?.textContent).not.toContain('Archive');
    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    expect(await screen.findByRole('heading', { name: 'Attention stack' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /archive/i }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows each archive filter count before its archived list loads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === '/api/work-item-counts'
        ? { active: 0, workbench: 0, archive: 6, attentionArchive: 2, workbenchArchive: 4 }
        : url.startsWith('/api/work-items?')
          ? { items: [], nextCursor: null, totalCount: url.includes('view=workbench-archive') ? 4 : 2, proposal: null }
          : { items: [], conversations: [], messages: [], count: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    expect(await screen.findByRole('button', { name: 'Archive 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workbench 0' }));
    expect(await screen.findByRole('button', { name: 'Archive 4' })).toBeTruthy();
  });

  it('keeps secondary destinations behind the mobile More control', async () => {
    stubEmptyQueue();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    const more = await screen.findByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-controls')).toBe('mobile-nav-more');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /insights/i }));
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('never renders the mobile More control on a desktop-width viewport', async () => {
    stubEmptyQueue();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    await screen.findByRole('button', { name: /archive/i });
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });
});

describe('self-assigned ownership', () => {
  const taskId = '00000000-0000-4000-8000-000000000060';
  const baseItem = {
    id: taskId, title: 'Task Jeffrey claimed', description: '', status: 'backlog', priority: 2, queuePosition: 0,
    source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
    agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, stack: 'attention', workspacePath: null,
    strategy: '', labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
  };

  const renderDetail = (assignees: string[]) => {
    const item = { ...baseItem, assignees };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/execute')) return new Response(JSON.stringify({
        run: { id: 'palmyra-run', workItemId: taskId, agent: 'palmyra', executionProfile: 'palmyra-x5', status: 'running' },
        runs: [{ id: 'palmyra-run', workItemId: taskId, agent: 'palmyra', executionProfile: 'palmyra-x5', status: 'running' }],
        classification: { kind: 'execute', agent: 'palmyra', complex: false, instructions: 'Execute it.', source: 'manual' },
        conversation: { id: 'palmyra-conversation', title: baseItem.title },
        activity: { id: 'palmyra-activity', workItemId: taskId, kind: 'execution_started', body: '', createdAt: new Date().toISOString() },
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(
        url.includes('/dependency-candidates')
          ? { items: [] }
          : { item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [], providerConflicts: [] },
      ), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);
    return fetchMock;
  };

  const patches = (fetchMock: ReturnType<typeof renderDetail>) => fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(String(init?.body)) as { assignees?: string[] });

  it('locks agent owners and execution while Jeffrey owns the task', async () => {
    const fetchMock = renderDetail(['jeffrey']);

    const owners = (await screen.findByText('Owners')).parentElement!.querySelector('.assignee-picker') as HTMLElement;
    const codex = within(owners).getByRole('button', { name: /codex/i });
    expect(codex.hasAttribute('disabled')).toBe(true);
    expect(within(owners).getByRole('button', { name: /claude/i }).hasAttribute('disabled')).toBe(true);
    expect(within(owners).getByRole('button', { name: /palmyra/i }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(codex);
    expect(patches(fetchMock)).toEqual([]);

    const execute = screen.getByRole('button', { name: /assigned to you/i });
    expect(execute.hasAttribute('disabled')).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/execute'))).toBe(false);
  });

  it('releases the agent owners once Jeffrey unassigns himself', async () => {
    const fetchMock = renderDetail(['jeffrey']);

    fireEvent.click(await screen.findByRole('button', { name: /jeffrey/i }));

    await waitFor(() => expect(patches(fetchMock)).toEqual([{ assignees: [] }]));
  });

  it('claiming the task replaces the agent owners with Jeffrey', async () => {
    const fetchMock = renderDetail(['codex']);

    fireEvent.click(await screen.findByRole('button', { name: /jeffrey/i }));

    await waitFor(() => expect(patches(fetchMock)).toEqual([{ assignees: ['jeffrey'] }]));
  });

  it('leaves execution available when only agents own the task', async () => {
    renderDetail(['codex']);

    const execute = await screen.findByRole('button', { name: 'Execute task' });
    expect(execute.hasAttribute('disabled')).toBe(false);
    expect(within(document.querySelector('.assignee-picker')!).getByRole('button', { name: /claude/i }).hasAttribute('disabled')).toBe(false);
  });

  it('offers Palmyra ownership and X5/X6 execution without a CLI account profile', async () => {
    const fetchMock = renderDetail(['palmyra']);

    const owners = (await screen.findByText('Owners')).parentElement!.querySelector('.assignee-picker') as HTMLElement;
    expect(within(owners).getByRole('button', { name: /palmyra/i })).toHaveClass('selected');
    const model = screen.getByLabelText('Model choice') as HTMLSelectElement;
    expect(Array.from(model.options).map((option) => option.value)).toEqual(['palmyra-x5', 'palmyra-x6']);
    expect(screen.queryByLabelText('Account profile')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
    const execute = screen.getByRole('button', { name: 'Execute task' });
    expect(execute).toBeEnabled();
    fireEvent.click(execute);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/execute'))).toBe(true));
    const executeCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/execute'))!;
    expect(JSON.parse(String(executeCall[1]?.body))).toMatchObject({ executionProfile: 'palmyra-x5' });
  });

  it('uses the app dialog before permanently deleting a task', async () => {
    const fetchMock = renderDetail([]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete task' }));
    expect(await screen.findByRole('dialog', { name: `Delete “${baseItem.title}”?` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    fireEvent.click(await within(screen.getByRole('dialog', { name: `Delete “${baseItem.title}”?` })).findByRole('button', { name: 'Delete task' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/work-items/${taskId}` && init?.method === 'DELETE')).toBe(true));
  });

  it('keeps task lifecycle controls icon-only with accessible names', async () => {
    renderDetail([]);

    for (const name of ['Create follow-up task', 'Put a pin in it', 'Archive task', 'Complete task', 'Delete task']) {
      const control = await screen.findByRole('button', { name });
      expect(control.textContent).toBe('');
      expect(control.getAttribute('title')).toBe(name);
    }
  });
});

describe('addressable navigation', () => {
  const taskId = '00000000-0000-4000-8000-000000000090';
  const item = {
    id: taskId, title: 'Task opened from a link', description: '', status: 'backlog', priority: 2, queuePosition: 0,
    source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
    agentOutcome: null, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, stack: 'attention', workspacePath: null,
    strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
  };

  function stubWorkbench(conversations: Array<Record<string, unknown>> = []) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === '/api/work-item-counts' ? { active: 1, workbench: 0, archive: 0 }
        : url === `/api/work-items/${taskId}` ? { item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }
        : url.startsWith('/api/work-items?') ? { items: [item], nextCursor: null, totalCount: 1, proposal: null }
        : url === '/api/shared/conversations-unread-count' ? { count: 0 }
        : url.includes('/api/shared/conversations') ? { conversations, nextCursor: null }
        : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
  }

  function renderApp() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
  }

  async function goBack() {
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    });
  }

  it('opens the task named in the address on a cold load', async () => {
    stubWorkbench();
    window.history.replaceState(null, '', `/tasks/${taskId}`);
    renderApp();

    expect(await screen.findByRole('heading', { name: item.title })).toBeTruthy();
  });

  it('gives each destination its own address and steps back through them', async () => {
    stubWorkbench();
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /workbench/i }));
    expect(await screen.findByRole('heading', { name: 'Workbench focus' })).toBeTruthy();
    expect(window.location.pathname).toBe('/workbench');

    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    expect(await screen.findByRole('heading', { name: 'Workbench focus' })).toBeTruthy();
    expect(window.location.pathname).toBe('/workbench/archive');

    await goBack();
    expect(window.location.pathname).toBe('/workbench');
    expect(await screen.findByRole('heading', { name: 'Workbench focus' })).toBeTruthy();
  });

  it('puts an opened task in the address and returns to the stack on back', async () => {
    stubWorkbench();
    window.history.replaceState(null, '', '/archive');
    renderApp();

    fireEvent.click(await screen.findByText(item.title));
    await waitFor(() => expect(window.location.pathname).toBe(`/tasks/${taskId}`));
    expect(await screen.findByRole('heading', { name: item.title })).toBeTruthy();

    await goBack();
    expect(window.location.pathname).toBe('/archive');
    expect(await screen.findByRole('heading', { name: 'Attention stack' })).toBeTruthy();
  });

  it('closes an open Workbench task when Workbench is selected again', async () => {
    const workbenchItem = { ...item, projectName: 'Workbench', stack: 'workbench' };
    window.history.replaceState(null, '', `/tasks/${taskId}`);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === '/api/work-item-counts' ? { active: 0, workbench: 1, archive: 0 }
        : url === `/api/work-items/${taskId}` ? { item: workbenchItem, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }
        : url.startsWith('/api/work-items?') ? { items: [workbenchItem], nextCursor: null, totalCount: 1, proposal: null }
        : url === '/api/shared/conversations-unread-count' ? { count: 0 }
        : url.includes('/api/shared/conversations') ? { conversations: [], nextCursor: null }
        : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    renderApp();

    expect(await screen.findByRole('heading', { name: item.title })).toBeTruthy();
    fireEvent.click(await within(document.querySelector('#primary-nav')!).findByRole('button', { name: /workbench/i }));
    expect(window.location.pathname).toBe('/workbench');
    expect(await screen.findByRole('heading', { name: 'Workbench focus' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: item.title })).toBeNull();
  });

  it('opens Workbench without consuming an archived saved task', async () => {
    const archivedWorkbenchItem = { ...item, projectName: 'Workbench', stack: 'workbench', archivedAt: '2026-01-03T00:00:00Z', completedAt: '2026-01-03T00:00:00Z', completionStatus: 'completed' };
    window.localStorage.setItem('workbench:last-opened-workbench-item', taskId);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url === '/api/work-item-counts' ? { active: 0, workbench: 0, archive: 1 }
        : url === `/api/work-items/${taskId}` ? { item: archivedWorkbenchItem, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [] }
        : url.startsWith('/api/work-items?') ? { items: [], nextCursor: null, totalCount: 0, proposal: null }
        : url === '/api/shared/conversations-unread-count' ? { count: 0 }
        : url.includes('/api/shared/conversations') ? { conversations: [], nextCursor: null }
        : { messages: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    renderApp();

    fireEvent.click(await screen.findByRole('button', { name: /workbench/i }));

    await waitFor(() => expect(window.location.pathname).toBe('/workbench'));
    expect(await screen.findByRole('heading', { name: 'Workbench focus' })).toBeTruthy();
    expect(window.localStorage.getItem('workbench:last-opened-workbench-item')).toBe(taskId);
  });

  it('opens the conversation named in the address and addresses the next one you pick', async () => {
    const firstId = '00000000-0000-4000-8000-000000000091';
    const secondId = '00000000-0000-4000-8000-000000000092';
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    stubWorkbench([
      { id: firstId, title: 'First conversation', workItemId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { id: secondId, title: 'Second conversation', workItemId: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    window.history.replaceState(null, '', `/conversations/${secondId}`);
    renderApp();

    expect(await screen.findByRole('heading', { name: 'Second conversation' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /First conversation/i }));
    expect(await screen.findByRole('heading', { name: 'First conversation' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe(`/conversations/${firstId}`));

    await goBack();
    expect(window.location.pathname).toBe(`/conversations/${secondId}`);
    expect(await screen.findByRole('heading', { name: 'Second conversation' })).toBeTruthy();
  });
});
