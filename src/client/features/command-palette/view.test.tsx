// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette, CommandPaletteProvider, usePaletteCommands, type PaletteCommand } from './index';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubApi() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.includes('view=workbench') ? { items: [], nextCursor: null }
      : url.includes('/api/work-items') ? { items: [{ id: 'task-1', title: 'Fix mobile stack', projectName: 'Workbench' }], nextCursor: null }
      : { conversations: [{ id: 'conv-1', title: 'Palette design', linkedProjectName: null }], nextCursor: null },
  ), { headers: { 'Content-Type': 'application/json' } })));
}

function Contributor({ commands }: { commands: PaletteCommand[] }) {
  usePaletteCommands('test', commands);
  return null;
}

function renderPalette(commands: PaletteCommand[] = [], handlers = { onOpenTask: vi.fn(), onOpenConversation: vi.fn() }) {
  stubApi();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CommandPaletteProvider><Contributor commands={commands} /><CommandPalette {...handlers} /></CommandPaletteProvider></QueryClientProvider>);
  return handlers;
}

const file = (path: string, run = vi.fn()): PaletteCommand => ({ id: `file:${path}`, group: 'Files', label: path, run });
const action: PaletteCommand = { id: 'action:new', group: 'Actions', label: 'New task', run: vi.fn() };

describe('CommandPalette', () => {
  it('opens on Ctrl/Cmd+K as a labelled modal dialog and closes on Escape', () => {
    renderPalette([action]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('combobox', { name: 'Command palette' })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('toggles closed when its own shortcut is pressed again', () => {
    renderPalette();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('blocks the browser print dialog on Cmd+P and opens the quick switcher without actions', async () => {
    renderPalette([action, file('src/a.ts')]);
    // fireEvent returns false when a listener called preventDefault.
    expect(fireEvent.keyDown(window, { key: 'p', metaKey: true })).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Quick switcher' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /src/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /New task/ })).not.toBeInTheDocument();
  });

  it('filters with a fuzzy query, moves with the arrow keys and runs the choice on Enter', () => {
    const openB = vi.fn();
    const openA = vi.fn();
    renderPalette([file('src/file-diff-pane.tsx', openA), file('src/file-diff-pane.test.tsx', openB)]);
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'fdp' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('command-palette-option-1');
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(openB).toHaveBeenCalledOnce();
    expect(openA).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists tasks by title and conversations from the server and opens them', async () => {
    const handlers = renderPalette();
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });

    fireEvent.click(await screen.findByRole('option', { name: /Fix mobile stack/ }));
    expect(handlers.onOpenTask).toHaveBeenCalledWith('task-1');

    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    fireEvent.click(await screen.findByRole('option', { name: /Palette design/ }));
    expect(handlers.onOpenConversation).toHaveBeenCalledWith('conv-1');
  });

  it('says so when nothing matches', async () => {
    renderPalette([action]);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qqqq' } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No matches for “qqqq”.'));
  });

  it('drops a screen\'s commands when it unmounts', () => {
    stubApi();
    const client = new QueryClient();
    const tree = (commands: PaletteCommand[] | null) => (
      <QueryClientProvider client={client}><CommandPaletteProvider>{commands && <Contributor commands={commands} />}<CommandPalette onOpenTask={vi.fn()} onOpenConversation={vi.fn()} /></CommandPaletteProvider></QueryClientProvider>
    );
    const { rerender } = render(tree([action]));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('option', { name: /New task/ })).toBeInTheDocument();
    rerender(tree(null));
    expect(screen.queryByRole('option', { name: /New task/ })).not.toBeInTheDocument();
  });
});
