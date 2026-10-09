// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import type { ReviewDecision } from '../diff-review/logic.js';
import { buildFileNavigatorRows, describeFileRow, openNoteCounts } from './file-navigator-logic.js';
import { DiffFileNavigator } from './file-navigator.js';
import { WorkspaceDiffView } from './view.js';

const file = (path: string, over: Partial<WorkspaceDiffFile> = {}): WorkspaceDiffFile => ({ path, status: 'modified', additions: 3, deletions: 1, previousPath: null, patch: null, isBinary: false, ...over });
const decision = (id: string, filePaths: string[], state: ReviewDecision['state'] = null) => ({ id, filePaths, state }) as ReviewDecision;

function rows(over: Partial<Parameters<typeof buildFileNavigatorRows>[0]> = {}) {
  return buildFileNavigatorRows({
    files: [file('a.ts'), file('b.ts', { status: 'added' }), file('c.ts'), file('d.ts', { status: 'renamed', previousPath: 'old.ts' })],
    decisions: [decision('d1', ['a.ts'], 'reviewed'), decision('d2', ['a.ts']), decision('d3', ['b.ts'], 'needs_changes'), decision('d4', ['c.ts'], 'reviewed')],
    openNotesByFile: new Map([['b.ts', 2]]),
    whitespaceOnly: new Set(['c.ts']),
    riskBands: new Map([['d1', 'low'], ['d2', 'high']]),
    ...over,
  });
}

describe('buildFileNavigatorRows', () => {
  it('reports each file’s worst decision state, progress, notes, whitespace marker and top risk', () => {
    const [a, b, c, d] = rows();
    expect(a).toMatchObject({ decisionState: 'pending', decisionsSettled: 1, decisionsTotal: 2, risk: 'high', decisionId: 'd2', additions: 3, deletions: 1 });
    expect(b).toMatchObject({ decisionState: 'needs_changes', openNotes: 2, status: 'added' });
    expect(c).toMatchObject({ decisionState: 'reviewed', whitespaceOnly: true, risk: null });
    expect(d).toMatchObject({ decisionState: 'none', decisionId: null, label: 'old.ts → d.ts' });
  });

  it('counts proof-settled decisions as reviewed', () => {
    const [a] = rows({ decisions: [decision('d1', ['a.ts'])], automatic: new Set(['d1']) });
    expect(a).toMatchObject({ decisionState: 'reviewed', decisionsSettled: 1 });
  });

  it('counts only unresolved notes', () => {
    const counts = openNoteCounts([{ filePath: 'a.ts', notes: [{ note: { resolved: false }, target: {} }, { note: { resolved: true }, target: {} }] }]);
    expect(counts.get('a.ts')).toBe(1);
  });

  it('describes a row for assistive tech', () => {
    expect(describeFileRow(rows()[2]!)).toBe('c.ts, modified, 3 added, 1 removed, Reviewed, 1 of 1 decisions answered, whitespace only');
  });
});

describe('DiffFileNavigator', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('lists files, jumps on click and marks the open file', () => {
    const onSelect = vi.fn();
    render(<DiffFileNavigator rows={rows()} selectedPath="a.ts" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: /^Files/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /^a\.ts,/ })).toHaveAttribute('aria-current', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^b\.ts,/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ path: 'b.ts', decisionId: 'd3' }));
    expect(screen.getByText('whitespace only')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /^b\.ts,/ })).getByText('2')).toBeInTheDocument();
  });

  it('does not open a file that has no decision', () => {
    const onSelect = vi.fn();
    render(<DiffFileNavigator rows={rows()} selectedPath="a.ts" onSelect={onSelect} />);
    const row = screen.getByRole('button', { name: /^old\.ts → d\.ts,/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps one tab stop and moves with arrow keys, Home and End', () => {
    render(<DiffFileNavigator rows={rows()} selectedPath="b.ts" onSelect={vi.fn()} />);
    const buttons = screen.getAllByRole('button', { name: /,/ }).filter((button) => button.classList.contains('file-navigator-row'));
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1, -1]);
    buttons[1]!.focus();
    fireEvent.keyDown(buttons[1]!, { key: 'ArrowDown' });
    expect(buttons[2]).toHaveFocus();
    fireEvent.keyDown(buttons[2]!, { key: 'End' });
    expect(buttons[3]).toHaveFocus();
    fireEvent.keyDown(buttons[3]!, { key: 'ArrowDown' });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowUp' });
    expect(buttons[3]).toHaveFocus();
    fireEvent.keyDown(buttons[3]!, { key: 'Home' });
    expect(buttons[0]).toHaveFocus();
  });

  it('collapses from the toggle and with Escape, returning focus to the toggle', () => {
    render(<DiffFileNavigator rows={rows()} selectedPath="a.ts" onSelect={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /^Files/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getAllByRole('listitem')[0]!.firstElementChild!, { key: 'Escape' });
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });

  it('starts closed as a bottom sheet on a phone and closes after a file is chosen', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('720px'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const onSelect = vi.fn();
    render(<DiffFileNavigator rows={rows()} selectedPath="a.ts" onSelect={onSelect} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Files/ }));
    fireEvent.click(screen.getByRole('button', { name: /^b\.ts,/ }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('WorkspaceDiffView file navigator', () => {
  afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

  it('opens the chosen file’s diff from the list', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const files = [
      file('src/alpha.ts', { patch: '@@ -1,3 +1,3 @@ alphaBehavior\n context-one\n-before\n+after' }),
      file('src/beta.ts', { patch: '@@ -5,2 +5,2 @@ betaBehavior\n context-two\n-old\n+new' }),
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/workspaces')) return json({ selectedPath: null, workspaces: [] });
      if (url.endsWith('/workspace-diff/snapshots')) return json({ snapshots: [] });
      if (url.endsWith('/workspace-diff')) return json({ diff: { workspacePath: '/tmp/w', branch: 'review', revision: 'nav-revision', changedFiles: 2, additions: 2, deletions: 2, publish: { branch: 'review', hasOrigin: true, ahead: 0, hasChanges: true, reason: null }, files } });
      if (url.includes('/workspace-diff/hunk-reviews?')) return json({ reviews: [] });
      throw new Error(`Unexpected request: ${url}`);
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={client}><WorkspaceDiffView scope={{ workItemId: 'work-item-1' }} isRunning={false} /></QueryClientProvider>);
    await screen.findByLabelText('Full diff for src/alpha.ts');
    fireEvent.click(await screen.findByRole('button', { name: /^src\/beta\.ts,/ }));
    await screen.findByLabelText('Full diff for src/beta.ts');
    await waitFor(() => expect(screen.getByRole('button', { name: /^src\/beta\.ts,/ })).toHaveAttribute('aria-current', 'true'));
    expect(screen.queryByLabelText('Full diff for src/alpha.ts')).not.toBeInTheDocument();
  });
});
