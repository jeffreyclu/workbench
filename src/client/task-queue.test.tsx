// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../shared/contracts';
import { SortableQueueItem, TaskClassificationSelect } from './task-queue';
import { projectTheme } from './project-color';

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
});

describe('project card theme', () => {
  it('uses the project theme for a human-owned task card', () => {
    const projectName = 'Networking';
    const themedItem: WorkItem = { ...item, projectName, assignees: ['jeffrey'] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SortableQueueItem item={themedItem} index={0} selected={false} focused={false} draggable={false} onSelect={vi.fn()} onOpenTask={vi.fn()} onFocus={vi.fn()} onKeyDown={vi.fn()} /></QueryClientProvider>);

    const card = screen.getByRole('listitem');
    expect(card.className).toContain('project-colored');
    expect(card.getAttribute('style')).toContain(`--task-accent: ${projectTheme(projectName).accent}`);
  });
});
