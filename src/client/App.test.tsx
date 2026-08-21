// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, SharedWorkspace, TaskDetail } from './App';
import { hideWorkbenchControlBlocks, humanizeRunOutput } from './run-output';
import { toast } from './toast-store';

// The URL is real navigation state now, so it has to be reset between tests
// the same way the store and the DOM are.
afterEach(() => { cleanup(); toast.clear(); window.localStorage.clear(); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); });

describe('primary navigation', () => {
  it('opens the Insights dashboard from the navigation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/insights')
        ? { windowDays: 30, retryRate: 0, fallbackRate: 0, costByDay: [], byAgent: [], byKind: [], completedRuns: 0, completedTasks: 0, medianTaskCycleMs: null, followUpsCreated: 0, agentFit: [], cursing: { total: 0, messagesAnalyzed: 0, messagesWithCurses: 0, instancesPer100Messages: 0, byTerm: [], byDay: [] } }
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
});

describe('shared room', () => {
  it('uses the app dialog before permanently deleting a manual conversation', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000099';
    const conversation = { id: conversationId, title: 'Disposable conversation', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/shared/conversations/${conversationId}` && init?.method === 'DELETE') return new Response(null, { status: 204 });
      const body = url.includes('/api/shared/conversations') ? { conversations: [conversation], nextCursor: null } : { messages: [] };
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
    const { rerender } = render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={requestedId} /></QueryClientProvider>);

    expect(await screen.findByRole('heading', { name: 'Requested task' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /First task/i }));
    expect(await screen.findByRole('heading', { name: 'First task' })).toBeTruthy();
    rerender(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={requestedId} /></QueryClientProvider>);
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

  it('keeps an archived conversation selected and switches to the archive view', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const conversationId = '00000000-0000-4000-8000-000000000009';
    const active = { id: conversationId, title: 'Conversation to archive', workItemId: null, archivedAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const archived = { ...active, archivedAt: '2026-01-02T00:00:00Z' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/api/shared/conversations/${conversationId}/archive`) && init?.method === 'POST') return new Response(JSON.stringify({ conversation: archived }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.includes('/api/shared/conversations?')) return new Response(JSON.stringify({ conversations: url.includes('view=archive') ? [archived] : [active], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole('button', { name: 'Archive conversation' }));

    expect(await screen.findByRole('heading', { name: 'Conversation to archive' })).toBeTruthy();
    expect(await screen.findByText(/Archived conversation · restore or fork it to continue/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'New conversation' })).toBeNull();
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

  it('completes a linked task from its conversation and keeps the archived thread selected', async () => {
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

    fireEvent.click(await screen.findByRole('button', { name: 'Complete linked task' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/work-items/${taskId}/complete` && init?.method === 'POST')).toBe(true));
    expect((await screen.findByRole('button', { name: 'Task completed' })).hasAttribute('disabled')).toBe(true);
    expect(await screen.findByText(/Archived conversation · restore or fork it to continue/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Finish from chat' })).toBeTruthy();
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
      if (url.startsWith('/api/shared/messages')) return new Response(JSON.stringify({ messages: [{ id: 'promotion-1', conversationId, author: 'system', body: 'Preview approved and promoted. The live Workbench switched to the verified release without changing its URL.', pinned: false, status: 'completed', error: '', createdAt: timestamp, attachments: [], model: null, executionProfile: null, dispatchTarget: 'none' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/runtime/preview-status') return new Response(JSON.stringify({ pending: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SharedWorkspace initialConversationId={conversationId} /></QueryClientProvider>);

    expect(await screen.findByText('Complete the linked task?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Complete task' })).toBeTruthy();
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
    const composer = await screen.findByLabelText('Message Codex or Claude');
    expect(composer.getAttribute('contenteditable')).toBe('true');
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
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('canceled')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('task prerequisites', () => {
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
    expect(screen.queryByText('Matching blocker')).toBeNull();
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

    fireEvent.click(await screen.findByRole('button', { name: 'New' }));
    fireEvent.click(screen.getByRole('button', { name: /Manual task/i }));
    fireEvent.change(screen.getByPlaceholderText('What needs to happen?'), { target: { value: item.title } });
    fireEvent.click(screen.getByRole('button', { name: /Add to queue/i }));

    await waitFor(() => expect(screen.getByText(item.title)).toBeTruthy());
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
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

    const archive = await screen.findByRole('button', { name: /archive/i });
    archive.focus();
    expect(document.activeElement).toBe(archive);

    fireEvent.click(archive, { detail: 1 });
    expect(document.activeElement).not.toBe(archive);
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeTruthy();
  });

  it('keeps every nav destination reachable from the compact rail', async () => {
    stubEmptyQueue();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><App /></QueryClientProvider>);

    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeTruthy();
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { void init; return new Response(JSON.stringify(
      String(input).includes('/dependency-candidates')
        ? { items: [] }
        : { item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], references: [], providerConflicts: [] },
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
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

    const codex = await screen.findByRole('button', { name: /codex/i });
    expect(codex.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /claude/i }).hasAttribute('disabled')).toBe(true);

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

    const execute = await screen.findByRole('button', { name: /^execute$/i });
    expect(execute.hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: /claude/i }).hasAttribute('disabled')).toBe(false);
  });

  it('uses the app dialog before permanently deleting a task', async () => {
    const fetchMock = renderDetail([]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('dialog', { name: `Delete “${baseItem.title}”?` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete task' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => String(input) === `/api/work-items/${taskId}` && init?.method === 'DELETE')).toBe(true));
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
    expect(await screen.findByRole('heading', { name: 'Workbench roadmap' })).toBeTruthy();
    expect(window.location.pathname).toBe('/workbench');

    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeTruthy();
    expect(window.location.pathname).toBe('/archive');

    await goBack();
    expect(window.location.pathname).toBe('/workbench');
    expect(await screen.findByRole('heading', { name: 'Workbench roadmap' })).toBeTruthy();
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
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeTruthy();
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
