// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeMap, ChangeMapNode } from '../../../shared/change-map.js';
import type { ReviewDecision } from '../../../shared/review-decisions.js';
import { DiffReviewChangeMap } from './change-map.js';

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

/** The change behind a disc, as the review pane hands it to the map. */
function decisionFor(id: string, ordinal: number, lines: string[]): ReviewDecision {
  return {
    id, ordinal, subject: id, behavior: `Changes ${id}.`,
    hunks: [{
      id: `${id}-hunk`, filePath: `src/${id}.ts`, fileStatus: 'modified', editorUrl: null,
      hunkRange: '@@ -4,2 +4,2 @@ renderWorkspace', location: '-4,2 +4,', lines, contentHash: id,
      additions: lines.filter((line) => line.startsWith('+')).length,
      deletions: lines.filter((line) => line.startsWith('-')).length,
      state: null, note: null,
    }],
    filePaths: [`src/${id}.ts`], additions: 1, deletions: 1,
    riskSignals: [], changeType: 'behavior_edit', secondaryChangeTypes: [], state: null, note: null,
  };
}

const decisions = [decisionFor('type', 1, ['+type WorkspaceRef = string']), decisionFor('consumer', 2, ['+const scale = ratio()'])];

describe('diff review change navigation', () => {
  it('marks the change the reviewer came from and the ones already reviewed', () => {
    const reviewedMap: ChangeMap = {
      ...map,
      nodes: [{ ...map.nodes[0], state: 'reviewed' }, map.nodes[1], map.nodes[2]],
    };
    render(<DiffReviewChangeMap map={reviewedMap} selectedId="consumer" cameFromId="type" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));

    const origin = screen.getByRole('button', { name: /Decision 1:/ });
    expect(origin).toHaveClass('came-from');
    expect(origin).toHaveClass('reviewed');
    expect(origin.getAttribute('aria-label')).toContain('Came from here.');
    expect(origin.getAttribute('aria-label')).toContain('Already reviewed.');
    expect(screen.getByRole('button', { name: /Decision 2:/ })).not.toHaveClass('came-from');
    expect(screen.getByRole('button', { name: /Decision 2:/ })).not.toHaveClass('reviewed');

    const legend = screen.getByRole('list', { name: 'Review progress in this diagram' });
    expect(legend).toHaveTextContent('Came from change 1');
    expect(legend).toHaveTextContent('1 of 3 already reviewed');
  });
  it('omits the progress legend while nothing has been reviewed or navigated from', () => {
    render(<DiffReviewChangeMap map={map} selectedId="type" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));

    expect(screen.queryByRole('list', { name: 'Review progress in this diagram' })).toBeNull();
  });
  it('keeps the full overview collapsed until requested', () => {
    render(<DiffReviewChangeMap map={map} selectedId="type" onSelect={() => {}} />);

    const toggle = screen.getByRole('button', { name: /Full change diagram/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Change map diagram' })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: 'Change map diagram' })).toBeInTheDocument();
  });
  it('opens the code relationship diagram full screen and restores focus after Escape', () => {
    render(<DiffReviewChangeMap map={map} decisions={decisions} selectedId="type" onSelect={() => {}} />);

    const openFullScreen = screen.getByRole('button', { name: 'Open code relationship diagram full screen' });
    openFullScreen.focus();
    fireEvent.click(openFullScreen);

    const dialog = screen.getByRole('dialog', { name: 'Code relationship diagram' });
    expect(dialog).toHaveClass('change-map-fullscreen');
    const canvas = within(dialog).getByRole('group', { name: 'Change map diagram' });
    expect(canvas).toBeInTheDocument();
    expect(dialog.querySelector('.change-map-top-hud')).toBeInTheDocument();
    expect(dialog.querySelector('.change-map-bottom-hud')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /Decision 2:/ }));
    expect(canvas.querySelector('.change-map-code')).not.toBeNull();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Code relationship diagram' })).toBeNull();
    expect(openFullScreen).toHaveFocus();
    expect(screen.getByRole('button', { name: /Full change diagram/ })).toHaveAttribute('aria-expanded', 'true');
  });
  it('opens a large overview on the selected neighborhood with an explicit full-map control', () => {
    const extraNodes = Array.from({ length: 8 }, (_, index) => node(`extra-${index}`, index + 4, `extra-${index}`, 1));
    const largeMap: ChangeMap = {
      nodes: [...map.nodes, ...extraNodes],
      edges: [...map.edges, ...extraNodes.map((item) => ({
        id: `type->${item.id}`, fromId: 'type', toId: item.id, relation: 'uses' as const, change: 'added' as const, prior: null, symbols: [], explanation: `type relates to ${item.id}`,
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
  it('shows a clicked change\'s code inside the canvas, and never moves the review', () => {
    // The whole point of the column: answering "what is this disc?" must not
    // select the change, because selecting scrolls the diff pane under the
    // diagram — which is what sent the reviewer away from the map every time.
    const selected: string[] = [];
    const { container } = render(<DiffReviewChangeMap
      map={map}
      decisions={decisions}
      selectedId="type"
      riskBands={new Map([['consumer', 'high']])}
      onSelect={(decisionId) => selected.push(decisionId)}
    />);

    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));
    const scored = screen.getByRole('button', { name: /Decision 2:.*high risk\. Show its code beside the diagram\./ });
    expect(scored).toHaveAttribute('aria-expanded', 'false');
    expect(scored.querySelector('.change-map-node-risk-dot.band-high')).not.toBeNull();

    fireEvent.click(scored);
    const code = container.querySelector('.change-map-canvas .change-map-code')!;
    expect(code).not.toBeNull();
    // Highlighting splits a line into token spans, so the code is read off the
    // line element rather than matched as one text node.
    expect([...code.querySelectorAll('.diff-line-code')].map((line) => line.textContent)).toContain('const scale = ratio()');
    expect(within(code as HTMLElement).getByText('src/consumer.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decision 2:/ })).toHaveClass('inspected');
    expect(selected).toEqual([]);

    // Clicking the same disc again puts the column away.
    fireEvent.click(screen.getByRole('button', { name: /Decision 2:/ }));
    expect(container.querySelector('.change-map-code')).toBeNull();
  });
  it('opens the code from the keyboard and only moves the review when asked', () => {
    const selected: string[] = [];
    const { container } = render(<DiffReviewChangeMap map={map} decisions={decisions} selectedId="type" onSelect={(decisionId) => selected.push(decisionId)} />);

    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));
    fireEvent.keyDown(screen.getByRole('button', { name: /Decision 2:/ }), { key: 'Enter' });
    expect(container.querySelector('.change-map-canvas .change-map-code')).not.toBeNull();
    expect(selected).toEqual([]);

    // The one control that does take the reviewer to the diff, because they
    // pressed it.
    fireEvent.click(screen.getByRole('button', { name: 'Open in diff' }));
    expect(selected).toEqual(['consumer']);

    fireEvent.click(screen.getByRole('button', { name: 'Close code' }));
    expect(container.querySelector('.change-map-code')).toBeNull();
  });
  it('leaves the code column off when the changes behind the discs are not supplied', () => {
    const selected: string[] = [];
    const { container } = render(<DiffReviewChangeMap map={map} selectedId="type" onSelect={(decisionId) => selected.push(decisionId)} />);

    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));
    const node = screen.getByRole('button', { name: /Decision 2:/ });
    expect(node).not.toHaveAttribute('aria-expanded');
    fireEvent.click(node);
    expect(container.querySelector('.change-map-code')).toBeNull();
    expect(selected).toEqual(['consumer']);
  });
  it('zooms the mounted canvas and names the kinds of code on it', () => {
    // Carried over from the other implementation's suite: the canvas' own
    // tests drive it directly, so this is the only check that opening the full
    // diagram wires up a camera and a legend the reviewer can actually use.
    render(<DiffReviewChangeMap map={map} selectedId="type" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Full change diagram/ }));

    const canvas = screen.getByRole('group', { name: 'Change map diagram' });
    const surface = canvas.querySelector('.change-map-surface')!;
    const windowWidth = () => Number(surface.getAttribute('viewBox')!.split(' ')[2]);
    const fitted = windowWidth();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(windowWidth()).toBeLessThan(fitted);
    expect(screen.getByRole('group', { name: 'Zoom' })).toHaveTextContent('%');

    const legend = screen.getByRole('list', { name: 'Kinds of code' });
    expect(legend).toHaveTextContent('Types');
    expect(legend).toHaveTextContent('Logic');
  });
});
