// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFileDiffHunks, type ReviewDecision } from './logic.js';
import { DiffReviewFileDiffPane } from './file-diff-pane.js';
import { DecisionPopover } from './decision-popover.js';

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

const decision: ReviewDecision = {
  id: hunks[0].decisionId,
  ordinal: 1,
  subject: 'example',
  behavior: 'Changes example in src/example.ts.',
  hunks: [{ id: hunks[0].decisionId, filePath: 'src/example.ts', editorUrl: null, hunkRange: hunks[0].range, location: hunks[0].location, lines: [], additions: 1, deletions: 1, state: null, note: null }],
  filePaths: ['src/example.ts'],
  additions: 1,
  deletions: 1,
  changeType: 'behavior_edit' as const, secondaryChangeTypes: [],
  riskSignals: [],
  state: null,
  note: null,
};

/** Mirrors the review view's open/close wiring so the marker is exercised
 * through the same state machine the reviewer clicks. */
function Harness() {
  const [selectedId, setSelectedId] = useState(decision.id);
  const [detailAnchor, setDetailAnchor] = useState<{ decisionId: string; anchor: HTMLElement } | null>(null);
  const selectDecision = (decisionId: string) => {
    setSelectedId(decisionId);
    setDetailAnchor((current) => (current && current.decisionId === decisionId ? current : null));
  };
  return <>
    <DiffReviewFileDiffPane
      filePath="src/example.ts"
      editorUrl={null}
      hunks={hunks}
      decisions={[decision]}
      activeDecisionId={selectedId}
      openDetailFor={detailAnchor?.decisionId ?? null}
      onSelect={selectDecision}
      onOpenDetail={(decisionId, anchor) => setDetailAnchor((current) => (current?.decisionId === decisionId ? null : { decisionId, anchor }))}
    />
    {/* Mirrors the view: the panel follows the marker that opened it, not the
      * selection. Gating on the two being equal is what turned the marker into
      * a dead click when a refetch reconciled the selection elsewhere. */}
    {detailAnchor && <DecisionPopover anchor={detailAnchor.anchor} anchorId={detailAnchor.decisionId} labelledBy="popover-title" onClose={() => setDetailAnchor(null)}>
      <p id="popover-title">Decision detail</p>
    </DecisionPopover>}
  </>;
}

const marker = () => screen.getByRole('button', { name: /open decision details/i });

/** A real pointer press: the popover's dismiss listener watches mousedown, so a
 * bare click event would not catch a marker that closes itself as it opens. */
const press = (element: HTMLElement) => {
  fireEvent.mouseDown(element);
  fireEvent.mouseUp(element);
  fireEvent.click(element);
};

describe('decision popover', () => {
  it('opens the decision detail when the gutter marker is clicked', () => {
    render(<Harness />);
    press(marker());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(marker()).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes again when the same marker is clicked', () => {
    render(<Harness />);
    press(marker());
    press(marker());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gives the marker a stable handle so an open panel can re-find it', () => {
    render(<Harness />);
    expect(marker()).toHaveAttribute('data-decision-marker', decision.id);
  });

  /** The panel is a first-class surface: it carries the AI risk score and the
   * assist actions, so failing to open is never an acceptable outcome. These
   * two cover the ways the anchor can go bad underneath it. */
  it('re-anchors to the live marker when the clicked button was replaced by a re-render', () => {
    render(<Harness />);
    const detached = document.createElement('button');
    render(<DecisionPopover anchor={detached} anchorId={decision.id} labelledBy="popover-title" onClose={() => {}}>
      <p id="popover-title">Decision detail</p>
    </DecisionPopover>);
    const panel = screen.getByRole('dialog');
    expect(panel).toBeVisible();
    // Placed off the re-found marker's right edge, not dropped into the
    // centred last-resort position a missing anchor would produce.
    expect(panel).toHaveStyle({ left: '10px' });
  });

  it('still opens, centred, when no marker for the decision is on screen', () => {
    const detached = document.createElement('button');
    render(<DecisionPopover anchor={detached} anchorId="absent-decision" labelledBy="popover-title" onClose={() => {}}>
      <p id="popover-title">Decision detail</p>
    </DecisionPopover>);
    const panel = screen.getByRole('dialog');
    expect(panel).toBeVisible();
    expect(panel).toHaveStyle({ visibility: 'visible', left: `${(window.innerWidth - 336) / 2}px` });
  });
});
