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
    {detailAnchor && detailAnchor.decisionId === selectedId && <DecisionPopover anchor={detailAnchor.anchor} labelledBy="popover-title" onClose={() => setDetailAnchor(null)}>
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
});
