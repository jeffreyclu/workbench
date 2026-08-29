// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildChangeMap } from '../../../shared/change-map.js';
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
  hunks: [{ id: hunks[0].decisionId, filePath: 'src/example.ts', editorUrl: null, hunkRange: hunks[0].range, location: hunks[0].location, lines: [], additions: 1, deletions: 1, state, note: null }],
  filePaths: ['src/example.ts'],
  additions: 1,
  deletions: 1,
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
    changeMap={buildChangeMap(decisions)}
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
      changeMap={buildChangeMap(decisions)}
      activeDecisionId="src/other.ts::@@ -1 +1 @@"
      onSelect={() => {}}
    />);

    // Nothing in this file is selected, so the whole file stays fully readable.
    expect(container.querySelector('.diff-review-file-diff-body')).not.toHaveClass('spotlight');
    expect(container.querySelector('.diff-review-diff-block')).not.toHaveClass('active');
  });

  it('keeps the block header operable as the selection control', () => {
    renderPane('src/other.ts::@@ -1 +1 @@');

    expect(screen.getByRole('button', { name: /Select the decision at/ })).toBeInTheDocument();
  });
});
