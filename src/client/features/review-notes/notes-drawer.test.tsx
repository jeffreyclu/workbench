// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewNotesDrawer } from './notes-drawer.js';
import type { ResolvedReviewNote, ReviewNote } from './notes-logic.js';
import { summarizeReviewNotes } from './notes-logic.js';

afterEach(cleanup);

const anchor = (filePath: string, startIndex: number) => ({ filePath, hunkRange: '@@ -1 +1 @@', startIndex, endIndex: startIndex, excerpt: '+x' });
const note = (id: string, filePath: string, resolved = false): ReviewNote => ({ id, anchor: anchor(filePath, 1), body: `Body ${id}`, resolved, createdAt: '2026-10-09T00:00:00.000Z' });
const live = (n: ReviewNote, lineNumber: number): ResolvedReviewNote => ({ note: n, target: { hunkId: 'h', lineKey: 'k', lineNumber, kind: 'addition' } });

function renderDrawer(overrides: Partial<Parameters<typeof ReviewNotesDrawer>[0]> = {}) {
  const entries = [live(note('n1', 'src/a.ts'), 12), { note: note('n2', 'src/a.ts', true), target: null } as ResolvedReviewNote];
  const props = {
    groups: [{ filePath: 'src/a.ts', notes: entries }], summary: summarizeReviewNotes(entries), pending: null, saveFailed: false,
    onSave: vi.fn(), onCancelPending: vi.fn(), onJump: vi.fn(), onNextUnresolved: vi.fn(), onToggleResolved: vi.fn(), onRemove: vi.fn(), onClose: vi.fn(),
    ...overrides,
  };
  render(<ReviewNotesDrawer {...props} />);
  return props;
}

describe('ReviewNotesDrawer', () => {
  it('lists notes under their file with line labels, a summary, and states that nothing is published', () => {
    renderDrawer();
    const section = screen.getByRole('region', { name: 'Notes in src/a.ts' });
    expect(within(section).getByText('Body n1')).toBeInTheDocument();
    expect(within(section).getByText('Outdated')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 open · 1 resolved · 2 in 1 file · 1 outdated');
    expect(screen.getByText(/Not published to GitHub/)).toBeInTheDocument();
  });

  it('jumps to a live note, but offers no jump for an outdated one', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Jump to src/a.ts line 12' }));
    expect(props.onJump).toHaveBeenCalledWith(expect.objectContaining({ note: expect.objectContaining({ id: 'n1' }) }));
    expect(screen.getAllByRole('button', { name: /^Jump to/ })).toHaveLength(1);
  });

  it('resolves, deletes and walks to the next open note', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: /Resolve/ }));
    expect(props.onToggleResolved).toHaveBeenCalledWith('n1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete note on src/a.ts line 12' }));
    expect(props.onRemove).toHaveBeenCalledWith('n1');
    fireEvent.click(screen.getByRole('button', { name: /Next open note/ }));
    expect(props.onNextUnresolved).toHaveBeenCalled();
  });

  it('saves a draft for the pending lines, trimming nothing it should keep and blocking empty text', () => {
    const props = renderDrawer({ pending: { anchor: anchor('src/a.ts', 2), label: 'src/a.ts · line 13' } });
    const save = screen.getByRole('button', { name: 'Save draft note' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Note on src\/a.ts · line 13/), { target: { value: 'Check the null case' } });
    fireEvent.click(save);
    expect(props.onSave).toHaveBeenCalledWith('Check the null case');
  });

  it('warns when the browser refused to store notes, and closes on Escape', () => {
    const props = renderDrawer({ saveFailed: true });
    expect(screen.getByRole('alert')).toHaveTextContent(/lost on reload/);
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Review notes' }), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('shows an empty state with the highlight instruction', () => {
    renderDrawer({ groups: [], summary: summarizeReviewNotes([]) });
    expect(screen.getByRole('status')).toHaveTextContent('No notes yet.');
    expect(screen.getByText(/Highlight lines in the diff/)).toBeInTheDocument();
  });
});
