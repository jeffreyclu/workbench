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
    expect(screen.getByRole('region', { name: '1 downstream change' })).toHaveTextContent('References type');
    expect(path).toHaveTextContent('2. renderWorkspace');

    fireEvent.click(screen.getByRole('button', { name: /Jump to decision 2/ }));
    expect(onSelect).toHaveBeenCalledWith('consumer');
  });

  it('keeps an unrelated selected hunk explicit instead of hiding the path', () => {
    render(<DiffReviewChangePath map={map} selectedId="isolated" onSelect={() => {}} />);

    expect(screen.getByRole('navigation', { name: 'Related code changes' })).toHaveTextContent('Change 3');
    expect(screen.getByText('No direct relationships in this diff')).toBeInTheDocument();
  });

  it('bounds a dense path by direction and reveals every relationship on request', () => {
    const denseNodes = [node('root', 1, 'root', 12), ...Array.from({ length: 12 }, (_, index) => node(`change-${index + 2}`, index + 2, `change-${index + 2}`, 1))];
    const denseMap: ChangeMap = {
      nodes: denseNodes,
      edges: denseNodes.slice(1).map((item, index) => ({
        id: `${item.id}->root`,
        fromId: index < 6 ? item.id : 'root',
        toId: index < 6 ? 'root' : item.id,
        relation: 'calls',
        symbols: [],
        explanation: `${item.id} is directly related to root.`,
      })),
      omittedEdges: 0,
    };

    render(<DiffReviewChangePath map={denseMap} selectedId="root" onSelect={() => {}} />);

    expect(screen.getByRole('region', { name: '6 upstream changes' }).querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByRole('region', { name: '6 downstream changes' }).querySelectorAll('li')).toHaveLength(3);
    const showAll = screen.getByRole('button', { name: 'Show all 12' });
    expect(showAll).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(showAll);
    expect(screen.getByRole('region', { name: '6 upstream changes' }).querySelectorAll('li')).toHaveLength(6);
    expect(screen.getByRole('region', { name: '6 downstream changes' }).querySelectorAll('li')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens a large overview on the selected neighborhood with an explicit full-map control', () => {
    const extraNodes = Array.from({ length: 8 }, (_, index) => node(`extra-${index}`, index + 4, `extra-${index}`, 1));
    const largeMap: ChangeMap = {
      nodes: [...map.nodes, ...extraNodes],
      edges: [...map.edges, ...extraNodes.map((item) => ({
        id: `type->${item.id}`, fromId: 'type', toId: item.id, relation: 'uses' as const, symbols: [], explanation: `type relates to ${item.id}`,
      }))],
      omittedEdges: 0,
    };
    render(<DiffReviewChangeMap map={largeMap} selectedId="type" onSelect={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Change map/ }));
    expect(screen.getByText('Focused on change 1 · 4 direct relationships')).toBeInTheDocument();
    const showAll = screen.getByRole('button', { name: `Show all ${largeMap.nodes.length} changes` });
    fireEvent.click(showAll);
    expect(screen.getByText(`All ${largeMap.nodes.length} changes`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Focus on current change' })).toBeInTheDocument();
  });
});
