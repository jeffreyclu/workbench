// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../shared/contracts';
import { CreateTask } from './create-task-dialog';
import { SourcesDialog } from './sources-dialog';

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const created = vi.fn<(item: WorkItem) => void>();

function CreateTaskHarness() {
  const [open, setOpen] = useState(false);
  return <QueryClientProvider client={queryClient()}><button type="button" onClick={() => setOpen(true)}>Open create task</button>{open && <CreateTask onClose={() => setOpen(false)} onCreated={created} />}</QueryClientProvider>;
}

function SourcesHarness() {
  const [open, setOpen] = useState(false);
  return <QueryClientProvider client={queryClient()}><button type="button" onClick={() => setOpen(true)}>Open sources</button>{open && <SourcesDialog onClose={() => setOpen(false)} />}</QueryClientProvider>;
}

afterEach(() => vi.unstubAllGlobals());

describe('modal dialogs', () => {
  it('gives Create Task modal semantics, traps focus, and restores the trigger after Escape', () => {
    render(<CreateTaskHarness />);
    const trigger = screen.getByRole('button', { name: 'Open create task' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Choose your next task' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('gives Sources modal semantics, keeps focus inside, and restores the trigger after Escape', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ connections: [] }), { headers: { 'Content-Type': 'application/json' } })));
    render(<SourcesHarness />);
    const trigger = screen.getByRole('button', { name: 'Open sources' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Connections' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
