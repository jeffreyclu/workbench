// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../../shared/contracts';
import { useNewTaskDraft } from '../../hooks/new-task-draft';
import { readNewTaskDraft, writeNewTaskDraft, type NewTaskDraft } from '../../lib/preferences';
import { CreateTask } from './create-task-dialog';

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

function CreateTaskHarness() {
  const [open, setOpen] = useState(true);
  return <>
    {!open && <button type="button" onClick={() => setOpen(true)}>Reopen task form</button>}
    {open && <CreateTask onClose={() => setOpen(false)} onCreated={vi.fn()} draftScope="attention" />}
  </>;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('CreateTask draft recovery', () => {
  it('survives a full remount with manual, pasted-link, and AI prompt input intact', () => {
    const first = renderHook(() => useNewTaskDraft('attention', '', null));
    const completedDraft: NewTaskDraft = {
      mode: 'ai',
      title: 'Half-written manual task',
      description: 'Manual details',
      projectName: 'Workbench',
      classificationKind: 'research',
      sourceUrl: 'https://example.com/source',
      aiPrompt: 'Turn these rough notes into a task',
    };

    act(() => first.result.current.updateDraft(completedDraft));
    first.unmount();

    const restored = renderHook(() => useNewTaskDraft('attention', '', null));
    expect(restored.result.current.draft).toEqual(completedDraft);
  });

  it('restores the saved form after an accidental close', async () => {
    const saved: NewTaskDraft = {
      mode: 'ai',
      title: 'Recovered title',
      description: 'Recovered description',
      projectName: 'Workbench',
      classificationKind: 'bugfix',
      sourceUrl: 'https://example.com/recovered',
      aiPrompt: 'Recovered AI prompt',
    };
    writeNewTaskDraft('attention', saved);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projects: [] }), { headers: { 'Content-Type': 'application/json' } })));
    render(<CreateTaskHarness />, { wrapper });

    expect(screen.getByRole('button', { name: /Describe to AI/i })).toHaveAttribute('aria-pressed', 'true');
    expect((await screen.findByRole('textbox', { name: 'Describe the task' })).textContent).toContain(saved.aiPrompt);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen task form' }));
    expect(screen.getByRole('button', { name: /Describe to AI/i })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /Paste link/i }));
    expect(screen.getByRole('textbox', { name: 'Source URL' })).toHaveValue(saved.sourceUrl);
    fireEvent.click(screen.getByRole('button', { name: /Manual task/i }));
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(saved.title);
    expect(screen.getByRole('combobox', { name: 'Project' })).toHaveValue(saved.projectName);
    expect(screen.getByRole('combobox', { name: 'Task type' })).toHaveValue(saved.classificationKind);
    expect((await screen.findByRole('textbox', { name: 'Task description' })).textContent).toContain(saved.description);
  });

  it('clears the submitted draft after successful task creation', async () => {
    const item = { id: '00000000-0000-4000-8000-000000000099', title: 'Created task' } as WorkItem;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/work-items' && init?.method === 'POST') {
        return new Response(JSON.stringify({ item }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ projects: [] }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const onCreated = vi.fn();
    render(<CreateTask onClose={vi.fn()} onCreated={onCreated} draftScope="attention" />, { wrapper });

    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: item.title } });
    expect(readNewTaskDraft('attention')?.title).toBe(item.title);
    fireEvent.click(screen.getByRole('button', { name: /Add to queue/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(item));
    expect(readNewTaskDraft('attention')).toBeNull();
  });
});
