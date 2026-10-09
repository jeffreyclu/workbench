// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFileSource } from '../../../shared/contracts.js';
import { buildFileDiffHunks } from '../diff-review/logic.js';
import { ReviewFullFilePane } from './review-full-file-pane.js';

afterEach(cleanup);

const hunks = buildFileDiffHunks({ path: 'src/a.ts', patch: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three', isBinary: false });
const file = { path: 'src/a.ts', content: 'one\nTWO\nthree\nfour\nfive' } as WorkspaceFileSource;

function renderPane(extra: Partial<Parameters<typeof ReviewFullFilePane>[0]> = {}) {
  return render(<ReviewFullFilePane filePath="src/a.ts" file={file} isLoading={false} error={null} hunks={hunks} activeDecisionId={hunks[0].decisionId} selectionTick={0} onSelect={() => {}} {...extra} />);
}

describe('whole-file reading permalinks', () => {
  it('copies a link for the line whose number is pressed, and draws plain numbers without one', () => {
    const onCopyLink = vi.fn();
    const { unmount } = renderPane({ onCopyLink });
    fireEvent.click(screen.getByRole('button', { name: 'Copy link to line 4' }));
    expect(onCopyLink).toHaveBeenCalledWith(4);
    unmount();
    renderPane();
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
  });

  it('marks the line a link named, even one outside every change', () => {
    const { container } = renderPane({ focusLine: 5 });
    const linked = container.querySelectorAll('.review-full-file-row.linked');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toHaveAttribute('data-line', '5');
  });
});
