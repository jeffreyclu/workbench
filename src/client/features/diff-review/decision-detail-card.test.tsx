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

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: unknown[]) => new Response(events.map(frame).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

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
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/api/review-assist/stream')
      ? sse([{ type: 'delta', text: 'This looks ' }, { type: 'delta', text: 'safe.' }, { type: 'done', answer: 'This looks safe.' }])
      : json({ answer: null }))));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));

    await waitFor(() => expect(screen.getByText('This looks safe.')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it('renders streamed text while the turn is still running instead of a bare spinner', async () => {
    // Definite assignment: the executor runs synchronously, but control-flow
    // analysis cannot see that and would otherwise narrow this to null.
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => { releaseTail = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/api/review-assist/stream')) return json({ answer: null });
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(frame({ type: 'delta', text: 'Partial answer so far.' })));
          await tail;
          controller.enqueue(new TextEncoder().encode(frame({ type: 'done', answer: 'Partial answer so far. Complete.' })));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));

    // Visible before the turn finishes: this is the whole point of streaming.
    await waitFor(() => expect(screen.getByText('Partial answer so far.')).toBeInTheDocument());
    releaseTail();
    await waitFor(() => expect(screen.getByText('Partial answer so far. Complete.')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it('surfaces a mid-stream failure as a visible error rather than a half-written answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/api/review-assist/stream')
      ? sse([{ type: 'delta', text: 'Partial…' }, { type: 'error', message: 'AI review assist stopped unexpectedly.' }])
      : json({ answer: null }))));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('AI review assist stopped unexpectedly.'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
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
