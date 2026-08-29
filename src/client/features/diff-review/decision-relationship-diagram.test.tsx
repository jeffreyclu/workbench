// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeMap, ChangeMapNode } from '../../../shared/change-map.js';
import { DecisionRelationshipDiagram } from './decision-relationship-diagram.js';
import { DecisionPopover } from './decision-popover.js';

afterEach(cleanup);

function node(id: string, ordinal: number, label: string, degree: number): ChangeMapNode {
  return {
    id, ordinal, label, degree, subject: label, filePath: `src/${id}.ts`, fileCount: 1,
    filePaths: [`src/${id}.ts`], symbols: [{ name: label, kind: 'value' as const, change: 'changed' as const }], signatureChanges: [],
    behavior: `Changes ${label}.`, additions: 1, deletions: 1, state: null, riskSignals: [],
  };
}

const map: ChangeMap = {
  nodes: [node('type', 1, 'WorkspaceRef', 1), node('consumer', 2, 'renderWorkspace', 1), node('isolated', 3, 'formatDate', 0)],
  edges: [{
    id: 'type->consumer', fromId: 'type', toId: 'consumer', relation: 'references-type', symbols: ['WorkspaceRef'],
    change: 'added',
    prior: null,
    explanation: 'Decision 2 references the changed type WorkspaceRef from decision 1.',
  }],
  omittedEdges: 0,
};

describe('decision relationship diagram', () => {
  it('draws the open decision and what it relates to, without waiting to be expanded', () => {
    render(<DecisionRelationshipDiagram map={map} decisionId="type" onSelect={() => {}} />);

    expect(screen.getByRole('group', { name: 'Related changes diagram' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decision 2: Changes renderWorkspace/ })).toBeInTheDocument();
    // Unrelated changes stay out: this diagram is the decision's neighbourhood.
    expect(screen.queryByRole('button', { name: /Decision 3: Changes formatDate/ })).toBeNull();
  });

  it('says so plainly when a change relates to nothing else', () => {
    render(<DecisionRelationshipDiagram map={map} decisionId="isolated" onSelect={() => {}} />);

    expect(screen.getByText(/stands alone/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Related changes diagram' })).toBeNull();
  });

  it('selects the change behind a box so the diff pane follows the diagram', () => {
    const onSelect = vi.fn();
    render(<DecisionRelationshipDiagram map={map} decisionId="type" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole('button', { name: /Decision 2: Changes renderWorkspace/ }));
    expect(onSelect).toHaveBeenCalledWith('consumer');
  });

  it('keeps its own node handle so an open panel never re-anchors to it', () => {
    const { container } = render(<DecisionRelationshipDiagram map={map} decisionId="type" onSelect={() => {}} />);

    expect(container.querySelector('[data-decision-diagram-node="type"]')).not.toBeNull();
    expect(container.querySelector('[data-change-map-node="type"]')).toBeNull();
  });
});

describe('decision panel with its diagram attached', () => {
  it('places the diagram immediately to the right of the panel and measures the pair as one', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);

    render(<DecisionPopover
      anchor={anchor}
      anchorId="type"
      labelledBy="title"
      onClose={() => {}}
      aside={<DecisionRelationshipDiagram map={map} decisionId="type" onSelect={() => {}} />}
    >
      <h3 id="title">Decision detail</h3>
    </DecisionPopover>);

    const popover = screen.getByRole('dialog');
    expect(popover).toHaveClass('with-aside');
    // 336 panel + 10 gap + 306 diagram: the pair is placed and flipped together.
    expect(popover.style.width).toBe('652px');

    const [panel, aside] = Array.from(popover.children);
    expect(panel).toHaveClass('decision-popover-panel');
    expect(panel).toContainElement(screen.getByText('Decision detail'));
    expect(aside).toHaveClass('decision-popover-aside');
    expect(aside).toContainElement(screen.getByRole('group', { name: 'Related changes diagram' }));
  });

  it('leaves a panel without a diagram exactly as it was', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);

    render(<DecisionPopover anchor={anchor} anchorId="type" labelledBy="plain-title" onClose={() => {}}>
      <h3 id="plain-title">Decision detail</h3>
    </DecisionPopover>);

    const popover = screen.getByRole('dialog');
    expect(popover).not.toHaveClass('with-aside');
    expect(popover.style.width).toBe('336px');
    expect(popover.querySelector('.decision-popover-panel')).toBeNull();
  });
});
