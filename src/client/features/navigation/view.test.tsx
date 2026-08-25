// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch } from './view';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderSearch(onSelectResult = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><GlobalSearch onSelectResult={onSelectResult} /></QueryClientProvider>);
  return onSelectResult;
}

describe('GlobalSearch', () => {
  it('holds the result-panel shape with skeleton rows while the search is pending', async () => {
    vi.useFakeTimers();
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })));
    renderSearch();

    fireEvent.change(screen.getByRole('combobox', { name: 'Search everything' }), { target: { value: 'handoff' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    expect(document.querySelector('.global-search-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument();

    resolveResponse?.(new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } }));
  });

  it('renders a result and forwards an opened task hit to its owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{ source: 'activity', sourceId: '1', title: 'Fix mobile stack', snippet: 'Preserve the drawer.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: null, workItemId: 'task-1', actor: null, score: 1 }],
    }), { headers: { 'Content-Type': 'application/json' } })));
    const onSelectResult = renderSearch();

    fireEvent.change(screen.getByRole('combobox', { name: 'Search everything' }), { target: { value: 'mobile' } });
    expect(await screen.findByText('Fix mobile stack')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Fix mobile stack/i }));

    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'task-1' }));
    expect(screen.getByRole('combobox', { name: 'Search everything' })).toHaveValue('');
  });

  it('labels results without a destination as preview-only and keeps them inert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{ source: 'activity', sourceId: '1', title: 'Background context', snippet: 'No destination.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: null, workItemId: null, actor: null, score: 1 }],
    }), { headers: { 'Content-Type': 'application/json' } })));
    const onSelectResult = renderSearch();

    fireEvent.change(screen.getByRole('combobox', { name: 'Search everything' }), { target: { value: 'context' } });

    expect(await screen.findByText('Preview only')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Background context/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Background context'));
    expect(onSelectResult).not.toHaveBeenCalled();
  });

  it('navigates selectable results with Arrow keys and opens the active result with Enter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [
        { source: 'activity', sourceId: '1', title: 'Preview only', snippet: 'No destination.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: null, workItemId: null, actor: null, score: 1 },
        { source: 'activity', sourceId: '2', title: 'Open task', snippet: 'Task destination.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: null, workItemId: 'task-1', actor: null, score: 1 },
        { source: 'conversation', sourceId: '3', title: 'Open conversation', snippet: 'Conversation destination.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: 'conversation-1', workItemId: null, actor: null, score: 1 },
      ],
    }), { headers: { 'Content-Type': 'application/json' } })));
    const onSelectResult = renderSearch();
    const input = screen.getByRole('combobox', { name: 'Search everything' });

    fireEvent.change(input, { target: { value: 'open' } });
    await screen.findByRole('option', { name: /Open task/i });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Open task/i })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Open conversation/i })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'task-1' }));
    expect(input).toHaveValue('');
  });

  it('clears and closes its result panel on Escape', async () => {
    renderSearch();
    const input = screen.getByRole('combobox', { name: 'Search everything' });
    fireEvent.change(input, { target: { value: 'mobile' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input).toHaveValue('');
    expect(screen.queryByText(/No matches for/)).not.toBeInTheDocument();
  });
});
