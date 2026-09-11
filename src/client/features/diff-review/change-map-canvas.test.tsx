// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeMap, ChangeMapEdge, ChangeMapNode } from '../../../shared/change-map.js';
import { layoutChangeMap } from './change-map-layout.js';
import { ChangeMapCanvas } from './change-map-canvas.js';

afterEach(cleanup);

function node(id: string, ordinal: number, overrides: Partial<ChangeMapNode> = {}): ChangeMapNode {
  return {
    id, ordinal, label: id, degree: 1, subject: id, filePath: `src/client/features/queue/${id}.ts`, fileCount: 1,
    filePaths: [`src/client/features/queue/${id}.ts`], symbols: [], signatureChanges: [],
    behavior: `Changes ${id}.`, additions: 5, deletions: 1, state: null, riskSignals: [],
    ...overrides,
  };
}

function edge(fromId: string, toId: string): ChangeMapEdge {
  return { id: `${fromId}->${toId}`, fromId, toId, relation: 'calls', change: 'added', prior: null, symbols: [], explanation: `${fromId} calls ${toId}` };
}

/** A hub in one folder, a neighbour beside it, and a change in another package
 * it reaches into — the three cases the drawing has to tell apart. */
const map: ChangeMap = {
  nodes: [
    node('hub', 1, { filePath: 'src/client/features/queue/view.tsx', additions: 200, deletions: 120, degree: 3 }),
    node('neighbour', 2, { filePath: 'src/client/features/queue/logic.ts', additions: 2, deletions: 0 }),
    node('sibling', 3, { filePath: 'src/client/features/task/view.tsx', additions: 20, deletions: 4 }),
    node('server', 4, { filePath: 'src/server/repository.ts', additions: 30, deletions: 10 }),
  ],
  edges: [edge('hub', 'neighbour'), edge('hub', 'sibling'), edge('hub', 'server')],
  omittedEdges: 0,
};

function draw(overrides: Partial<Parameters<typeof ChangeMapCanvas>[0]> = {}) {
  return render(<ChangeMapCanvas
    layout={layoutChangeMap(map)}
    selectedId={null}
    selectedEdgeId={null}
    onSelect={() => {}}
    onSelectEdge={() => {}}
    {...overrides}
  />);
}

const nodeGroup = (container: HTMLElement, id: string) => container.querySelector(`[data-change-map-node="${id}"]`)!;
const disc = (container: HTMLElement, id: string) => nodeGroup(container, id).querySelector('.change-map-node-body')!;

describe('change map canvas', () => {
  it('draws a change as a disc whose size is the code it moves', () => {
    const { container } = draw();
    const radiusOf = (id: string) => Number(disc(container, id).getAttribute('r'));

    expect(radiusOf('hub')).toBeGreaterThan(radiusOf('server'));
    expect(radiusOf('server')).toBeGreaterThan(radiusOf('neighbour'));
  });

  it('colours a disc by what kind of code the change is', () => {
    const { container } = draw();

    expect(nodeGroup(container, 'hub')).toHaveClass('category-ui');
    expect(nodeGroup(container, 'neighbour')).toHaveClass('category-logic');
    expect(nodeGroup(container, 'server')).toHaveClass('category-data');
  });

  it('draws the folder a change sits in, inside the package that holds it', () => {
    const { container } = draw();
    const folders = [...container.querySelectorAll('.change-map-folder-label')].map((item) => item.textContent);
    const packages = [...container.querySelectorAll('.change-map-package-label')].map((item) => item.textContent);

    expect(folders.some((text) => text?.includes('features/queue'))).toBe(true);
    expect(packages.some((text) => text?.startsWith('src/client'))).toBe(true);
    expect(packages.some((text) => text?.startsWith('src/server'))).toBe(true);
    // A folder nothing leaves says so; one most of whose lines leave is marked.
    expect(container.querySelector('.change-map-folder.reaching')).not.toBeNull();
  });

  it('sends one line out of the hub per relationship, each leaving its rim', () => {
    const { container } = draw();
    const hub = disc(container, 'hub');
    const centre = { x: Number(hub.getAttribute('cx')), y: Number(hub.getAttribute('cy')) };
    const radius = Number(hub.getAttribute('r'));
    const lines = [...container.querySelectorAll('.change-map-edge-line')];

    expect(lines).toHaveLength(3);
    const angles = lines.map((line) => {
      const [x, y] = line.getAttribute('d')!.slice(2).split(' ').slice(0, 2).map(Number);
      expect(Math.hypot(x - centre.x, y - centre.y)).toBeCloseTo(radius, 0);
      return Math.round(Math.atan2(y - centre.y, x - centre.x) * 1000);
    });
    expect(new Set(angles).size).toBe(3);
  });

  it('weights a line by how far out of its folder it goes', () => {
    const { container } = draw();

    expect(container.querySelector('.change-map-edge.scope-folder')).not.toBeNull();
    expect(container.querySelector('.change-map-edge.scope-package')).not.toBeNull();
    expect(container.querySelector('.change-map-edge.scope-cross-package')).not.toBeNull();
  });

  it('moves a camera over the drawing instead of sizing the picture to it', () => {
    // The old surface grew to the layout and left the reviewer scrolling. Here
    // the element stays put and the window onto the world moves.
    const { container } = draw();
    const surface = container.querySelector('.change-map-surface')!;
    const windowWidth = () => Number(surface.getAttribute('viewBox')!.split(' ')[2]);

    expect(surface).toHaveAttribute('width', '100%');
    const fitted = windowWidth();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(windowWidth()).toBeLessThan(fitted);
    expect(screen.getByRole('group', { name: 'Zoom' })).toHaveTextContent('%');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(windowWidth()).toBeCloseTo(fitted, 1);

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
    expect(windowWidth()).toBeCloseTo(fitted, 1);
  });

  it('zooms and pans from the keyboard, for a reviewer who never touches the wheel', () => {
    const { container } = draw();
    const surface = container.querySelector('.change-map-surface')!;
    const box = () => surface.getAttribute('viewBox')!.split(' ').map(Number);
    const canvas = screen.getByRole('group', { name: 'Change map diagram' });

    const [startX] = box();
    fireEvent.keyDown(canvas, { key: 'ArrowRight' });
    expect(box()[0]).toBeGreaterThan(startX);

    const widthBefore = box()[2];
    fireEvent.keyDown(canvas, { key: '+' });
    expect(box()[2]).toBeLessThan(widthBefore);

    fireEvent.keyDown(canvas, { key: '0' });
    expect(box()[2]).toBeCloseTo(widthBefore, 1);
  });

  it('fits a smaller neighbourhood into the shorter frame a panel gives it', () => {
    const { container } = draw({ viewHeight: 300 });
    expect(container.querySelector('.change-map-surface')).toHaveAttribute('height', '300');
  });
});
