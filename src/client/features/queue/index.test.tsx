// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../../shared/contracts';
import { SortableQueueItem, TaskClassificationSelect } from './index';
import { projectTheme } from '../../components/project/project-color';

afterEach(() => vi.unstubAllGlobals());

const item: WorkItem = {
  id: '00000000-0000-4000-8000-000000000001', title: 'Conversation task', description: '', status: 'ready', priority: 2, queuePosition: 0,
  source: 'manual', isQueued: true, archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete', agentOutcome: null,
  classificationKind: 'execute', classificationComplex: false, sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null, stack: 'attention', workspacePath: null,
  strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null, blockedBy: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastTouchedAt: '2026-01-01T00:00:00Z',
};

describe('TaskClassificationSelect', () => {
  it('keeps Bug fix selected in a linked conversation while the server saves it', async () => {
    let resolveRequest: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveRequest = () => resolve(new Response(JSON.stringify({ classification: { kind: 'bugfix' } }), { headers: { 'Content-Type': 'application/json' } }));
    })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['work-item', item.id], { item });
    function LinkedConversationTaskType() {
      const detail = useQuery({ queryKey: ['work-item', item.id], queryFn: async () => ({ item }), staleTime: Infinity });
      return <TaskClassificationSelect itemId={item.id} kind={detail.data?.item.classificationKind} />;
    }
    render(<QueryClientProvider client={client}><LinkedConversationTaskType /></QueryClientProvider>);

    const select = screen.getByRole('combobox', { name: 'Task type' });
    fireEvent.change(select, { target: { value: 'bugfix' } });

    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('bugfix'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/work-items/${item.id}/classify`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'bugfix' }) })));
    resolveRequest?.();
    await waitFor(() => expect(client.getQueryData<{ item: WorkItem }>(['work-item', item.id])?.item.classificationKind).toBe('bugfix'));
  });

  it('keeps the disclosure variant collapsed to an icon toggle until opened', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ classification: { kind: 'bugfix' } }), { headers: { 'Content-Type': 'application/json' } }))));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><TaskClassificationSelect itemId={item.id} kind={item.classificationKind} disclosure /></QueryClientProvider>);
    const { findByRole, getByRole, queryByRole } = within(container);

    expect(queryByRole('combobox', { name: 'Task type' })).toBeNull();
    const toggle = getByRole('button', { name: 'Task type: Execute' });

    fireEvent.click(toggle);

    const select = await findByRole('combobox', { name: 'Task type' });
    fireEvent.change(select, { target: { value: 'bugfix' } });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/work-items/${item.id}/classify`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ kind: 'bugfix' }) })));
  });
});

describe('project card theme', () => {
  it('uses the project theme for a human-owned task card', () => {
    const projectName = 'Networking';
    const themedItem: WorkItem = { ...item, projectName, assignees: ['jeffrey'] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SortableQueueItem item={themedItem} index={0} selected={false} focused={false} draggable={false} onSelect={vi.fn()} onOpenTask={vi.fn()} onFocus={vi.fn()} onKeyDown={vi.fn()} /></QueryClientProvider>);

    const card = screen.getByRole('listitem');
    expect(card.className).toContain('stack-card');
    expect(card.className).toContain('project-colored');
    expect(card.getAttribute('style')).toContain(`--task-accent: ${projectTheme(projectName).accent}`);
  });
});

describe('task status badges', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderCard = (overrides: Partial<WorkItem>) => render(
    <QueryClientProvider client={client}>
      <SortableQueueItem item={{ ...item, ...overrides }} index={0} selected={false} focused={false} draggable={false} onSelect={vi.fn()} onOpenTask={vi.fn()} onFocus={vi.fn()} onKeyDown={vi.fn()} />
    </QueryClientProvider>,
  );

  it.each([
    [{ status: 'in_progress', agentOutcome: null }, 'In progress', 'agent-outcome-in_progress'],
    [{ agentOutcome: 'finished' }, 'Awaiting', 'agent-outcome-finished'],
    [{ agentOutcome: 'needs_attention' }, 'Needs attention', 'agent-outcome-needs_attention'],
    [{ agentOutcome: 'follow_ups' }, 'Follow-ups recommended', 'agent-outcome-follow_ups'],
    [{ agentOutcome: 'promoting' }, 'Approved · promoting preview', 'agent-outcome-promoting'],
    [{ agentOutcome: 'waiting_promotion' }, 'Approved and waiting promotion', 'agent-outcome-waiting_promotion'],
  ] as const)('renders %s as a task-card overlay', (overrides, label, className) => {
    const { container } = renderCard(overrides);

    const badge = screen.getByText(label);
    expect(badge.className).toContain(className);
    expect(badge.parentElement?.className).toContain('queue-item');
    expect(container.querySelector('.item-copy .agent-outcome')).toBeNull();
    expect(container.querySelectorAll('.queue-item > .agent-outcome')).toHaveLength(1);
  });

  it('keeps an archived task date without duplicating its completion status', () => {
    const { container } = renderCard({
      archivedAt: '2026-01-02T12:00:00Z',
      completionStatus: 'completed',
      agentOutcome: 'finished',
    });

    expect(container.querySelector('.agent-outcome-finished')?.textContent).toContain('Awaiting');
    expect(container.querySelector('.archive-date')?.getAttribute('dateTime')).toBe('2026-01-02T12:00:00Z');
    expect(container.textContent).not.toMatch(/Completed/);
    expect(container.querySelector('.archive-meta')).toBeNull();
  });

  it('removes the drag handle while a task is in progress', () => {
    render(
      <QueryClientProvider client={client}>
        <SortableQueueItem item={{ ...item, status: 'in_progress' }} index={0} selected={false} focused={false} draggable={false} onSelect={vi.fn()} onOpenTask={vi.fn()} onFocus={vi.fn()} onKeyDown={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole('button', { name: `Reorder ${item.title}` })).toBeNull();
  });
});

describe('prerequisite-blocked queue cards', () => {
  it('opens the task prerequisites instead of submitting a manual unblock', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const blockedItem: WorkItem = { ...item, blockedBy: [{ id: 'dependency-id', title: 'A prerequisite', status: 'blocked', archivedAt: null, completedAt: null, isOpen: true }] };
    const onSelect = vi.fn();

    render(<QueryClientProvider client={client}><SortableQueueItem item={blockedItem} index={0} selected={false} focused={false} draggable={false} onSelect={onSelect} onOpenTask={vi.fn()} onFocus={vi.fn()} onKeyDown={vi.fn()} /></QueryClientProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'View prerequisites for Conversation task' }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
