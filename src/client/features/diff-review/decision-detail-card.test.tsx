// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDecision } from './logic.js';
import { DiffReviewDecisionDetailCard } from './decision-detail-card.js';

afterEach(cleanup);

const decision: ReviewDecision = {
  id: 'src/example.ts::@@ -2 +2 @@ example',
  ordinal: 1,
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

function renderCard(taskIntent: { title: string; description: string } | null = null) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DiffReviewDecisionDetailCard decision={decision} taskIntent={taskIntent}><div /></DiffReviewDecisionDetailCard>
    </QueryClientProvider>,
  );
}

describe('diff review decision detail', () => {
  it('identifies the highlighted hunk in the exact-change card', () => {
    renderCard();

    expect(screen.getByText(/Highlighted in the diff.*Line 2/)).toBeInTheDocument();
  });

  it('disables comparing against task intent when no task is linked', () => {
    renderCard(null);

    expect(screen.getByRole('button', { name: 'Compare against task intent' })).toBeDisabled();
  });

  it('shows the model answer after an on-demand assist action succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ answer: 'This looks safe.' }),
    }));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));

    await waitFor(() => expect(screen.getByText('This looks safe.')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it('keeps a failed assist request visible with a retry action instead of a neutral fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500, headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ error: 'AI review assist failed.' }),
    }));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'What could break?' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
