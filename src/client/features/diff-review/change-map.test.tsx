// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeMap, ChangeMapNode } from '../../../shared/change-map.js';
import { DiffReviewChangeMap, DiffReviewChangePath } from './change-map.js';

afterEach(cleanup);

function node(id: string, ordinal: number, label: string, degree: number): ChangeMapNode {
  return {
    id, ordinal, label, degree, subject: label, filePath: `src/${id}.ts`, fileCount: 1,
    behavior: `Changes ${label}.`, additions: 1, deletions: 1, state: null, riskSignals: [],
  };
}

const map: ChangeMap = {
  nodes: [node('type', 1, 'WorkspaceRef', 1), node('consumer', 2, 'renderWorkspace', 1), node('isolated', 3, 'formatDate', 0)],
  edges: [{
    id: 'type->consumer', fromId: 'type', toId: 'consumer', relation: 'references-type', symbols: ['WorkspaceRef'],
    explanation: 'Decision 2 references the changed type WorkspaceRef from decision 1.',
  }],
  omittedEdges: 0,
};

describe('diff review change navigation', () => {
  it('keeps the full overview collapsed until requested', () => {
    render(<DiffReviewChangeMap map={map} selectedId="type" onSelect={() => {}} />);

    const toggle = screen.getByRole('button', { name: /Change map/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Change map diagram' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Change map diagram' })).toBeInTheDocument();
  });

  it('shows the selected change path and jumps through a direct relationship', () => {
    const onSelect = vi.fn();
    render(<DiffReviewChangePath map={map} selectedId="type" onSelect={onSelect} />);

    const path = screen.getByRole('navigation', { name: 'Related code changes' });
    expect(path).toHaveTextContent('Change 1');
    expect(path).toHaveTextContent('Downstream · References type');
    expect(path).toHaveTextContent('2. renderWorkspace');

    fireEvent.click(screen.getByRole('button', { name: /Jump to decision 2/ }));
    expect(onSelect).toHaveBeenCalledWith('consumer');
  });

  it('keeps an unrelated selected hunk explicit instead of hiding the path', () => {
    render(<DiffReviewChangePath map={map} selectedId="isolated" onSelect={() => {}} />);

    expect(screen.getByRole('navigation', { name: 'Related code changes' })).toHaveTextContent('Change 3');
    expect(screen.getByText('No direct relationships in this diff')).toBeInTheDocument();
  });
});
