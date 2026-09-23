import '@testing-library/jest-dom/vitest';
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '../../components/toast/toast';
import { toast } from '../../state/toast-store';
import { TaskDetail } from './view';

afterEach(() => { cleanup(); toast.clear(); window.localStorage.clear(); vi.unstubAllGlobals(); });

const baseItem = {
  description: '', priority: 2, queuePosition: 0, source: 'manual', isQueued: true, archivedAt: null, completedAt: null,
  parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null, sourceIdentifier: null, sourceUrl: null,
  sourceTags: [], projectName: 'Workbench', workspacePath: null, strategy: '', assignees: [], labels: [], dueDate: null,
  providerUpdatedAt: null, blockedBy: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
};

describe('WCAG AA: focus after asynchronous task actions', () => {
  it('moves focus to the task heading once a task detail finishes loading', async () => {
    const taskId = '00000000-0000-4000-8000-000000000051';
    const item = { ...baseItem, id: taskId, title: 'Newly opened task', status: 'ready' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input) === '/api/agent-accounts'
        ? { accounts: [{ name: 'default', providers: {} }] }
        : { item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] },
    ), { headers: { 'Content-Type': 'application/json' } })));
    render(<QueryClientProvider client={client}><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: item.title });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('announces and refocuses the task heading after retrying a failed run', async () => {
    const taskId = '00000000-0000-4000-8000-000000000052';
    const runId = '00000000-0000-4000-8000-000000000053';
    const conversationId = '00000000-0000-4000-8000-000000000054';
    const item = { ...baseItem, id: taskId, title: 'Retryable task', status: 'in_progress' };
    const failedRun = {
      id: runId, workItemId: taskId, kind: 'execute', requestedTarget: 'codex', requestedAgent: 'codex', agent: 'codex', status: 'failed',
      instructions: '', output: '', error: 'boom', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', createdAt: '2026-01-01T00:00:00Z',
      conversationId: null, messageId: null, model: null, accountProfile: 'default', executionProfile: null, inputTokens: null, outputTokens: null,
      fallbackFrom: null, fallbackReason: null, attempt: 0, maxAttempts: 3, nextAttemptAt: null, resolvedWorkspace: null, origin: 'manual',
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/agent-runs/${runId}/retry`) return new Response(JSON.stringify({
        run: { ...failedRun, status: 'queued' },
        conversation: { id: conversationId, title: '', messages: [] },
        activity: { id: 'activity-retry', workItemId: taskId, kind: 'execution', body: '', createdAt: '2026-01-01T00:02:00Z' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/agent-accounts') return new Response(JSON.stringify({ accounts: [{ name: 'default', providers: {} }] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [failedRun], executionPlan: null, classification: null, conversations: [], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    render(<QueryClientProvider client={client}><Toaster /><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: item.title });
    fireEvent.click(await screen.findByRole('button', { name: /Retry \/ continue/ }));

    expect(await screen.findByText('Run retry started.')).toBeTruthy();
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('announces and refocuses the task heading after resolving a Linear sync conflict', async () => {
    const taskId = '00000000-0000-4000-8000-000000000055';
    const item = { ...baseItem, id: taskId, title: 'Conflicted task', status: 'ready' };
    const conflict = { field: 'title', localValue: 'Local title', providerValue: 'Linear title' };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/work-items/${taskId}/provider-conflicts/title/resolve`) return new Response(JSON.stringify({ item, providerConflicts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/agent-accounts') return new Response(JSON.stringify({ accounts: [{ name: 'default', providers: {} }] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan: null, classification: null, conversations: [], artifacts: [], linkedTasks: [], references: [], providerConflicts: [conflict] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    render(<QueryClientProvider client={client}><Toaster /><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: item.title });
    fireEvent.click(await screen.findByRole('button', { name: 'Keep local' }));

    expect(await screen.findByText('title conflict resolved.')).toBeTruthy();
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('announces and refocuses the task heading after resolving an execution plan', async () => {
    const taskId = '00000000-0000-4000-8000-000000000056';
    const planId = '00000000-0000-4000-8000-000000000057';
    const item = { ...baseItem, id: taskId, title: 'Planned task', status: 'ready' };
    const executionPlan = { id: planId, summary: 'Break this into steps', tasks: [{ title: 'Step one', description: 'Do the first thing' }] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === `/api/execution-plans/${planId}/rejected`) return new Response(JSON.stringify({ plan: { ...executionPlan, status: 'rejected' }, items: [], parentArchived: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/agent-accounts') return new Response(JSON.stringify({ accounts: [{ name: 'default', providers: {} }] }), { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ item, parentItem: null, children: [], activity: [], runs: [], executionPlan, classification: null, conversations: [], artifacts: [], linkedTasks: [], references: [], providerConflicts: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    render(<QueryClientProvider client={client}><Toaster /><TaskDetail id={taskId} onClose={vi.fn()} onOpenConversation={vi.fn()} onOpenTask={vi.fn()} onCreated={vi.fn()} /></QueryClientProvider>);

    const heading = await screen.findByRole('heading', { name: item.title });
    fireEvent.click(await screen.findByRole('button', { name: 'Reject plan' }));

    expect(await screen.findByText('Plan rejected.')).toBeTruthy();
    await waitFor(() => expect(heading).toHaveFocus());
  });
});
