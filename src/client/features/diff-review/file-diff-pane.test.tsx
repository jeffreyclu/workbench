// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFileDiffHunks, type ReviewDecision } from './logic.js';
import { DiffReviewFileDiffPane } from './file-diff-pane.js';

afterEach(cleanup);

const patch = [
  '@@ -1,4 +1,4 @@ function example()',
  ' function example() {',
  '   if (ready) {',
  '-    return before;',
  '+    return after;',
  '   }',
].join('\n');

const hunks = buildFileDiffHunks({ path: 'src/example.ts', patch, isBinary: false });

const decision = (state: ReviewDecision['state']): ReviewDecision => ({
  id: hunks[0].decisionId,
  ordinal: 1,
  subject: 'example',
  behavior: 'Changes example in src/example.ts.',
  hunks: [{ id: hunks[0].decisionId, filePath: 'src/example.ts', fileStatus: 'modified', editorUrl: null, hunkRange: hunks[0].range, location: hunks[0].location, contentHash: 'hash-1', lines: [], additions: 1, deletions: 1, state, note: null }],
  filePaths: ['src/example.ts'],
  additions: 1,
  deletions: 1,
  changeType: 'behavior_edit' as const, secondaryChangeTypes: [],
  riskSignals: [],
  state,
  note: null,
});

function renderPane(activeDecisionId: string) {
  const decisions = [decision(null)];
  return render(<DiffReviewFileDiffPane
    filePath="src/example.ts"
    editorUrl={null}
    hunks={hunks}
    decisions={decisions}
    activeDecisionId={activeDecisionId}
    onSelect={() => {}}
  />);
}

describe('review file diff pane', () => {
  it('renders each line with its source indentation intact', () => {
    const { container } = renderPane(hunks[0].decisionId);
    const codeCells = [...container.querySelectorAll('.diff-line-code')].map((cell) => cell.textContent);

    // The marker column owns the +/-/space; the code column must keep every
    // leading space of the source so nesting is readable in the diff.
    expect(codeCells).toContain('function example() {');
    expect(codeCells).toContain('  if (ready) {');
    expect(codeCells).toContain('    return after;');
    expect(codeCells).toContain('    return before;');
  });

  it('spotlights the selected block and dims the rest of the file only while a block is selected', () => {
    const { container, rerender } = renderPane(hunks[0].decisionId);

    expect(container.querySelector('.diff-review-file-diff-body')).toHaveClass('spotlight');
    expect(container.querySelector('.diff-review-diff-block')).toHaveClass('active');

    const decisions = [decision(null)];
    rerender(<DiffReviewFileDiffPane
      filePath="src/example.ts"
      editorUrl={null}
      hunks={hunks}
      decisions={decisions}
      activeDecisionId="src/other.ts::@@ -1 +1 @@"
      onSelect={() => {}}
    />);

    // Nothing in this file is selected, so the whole file stays fully readable.
    expect(container.querySelector('.diff-review-file-diff-body')).not.toHaveClass('spotlight');
    expect(container.querySelector('.diff-review-diff-block')).not.toHaveClass('active');
  });

  it('scrolls the pane to the first block of the selected decision, measured against the pane itself', () => {
    const twoHunkPatch = [
      '@@ -1,3 +1,3 @@ function first()',
      ' function first() {',
      '-  return before;',
      '+  return after;',
      '@@ -40,3 +40,3 @@ function second()',
      ' function second() {',
      '-  return before;',
      '+  return after;',
    ].join('\n');
    const fileHunks = buildFileDiffHunks({ path: 'src/example.ts', patch: twoHunkPatch, isBinary: false });
    expect(fileHunks).toHaveLength(2);

    // One decision owning both blocks: the scroll must land on the first, not
    // on whichever block happened to mount last.
    const spanning: ReviewDecision = {
      ...decision(null),
      id: fileHunks[0].decisionId,
      hunks: fileHunks.map((hunk) => ({ id: hunk.decisionId, filePath: 'src/example.ts', fileStatus: 'modified', editorUrl: null, hunkRange: hunk.range, location: hunk.location, contentHash: `hash-${hunk.range}`, lines: [], additions: 1, deletions: 1, state: null, note: null })),
    };

    // jsdom reports no geometry, so the pane and its two blocks are given the
    // layout a browser would report: a 400px pane with the blocks below it.
    const scrolls: number[] = [];
    const isPane = (el: Element) => el.classList.contains('diff-review-file-diff-body');
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const originals = {
      rect: Element.prototype.getBoundingClientRect,
      scrollTo: HTMLElement.prototype.scrollTo,
      clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
      scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
    };
    Element.prototype.getBoundingClientRect = function stub(this: Element) {
      if (isPane(this)) return rect(50, 400);
      if (this.classList.contains('diff-review-diff-block')) return rect(this.textContent?.includes('function first') ? 250 : 650, 200);
      return rect(0, 0);
    };
    HTMLElement.prototype.scrollTo = function stub(this: HTMLElement, options?: ScrollToOptions | number) {
      if (isPane(this)) scrolls.push(typeof options === 'object' ? options.top ?? 0 : Number(options ?? 0));
    };
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isPane(this) ? 400 : 0; } });
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isPane(this) ? 2000 : 0; } });

    try {
      render(<DiffReviewFileDiffPane
        filePath="src/example.ts"
        editorUrl={null}
        hunks={fileHunks}
        decisions={[spanning]}
        activeDecisionId={fileHunks[0].decisionId}
        onSelect={() => {}}
      />);
    } finally {
      Element.prototype.getBoundingClientRect = originals.rect;
      HTMLElement.prototype.scrollTo = originals.scrollTo;
      if (originals.clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', originals.clientHeight);
      if (originals.scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', originals.scrollHeight);
    }

    // First block sits at 250 - 50 = 200 inside the pane and is shorter than
    // it, so it centres: 200 - (400 - 200) / 2 = 100. Targeting the last block
    // (or an offsetTop measured against some other ancestor) would not.
    expect(scrolls).toEqual([100]);
  });

  it('scrolls back to the selected block when the same decision is picked again', () => {
    // The reviewer scrolls the diff by hand to read context, then clicks the
    // decision they are already on. React bails out of the identical id, so the
    // selection counter is what has to bring them back.
    const scrolls: number[] = [];
    const isPane = (el: Element) => el.classList.contains('diff-review-file-diff-body');
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const originals = {
      rect: Element.prototype.getBoundingClientRect,
      scrollTo: HTMLElement.prototype.scrollTo,
      clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
      scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
    };
    Element.prototype.getBoundingClientRect = function stub(this: Element) {
      if (isPane(this)) return rect(50, 400);
      if (this.classList.contains('diff-review-diff-block')) return rect(250, 200);
      return rect(0, 0);
    };
    HTMLElement.prototype.scrollTo = function stub(this: HTMLElement, options?: ScrollToOptions | number) {
      if (isPane(this)) scrolls.push(typeof options === 'object' ? options.top ?? 0 : Number(options ?? 0));
    };
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isPane(this) ? 400 : 0; } });
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isPane(this) ? 2000 : 0; } });

    const pane = (tick: number) => <DiffReviewFileDiffPane
      filePath="src/example.ts"
      editorUrl={null}
      hunks={hunks}
      decisions={[decision(null)]}
      activeDecisionId={hunks[0].decisionId}
      selectionTick={tick}
      onSelect={() => {}}
    />;
    try {
      const { rerender } = render(pane(1));
      expect(scrolls).toEqual([100]);
      // Same decision, one more click: the pane scrolls to the same place again
      // instead of leaving the reviewer where they had scrolled to.
      rerender(pane(2));
      expect(scrolls).toEqual([100, 100]);
    } finally {
      Element.prototype.getBoundingClientRect = originals.rect;
      HTMLElement.prototype.scrollTo = originals.scrollTo;
      if (originals.clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', originals.clientHeight);
      if (originals.scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', originals.scrollHeight);
    }
  });

  it('corrects the landing when the block moves after the commit that measured it', () => {
    // A peek panel collapsing above the block, or the pane being revealed in
    // the outer scroller, moves the target after the first measurement. The
    // reviewer should end up on the block, not next to where it used to be.
    const scrolls: number[] = [];
    const frames: FrameRequestCallback[] = [];
    let blockTop = 250;
    const isPane = (el: Element) => el.classList.contains('diff-review-file-diff-body');
    const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const originals = {
      rect: Element.prototype.getBoundingClientRect,
      scrollTo: HTMLElement.prototype.scrollTo,
      raf: window.requestAnimationFrame,
      clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
      scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
    };
    Element.prototype.getBoundingClientRect = function stub(this: Element) {
      if (isPane(this)) return rect(50, 400);
      if (this.classList.contains('diff-review-diff-block')) return rect(blockTop, 200);
      return rect(0, 0);
    };
    HTMLElement.prototype.scrollTo = function stub(this: HTMLElement, options?: ScrollToOptions | number) {
      if (isPane(this)) scrolls.push(typeof options === 'object' ? options.top ?? 0 : Number(options ?? 0));
    };
    // Frames are driven by hand so the settle loop is observable rather than
    // racing the test.
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => frames.push(callback)) as typeof window.requestAnimationFrame;
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isPane(this) ? 400 : 0; } });
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isPane(this) ? 2000 : 0; } });

    try {
      render(<DiffReviewFileDiffPane
        filePath="src/example.ts"
        editorUrl={null}
        hunks={hunks}
        decisions={[decision(null)]}
        activeDecisionId={hunks[0].decisionId}
        onSelect={() => {}}
      />);
      // Block at 250, pane at 50: 200 inside the pane, centred in 400 → 100.
      expect(scrolls).toEqual([100]);

      // The layout above the block collapses by 100px before the next frame.
      blockTop = 150;
      frames.splice(0).forEach((callback) => callback(0));

      expect(scrolls).toEqual([100, 0]);
    } finally {
      Element.prototype.getBoundingClientRect = originals.rect;
      HTMLElement.prototype.scrollTo = originals.scrollTo;
      window.requestAnimationFrame = originals.raf;
      if (originals.clientHeight) Object.defineProperty(Element.prototype, 'clientHeight', originals.clientHeight);
      if (originals.scrollHeight) Object.defineProperty(Element.prototype, 'scrollHeight', originals.scrollHeight);
    }
  });

  it('keeps the block header operable as the selection control', () => {
    renderPane('src/other.ts::@@ -1 +1 @@');

    expect(screen.getByRole('button', { name: /Select the decision at/ })).toBeInTheDocument();
  });
});
