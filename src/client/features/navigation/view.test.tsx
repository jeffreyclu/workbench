// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalSearch, NavigationView } from './view';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderSearch(onSelectResult = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><GlobalSearch onSelectResult={onSelectResult} /></QueryClientProvider>);
  return onSelectResult;
}

function openSearch() {
  fireEvent.click(screen.getByRole('button', { name: 'Search everything' }));
  return screen.getByRole('combobox', { name: 'Search everything' });
}

describe('GlobalSearch', () => {
  it('holds the result-panel shape with skeleton rows while the search is pending', async () => {
    vi.useFakeTimers();
    let resolveResponse: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; })));
    renderSearch();

    fireEvent.change(openSearch(), { target: { value: 'handoff' } });
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

    fireEvent.change(openSearch(), { target: { value: 'mobile' } });
    expect(await screen.findByText('Fix mobile stack')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Fix mobile stack/i }));

    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'task-1' }));
    expect(screen.queryByRole('dialog', { name: 'Search everything' })).not.toBeInTheDocument();
  });

  it('labels results without a destination as preview-only and keeps them inert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{ source: 'activity', sourceId: '1', title: 'Background context', snippet: 'No destination.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: null, workItemId: null, actor: null, score: 1 }],
    }), { headers: { 'Content-Type': 'application/json' } })));
    const onSelectResult = renderSearch();

    fireEvent.change(openSearch(), { target: { value: 'context' } });

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
    const input = openSearch();

    fireEvent.change(input, { target: { value: 'open' } });
    await screen.findByRole('option', { name: /Open task/i });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Open task/i })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Open conversation/i })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectResult).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'task-1' }));
    expect(screen.queryByRole('dialog', { name: 'Search everything' })).not.toBeInTheDocument();
  });

  it('clears and closes its result panel on Escape', async () => {
    renderSearch();
    const input = openSearch();
    fireEvent.change(input, { target: { value: 'mobile' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Search everything' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No matches for/)).not.toBeInTheDocument();
  });

  it('traps Tab focus inside the modal and restores its trigger on close', () => {
    renderSearch();
    const trigger = screen.getByRole('button', { name: 'Search everything' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Search everything' });
    const input = screen.getByRole('combobox', { name: 'Search everything' });
    const close = screen.getByRole('button', { name: 'Close search' });
    expect(input).toHaveFocus();

    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Search everything' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('shows that the cap was reached and fetches more ranked results on demand', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const limit = String(input).includes('limit=40') ? 40 : 20;
      return new Response(JSON.stringify({
        results: Array.from({ length: limit }, (_, index) => ({ source: 'activity', sourceId: String(index), title: `Result ${index + 1}`, snippet: 'Matching memory.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: null, workItemId: `task-${index}`, actor: null, score: 1 })),
        hasMore: limit === 20,
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderSearch();
    const input = openSearch();

    fireEvent.change(input, { target: { value: 'memory' } });
    expect(await screen.findByText('Showing 20 results.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show 20 more' }));

    expect(await screen.findByText('Showing 40 results.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('limit=40'), expect.anything());
  });
});

describe('NavigationView', () => {
  function renderNav() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><NavigationView
      view="active"
      mobileNavOpen={false}
      isCompactNav={false}
      counts={{ active: 1, workbench: 2 }}
      conversationCount={3}
      onOpenActive={vi.fn()}
      onOpenWorkbench={vi.fn()}
      onOpenDiscovery={vi.fn()}
      onOpenConversations={vi.fn()}
      onOpenArtifacts={vi.fn()}
      onOpenInsights={vi.fn()}
      onOpenSources={vi.fn()}
      onToggleMore={vi.fn()}
      onSelectGlobalSearchResult={vi.fn()}
    /></QueryClientProvider>);
  }

  it('mounts a single global-search overlay and close button despite two trigger placements', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{ source: 'activity', sourceId: '1', title: 'Fix mobile stack', snippet: 'Preserve the drawer.', createdAt: '2026-08-24T00:00:00.000Z', conversationId: null, workItemId: 'task-1', actor: null, score: 1 }],
    }), { headers: { 'Content-Type': 'application/json' } })));
    renderNav();

    expect(screen.getAllByRole('button', { name: 'Search everything' })).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'k', metaKey: true });

    expect(screen.getAllByRole('dialog', { name: 'Search everything' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Close search' })).toHaveLength(1);
    expect(document.querySelectorAll('.global-search-overlay')).toHaveLength(1);

    const input = screen.getByRole('combobox', { name: 'Search everything' });
    fireEvent.change(input, { target: { value: 'mobile' } });
    const resultButton = await screen.findByText('Fix mobile stack');

    fireEvent.keyDown(resultButton, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Search everything' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.global-search-overlay')).toHaveLength(0);
  });
});
