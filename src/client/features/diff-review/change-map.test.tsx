// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeMap, ChangeMapNode } from '../../../shared/change-map.js';
import { DiffReviewChangeMap } from './change-map.js';

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

    const toggle = screen.getByRole('button', { name: /Full change diagram/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Change map diagram' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Change map diagram' })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));
    expect(screen.getByText('Focused on change 1 · 4 direct relationships')).toBeInTheDocument();
    const showAll = screen.getByRole('button', { name: `Show all ${largeMap.nodes.length} changes` });
    fireEvent.click(showAll);
    expect(screen.getByText(`All ${largeMap.nodes.length} changes`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Focus on current change' })).toBeInTheDocument();
  });
  it('makes a node open the decision detail and carry its AI risk band', () => {
    // The diagram is a review surface, not an index: reaching a change through
    // it has to reach the same scored panel the gutter marker opens.
    const opened: Array<{ decisionId: string; tag: string }> = [];
    render(<DiffReviewChangeMap
      map={map}
      selectedId="type"
      riskBands={new Map([['consumer', 'high']])}
      openDetailFor={null}
      onSelect={() => {}}
      onOpenDetail={(decisionId, anchor) => opened.push({ decisionId, tag: anchor.tagName })}
    />);

    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));
    const scored = screen.getByRole('button', { name: /Decision 2:.*high risk\. Open decision details\./ });
    expect(scored).toHaveAttribute('aria-haspopup', 'dialog');
    expect(scored).toHaveAttribute('aria-expanded', 'false');
    expect(scored.querySelector('.change-map-node-risk-dot.band-high')).not.toBeNull();

    fireEvent.click(scored);
    expect(opened).toEqual([{ decisionId: 'consumer', tag: 'g' }]);

    // Keyboard reaches the same panel; a node that only responds to a mouse is
    // still a dead handle for a keyboard reviewer.
    fireEvent.keyDown(scored, { key: 'Enter' });
    expect(opened).toHaveLength(2);
  });
  it('leaves the popover affordance off when no detail handler is wired', () => {
    render(<DiffReviewChangeMap map={map} selectedId="type" onSelect={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));
    expect(screen.getByRole('button', { name: /Decision 2:/ })).not.toHaveAttribute('aria-haspopup');
  });
});
