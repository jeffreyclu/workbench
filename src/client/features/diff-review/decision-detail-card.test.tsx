// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewDecision } from './logic.js';
import { DiffReviewDecisionDetailCard } from './decision-detail-card.js';

afterEach(cleanup);

const decision: ReviewDecision = {
  id: 'src/example.ts::@@ -2 +2 @@ example',
  subject: 'example',
  behavior: 'Changes example in src/example.ts.',
  hunks: [{ id: 'src/example.ts::@@ -2 +2 @@ example', filePath: 'src/example.ts', editorUrl: null, hunkRange: '@@ -2 +2 @@ example', location: 'Line 2', lines: [' const retained = true;', '-const before = false;', '+const after = true;'], additions: 1, deletions: 1, state: null, note: null }],
  filePaths: ['src/example.ts'],
  additions: 1,
  deletions: 1,
  riskSignals: [],
  state: null,
  note: null,
};

describe('diff review decision detail', () => {
  it('identifies the highlighted hunk in the exact-change card', () => {
    render(<DiffReviewDecisionDetailCard decision={decision}><div /></DiffReviewDecisionDetailCard>);

    expect(screen.getByText(/Highlighted in the diff.*Line 2/)).toBeInTheDocument();
  });
});
