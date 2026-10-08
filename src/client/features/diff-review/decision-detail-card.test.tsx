// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { socketTransport } from '../../data/socket-transport.js';
import type { ReviewDecision } from './logic.js';
import { DiffReviewDecisionDetailCard } from './decision-detail-card.js';

afterEach(cleanup);

const decision: ReviewDecision = {
  id: 'src/example.ts::@@ -2 +2 @@ example',
  ordinal: 1,
  subject: 'example',
  behavior: 'Changes example in src/example.ts.',
  hunks: [{ id: 'src/example.ts::@@ -2 +2 @@ example', filePath: 'src/example.ts', fileStatus: 'modified', editorUrl: null, hunkRange: '@@ -2 +2 @@ example', location: 'Line 2', contentHash: 'hash-1', lines: [' const retained = true;', '-const before = false;', '+const after = true;'], additions: 1, deletions: 1, state: null, note: null }],
  filePaths: ['src/example.ts'],
  additions: 1,
  deletions: 1,
  changeType: 'behavior_edit' as const, secondaryChangeTypes: [],
  riskSignals: [],
  state: null,
  note: null,
};

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mockReviewAssistStream(events: unknown[]) {
  return vi.spyOn(socketTransport, 'request').mockImplementation(async (_operation, input, options) => {
    const request = input as { path?: string };
    if (request.path !== '/api/review-assist/stream') throw new Error(`Unexpected socket request: ${request.path ?? 'unknown'}`);
    for (const event of events) options?.onProgress?.(frame(event));
    return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'utf8' };
  });
}

function renderCard(taskIntent: { title: string; description: string } | null = null, autoScore?: { answer: string | null; error: string | null }) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <DiffReviewDecisionDetailCard decision={decision} taskIntent={taskIntent} autoScore={autoScore}><div /></DiffReviewDecisionDetailCard>
    </QueryClientProvider>,
  );
}

describe('diff review decision detail', () => {
  it('says what kind of change the decision is, because that decides what the reviewer has to establish', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DiffReviewDecisionDetailCard decision={{ ...decision, changeType: 'refactor_pure', secondaryChangeTypes: ['deletion'] }} taskIntent={null}><div /></DiffReviewDecisionDetailCard>
      </QueryClientProvider>,
    );

    // A refactor that also drops a declaration must not read as a plain
    // refactor: the dropped symbol is the part that needs an answer.
    expect(screen.getByText(/Refactor/)).toBeInTheDocument();
    expect(screen.getByText(/also deletion/)).toBeInTheDocument();
  });

  it('names which decision the popover is describing', () => {
    // Where the change is now reads off the block's gutter marker; the panel only
    // has to say which decision it belongs to and what that decision does.
    renderCard();

    expect(screen.getByText('Decision 1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Changes example in src/example.ts.' })).toBeInTheDocument();
  });

  it('disables comparing against task intent when no task is linked', () => {
    renderCard(null);

    expect(screen.getByRole('button', { name: 'Compare against task intent' })).toBeDisabled();
  });

  it('renders a score streamed in by the background pass without asking for one', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => json({ answer: null }));
    vi.stubGlobal('fetch', fetchMock);
    renderCard(null, { answer: 'SCORE: 72\nTouches an auth path with no test.', error: null });

    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText('Touches an auth path with no test.')).toBeInTheDocument();
    // A decision the background pass already scored must not be re-scored by
    // the panel's own prefetch.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/review-assist/stream'))).toBe(false);
    vi.unstubAllGlobals();
  });

  it('keeps a failed background score visible and retryable rather than showing it as unscored', () => {
    renderCard(null, { answer: null, error: 'AI review assist timed out after 30 seconds.' });

    expect(screen.getByRole('alert')).toHaveTextContent('Background scoring failed: AI review assist timed out after 30 seconds.');
    expect(screen.queryByText('Not scored yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Score risk' })).toBeEnabled();
  });

  it('shows the model answer after an on-demand assist action succeeds', async () => {
    mockReviewAssistStream([{ type: 'delta', text: 'This looks ' }, { type: 'delta', text: 'safe.' }, { type: 'done', answer: 'This looks safe.' }]);
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
    vi.spyOn(socketTransport, 'request').mockImplementation(async (_operation, input, options) => {
      const request = input as { path?: string };
      if (request.path !== '/api/review-assist/stream') throw new Error(`Unexpected socket request: ${request.path ?? 'unknown'}`);
      options?.onProgress?.(frame({ type: 'delta', text: 'Partial answer so far.' }));
      await tail;
      options?.onProgress?.(frame({ type: 'done', answer: 'Partial answer so far. Complete.' }));
      return { status: 200, contentType: 'text/event-stream', body: '', encoding: 'utf8' };
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));

    // Visible before the turn finishes: this is the whole point of streaming.
    await waitFor(() => expect(screen.getByText('Partial answer so far.')).toBeInTheDocument());
    releaseTail();
    await waitFor(() => expect(screen.getByText('Partial answer so far. Complete.')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });

  it('surfaces a mid-stream failure as a visible error rather than a half-written answer', async () => {
    mockReviewAssistStream([{ type: 'delta', text: 'Partial…' }, { type: 'error', message: 'AI review assist stopped unexpectedly.' }]);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Explain this decision' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('AI review assist stopped unexpectedly.'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('keeps a failed assist request visible with a retry action instead of a neutral fallback', async () => {
    vi.spyOn(socketTransport, 'request').mockResolvedValue({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'AI review assist failed.' }), encoding: 'utf8' });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'What could break?' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
  it('renders the 0-100 risk score on demand from the score action', async () => {
    mockReviewAssistStream([{ type: 'done', answer: 'SCORE: 72\nTouches a shared auth boundary with no test coverage.' }]);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Score risk' }));

    await waitFor(() => expect(screen.getByText(/AI risk score/)).toHaveTextContent('72'));
    expect(screen.getByText('Touches a shared auth boundary with no test coverage.')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('shows a previously persisted score with no click and no model turn', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/api/review-assist/lookup')
      ? json({ answer: 'SCORE: 15\nIsolated rename.' })
      : json({ answer: null })));
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    await waitFor(() => expect(screen.getByText(/AI risk score/)).toHaveTextContent('15'));
    expect(screen.getByRole('button', { name: 'Rescore' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([input]) => !String(input).endsWith('/api/review-assist/stream'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('opens the heuristic and shows every prepared field for a critical decision', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const action = JSON.parse(String(init?.body ?? '{}')).action as string;
      const answers: Record<string, string> = {
        score_risk: 'SCORE: 88\nAuthorization boundary.',
        explain: 'This changes which requests are authorized.',
        what_could_break: '- Denied requests could be accepted.\n- Existing sessions could be rejected.',
        compare_task_intent: 'Aligned with the linked task.',
      };
      return json({ answer: answers[action] ?? null });
    }));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DiffReviewDecisionDetailCard
          decision={{ ...decision, riskSignals: ['auth'] }}
          taskIntent={{ title: 'Protect authorization', description: 'Keep denied requests denied.' }}
          tier="T3"
          critical
        ><div /></DiffReviewDecisionDetailCard>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('button', { name: /Heuristic/ })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getByText('This changes which requests are authorized.')).toBeInTheDocument());
    expect(screen.getByText('Denied requests could be accepted.')).toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveTextContent('Existing sessions could be rejected.');
    expect(screen.getByText('Aligned with the linked task.')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('does not invent a number when the model ignores the score format', async () => {
    mockReviewAssistStream([{ type: 'done', answer: 'I cannot assess this change.' }]);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Score risk' }));

    await waitFor(() => expect(screen.getByText('I cannot assess this change.')).toBeInTheDocument());
    expect(screen.queryByText(/AI risk score/)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
