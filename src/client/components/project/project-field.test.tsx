// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../../shared/contracts';
import { InlineProjectEditor, ProjectField } from './project-field';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const projects: ProjectSummary[] = [
  { id: 'p1', name: 'Workbench', key: 'workbench', taskCount: 113, lastUsedAt: '2026-08-23T00:00:00.000Z' },
  { id: 'p2', name: 'Connectors', key: 'connectors', taskCount: 128, lastUsedAt: '2026-08-23T00:00:00.000Z' },
];

function mountWithVocabulary(children: React.ReactNode) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projects }), { headers: { 'Content-Type': 'application/json' } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe('ProjectField', () => {
  it('sets a project in one tap instead of typing it', async () => {
    const onChange = vi.fn();
    mountWithVocabulary(<ProjectField value="" onChange={onChange} />);

    fireEvent.click(await screen.findByRole('button', { name: /Workbench/ }));
    expect(onChange).toHaveBeenCalledWith('Workbench');
  });

  it('offers every known project for autocomplete so the rest are still one choice', async () => {
    const { container } = mountWithVocabulary(<ProjectField value="" onChange={vi.fn()} />);

    await waitFor(() => expect(container.querySelectorAll('datalist option')).toHaveLength(2));
    expect([...container.querySelectorAll('datalist option')].map((option) => option.getAttribute('value')))
      .toEqual(['Workbench', 'Connectors']);
    expect(screen.getByLabelText('Project').getAttribute('list')).toBe(container.querySelector('datalist')!.id);
  });

  it('says which project a mistyped name will join before it is saved', async () => {
    mountWithVocabulary(<ProjectField value="wkbnch" onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/Joins/).textContent).toBe('Joins Workbench.'));
  });

  it('warns that an unrelated name starts a new project', async () => {
    mountWithVocabulary(<ProjectField value="Quarterly planning" onChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Creates a new project.')).toBeTruthy());
  });

  it('marks the chosen project as pressed and clears it when tapped again', async () => {
    const onChange = vi.fn();
    mountWithVocabulary(<ProjectField value="Workbench" onChange={onChange} />);

    const chip = await screen.findByRole('button', { name: /Workbench/ });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith('');
  });
});

describe('InlineProjectEditor', () => {
  it('commits a tapped project without the pending blur discarding it', async () => {
    const onCommit = vi.fn();
    mountWithVocabulary(<InlineProjectEditor initialValue="" onCommit={onCommit} onCancel={vi.fn()} />);

    const chip = await screen.findByRole('button', { name: /Connectors/ });
    // The real sequence: mousedown (which the field must not let steal focus)
    // and only then the click that commits.
    fireEvent.mouseDown(chip);
    fireEvent.click(chip);

    expect(onCommit).toHaveBeenCalledWith('Connectors');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits on Enter and abandons the edit on Escape', async () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    mountWithVocabulary(<InlineProjectEditor initialValue="Workbench" onCommit={onCommit} onCancel={onCancel} />);

    const input = screen.getByLabelText('Project');
    fireEvent.change(input, { target: { value: 'Connectors' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('Connectors');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('clears the project when the field is emptied', () => {
    const onCommit = vi.fn();
    mountWithVocabulary(<InlineProjectEditor initialValue="Workbench" onCommit={onCommit} onCancel={vi.fn()} />);

    const input = screen.getByLabelText('Project');
    fireEvent.change(input, { target: { value: '  ' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(null);
  });
});
