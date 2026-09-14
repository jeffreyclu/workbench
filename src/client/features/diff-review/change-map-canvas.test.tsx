// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

/** jsdom measures every element as zero, which is the one case the camera has
 * a fallback for — so a test that does not lay the element out never exercises
 * the arithmetic a reviewer actually drives. This gives the surface a real
 * pixel box and a resize observer that can be fired by hand. */
function layOut(width: number, height: number) {
  const box = { width, height };
  const observers: ResizeObserverCallback[] = [];
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function measured(this: Element) {
    if (!this.classList?.contains('change-map-surface')) return original.call(this);
    return { x: 0, y: 0, top: 0, left: 0, right: box.width, bottom: box.height, width: box.width, height: box.height, toJSON: () => ({}) } as DOMRect;
  };
  class Observer {
    constructor(callback: ResizeObserverCallback) { observers.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  return {
    /** The element changes size — the window narrowing, or the code column
     * opening and taking 40% of the width with it. */
    resize(nextWidth: number, nextHeight: number) {
      box.width = nextWidth;
      box.height = nextHeight;
      act(() => {
        for (const callback of observers) {
          callback([{ contentRect: { width: nextWidth, height: nextHeight } } as ResizeObserverEntry], {} as ResizeObserver);
        }
      });
    },
    restore() {
      Element.prototype.getBoundingClientRect = original;
      globalThis.ResizeObserver = previousObserver;
    },
  };
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

  it('keeps the window onto the world the same shape as the element', () => {
    // The `viewBox` and the element must agree: when they do not, the SVG
    // letterboxes the drawing to fit and every pointer sent to the surface
    // resolves to the wrong world point — the map slides out from under the
    // cursor instead of zooming about it.
    const laid = layOut(800, 560);
    try {
      const { container } = draw();
      const [, , width, height] = container.querySelector('.change-map-surface')!.getAttribute('viewBox')!.split(' ').map(Number);

      expect(width / height).toBeCloseTo(800 / 560, 3);
    } finally {
      laid.restore();
    }
  });

  it('holds the point under the pointer still while the wheel zooms', () => {
    const laid = layOut(800, 560);
    try {
      const { container } = draw();
      const surface = container.querySelector('.change-map-surface')!;
      const box = () => surface.getAttribute('viewBox')!.split(' ').map(Number);
      // What the cursor is over, in the world: the left edge of the window
      // plus the distance across it, at the scale the window is drawn at.
      const under = (clientX: number, clientY: number) => {
        const [x, y, width, height] = box();
        return { x: x + (clientX / 800) * width, y: y + (clientY / 560) * height };
      };

      const fitted = box()[2];
      const before = under(620, 140);
      fireEvent.wheel(surface, { deltaY: -240, clientX: 620, clientY: 140 });
      const after = under(620, 140);

      expect(box()[2]).toBeLessThan(fitted);
      expect(after.x).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
    } finally {
      laid.restore();
    }
  });

  it('narrows onto the same drawing when the code column opens beside it', () => {
    // Clicking a disc takes 40% of the width away. The camera has to keep what
    // the reviewer was looking at rather than letting the shrinking element
    // rescale the picture underneath them.
    const laid = layOut(800, 560);
    try {
      const { container } = draw();
      const surface = container.querySelector('.change-map-surface')!;
      const centre = () => {
        const [x, y, width, height] = surface.getAttribute('viewBox')!.split(' ').map(Number);
        return { x: x + width / 2, y: y + height / 2, scale: 800 / width };
      };

      const before = centre();
      laid.resize(480, 560);
      const after = centre();

      expect(after.x).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
      // The scale is untouched: a narrower window shows less of the world, it
      // does not zoom the world.
      expect(480 / Number(surface.getAttribute('viewBox')!.split(' ')[2])).toBeCloseTo(before.scale, 3);
    } finally {
      laid.restore();
    }
  });

  it('will not let one wheel flick throw the camera to its stop', () => {
    // A trackpad reports hundreds of units of delta per gesture, several times
    // a frame. Uncapped, one flick ends at the zoom limit.
    const laid = layOut(800, 560);
    try {
      const { container } = draw();
      const surface = container.querySelector('.change-map-surface')!;
      const scale = () => 800 / Number(surface.getAttribute('viewBox')!.split(' ')[2]);

      const before = scale();
      fireEvent.wheel(surface, { deltaY: -4000, clientX: 400, clientY: 280 });

      expect(scale()).toBeGreaterThan(before);
      expect(scale()).toBeLessThanOrEqual(before * 1.2 + 0.001);
    } finally {
      laid.restore();
    }
  });

  it('will not let a drag lose the drawing off the edge of the pane', () => {
    const laid = layOut(800, 560);
    try {
      const { container } = draw();
      const surface = container.querySelector('.change-map-surface')!;
      const box = () => surface.getAttribute('viewBox')!.split(' ').map(Number);

      // This jsdom has no `PointerEvent`, so the press is sent as the mouse
      // event it is built on — which still carries the button and the
      // coordinates the handler reads.
      const pointer = (type: string, clientX: number, clientY: number) =>
        fireEvent(surface, new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY }));

      pointer('pointerdown', 400, 280);
      for (let step = 1; step <= 40; step += 1) pointer('pointermove', 400 + step * 200, 280 + step * 200);
      pointer('pointerup', 400, 280);

      // The window still overlaps the drawing, so there is something on screen
      // to navigate back by.
      const [x, y, width, height] = box();
      expect(x).toBeLessThan(0);
      expect(x + width).toBeGreaterThan(0);
      expect(y).toBeLessThan(0);
      expect(y + height).toBeGreaterThan(0);
    } finally {
      laid.restore();
    }
  });

  it('fits a smaller neighbourhood into the shorter frame a panel gives it', () => {
    const { container } = draw({ viewHeight: 300 });
    expect(container.querySelector('.change-map-surface')).toHaveAttribute('height', '300');
  });
});
