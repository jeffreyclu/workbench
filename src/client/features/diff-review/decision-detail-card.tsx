import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sourceClient } from '../../data/source-client.js';
import { boundConfidenceRequestBlocks, confidenceProminence, confidenceTone, type DiffConfidenceAssessment } from '../diff-confidence.js';
import type { ReviewDecision } from './logic.js';
import { reviewStateLabel, riskSignalLabel } from './logic.js';

export type ReviewAssistAction = 'explain' | 'what_could_break' | 'compare_task_intent';
export type ReviewAssistTaskIntent = { title: string; description: string } | null;

/** Long enough that arrowing through a queue of decisions costs nothing, short
 * enough that the answer is usually ready by the time a reviewer has read the
 * hunk and reached for the button. */
const PREFETCH_DWELL_MS = 1_200;

const ACTION_LABELS: Record<ReviewAssistAction, string> = {
  explain: 'Explain this decision',
  what_could_break: 'What could break?',
  compare_task_intent: 'Compare against task intent',
};

/** Assistance is on demand only: nothing here fires until the reviewer clicks
 * one of these buttons, and a failed turn stays visible with its own retry
 * rather than folding into a neutral placeholder. */
export const DiffReviewDecisionDetailCard = memo(function DiffReviewDecisionDetailCard({ decision, taskIntent, children }: {
  decision: ReviewDecision;
  taskIntent: ReviewAssistTaskIntent;
  children: ReactNode;
}) {
  const decisionPayload = {
    behavior: decision.behavior,
    state: reviewStateLabel(decision.state),
    hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines })),
  };

  // Streamed text is held separately from the mutation result so a turn in
  // flight is readable as it arrives; the mutation still owns the final,
  // persisted answer and the error state.
  const [streamedAnswer, setStreamedAnswer] = useState('');
  const queryClient = useQueryClient();
  const assist = useMutation({
    mutationFn: (action: ReviewAssistAction) => {
      setStreamedAnswer('');
      return sourceClient.streamReviewAssist({ action, decision: decisionPayload, taskIntent }, (text) => setStreamedAnswer((previous) => previous + text));
    },
  });

  // Cache-only reads on mount: a reviewer (or another window) who already
  // asked this exact question about this exact decision sees the answer the
  // instant the hunk opens, with no model spend and no click required. A
  // question nobody has asked yet still needs the on-demand button below.
  const cachedAssistAnswers = useQuery({
    queryKey: ['review-assist-cache', decision.id, taskIntent?.title, taskIntent?.description],
    queryFn: async () => {
      const actions: ReviewAssistAction[] = ['explain', 'what_could_break', 'compare_task_intent'];
      const results = await Promise.all(actions.map((action) => sourceClient.lookupReviewAssist({ action, decision: decisionPayload, taskIntent }).then((response) => [action, response.answer] as const)));
      return Object.fromEntries(results.filter(([, answer]) => answer !== null)) as Partial<Record<ReviewAssistAction, string>>;
    },
  });

  // Warming the one question reviewers ask most, for the one decision they are
  // actually reading. A warm model session still needs a few seconds to write
  // an explanation, so the only way a click can be instant is for the answer to
  // already exist. This stays deliberately narrow: one action, one focused
  // decision, after a dwell — not a score bubble on every hunk in the diff.
  const cachedExplanation = cachedAssistAnswers.data?.explain;
  // The decision and task intent fully determine the request, so the payload
  // travels by ref and the effect keys off their identity instead of re-firing
  // on every parent render.
  const prefetchInput = useRef({ decisionPayload, taskIntent });
  prefetchInput.current = { decisionPayload, taskIntent };
  const prefetchKey = `${decision.id}|${taskIntent?.title ?? ''}|${taskIntent?.description ?? ''}`;
  useEffect(() => {
    if (cachedAssistAnswers.isPending || cachedExplanation) return;
    const timer = setTimeout(() => {
      const { decisionPayload: payload, taskIntent: intent } = prefetchInput.current;
      sourceClient.streamReviewAssist({ action: 'explain', decision: payload, taskIntent: intent }, () => {})
        .then(() => queryClient.invalidateQueries({ queryKey: ['review-assist-cache', prefetchKey.split('|')[0]] }))
        // A failed prefetch stays silent: the reviewer never asked for it, and
        // clicking the button still surfaces the failure with its own retry.
        .catch(() => {});
    }, PREFETCH_DWELL_MS);
    return () => clearTimeout(timer);
  }, [prefetchKey, cachedExplanation, cachedAssistAnswers.isPending, queryClient]);

  const riskScore = useMutation({
    mutationFn: async (): Promise<DiffConfidenceAssessment> => {
      const { requests, sourceKeyByRequestKey } = boundConfidenceRequestBlocks([
        { key: decision.id, lines: decision.hunks.flatMap((hunk) => hunk.lines) },
      ]);
      const { assessments } = await sourceClient.assessDiffBlocks(requests);
      const requestKey = Object.keys(sourceKeyByRequestKey).find((key) => sourceKeyByRequestKey[key] === decision.id) ?? decision.id;
      const assessment = assessments[requestKey];
      if (!assessment) throw new Error('AI risk score returned no assessment for this decision.');
      return assessment;
    },
  });

  const cachedRiskScore = useQuery({
    queryKey: ['review-risk-score-cache', decision.id],
    queryFn: async () => {
      const { requests, sourceKeyByRequestKey } = boundConfidenceRequestBlocks([
        { key: decision.id, lines: decision.hunks.flatMap((hunk) => hunk.lines) },
      ]);
      const { assessments } = await sourceClient.lookupDiffConfidenceBlocks(requests);
      const requestKey = Object.keys(sourceKeyByRequestKey).find((key) => sourceKeyByRequestKey[key] === decision.id) ?? decision.id;
      return assessments[requestKey] ?? null;
    },
  });
  const displayedRiskScore = riskScore.data ?? (riskScore.isPending || riskScore.isError ? undefined : cachedRiskScore.data ?? undefined);

  return <article className="diff-review-decision-card" aria-labelledby="diff-review-decision-title">
    <header>
      <div>
        <span className="diff-review-decision-eyebrow">Behavior decision</span>
        <h3 id="diff-review-decision-title">{decision.behavior}</h3>
      </div>
      <span className={`diff-review-completion-state state-${decision.state ?? 'pending'}`}>{reviewStateLabel(decision.state)}</span>
    </header>
    <section className="diff-review-exact-change" aria-labelledby="diff-review-exact-change-title">
      <h4 id="diff-review-exact-change-title">Exact change</h4>
      <div>
        <small>Highlighted in the diff · {decision.hunks.length === 1 ? decision.hunks[0].location : `${decision.hunks.length} hunks`} · <b>+{decision.additions}</b> <i>−{decision.deletions}</i></small>
      </div>
    </section>
    <section className="diff-review-ai-risk" aria-labelledby="diff-review-risk-title">
      <h4 id="diff-review-risk-title">Risk signals</h4>
      <div>
        {decision.riskSignals.length === 0
          ? <p>No elevated risk signals detected.</p>
          : decision.riskSignals.map((signal) => <span key={signal} className="diff-review-queue-risk-score">{riskSignalLabel(signal)}</span>)}
      </div>
    </section>
    <section className="diff-review-ai-risk-score" aria-labelledby="diff-review-risk-score-title">
      <h4 id="diff-review-risk-score-title">AI risk score</h4>
      {!displayedRiskScore && !riskScore.isPending && !riskScore.isError && <button type="button" onClick={() => riskScore.mutate()}>Score risk</button>}
      {riskScore.isPending && <p className="diff-review-ai-status" role="status">Scoring…</p>}
      {riskScore.isError && <div className="diff-review-ai-assist-error" role="alert">
        <p>{riskScore.error instanceof Error ? riskScore.error.message : 'AI risk score failed.'}</p>
        <button type="button" onClick={() => riskScore.mutate()}>Retry</button>
      </div>}
      {displayedRiskScore && !riskScore.isPending && !riskScore.isError && (() => {
        const assessment = displayedRiskScore;
        const unavailable = assessment.risk === null;
        const tone = confidenceTone(assessment.risk);
        const { opacity, fontWeight } = confidenceProminence(assessment.risk);
        return <div className="diff-review-risk-score-result">
          <div className="diff-review-risk-score-head">
            <span
              className="diff-review-risk-score-value"
              style={{ color: tone, borderColor: tone, opacity, fontWeight }}
              aria-label={unavailable ? 'AI risk assessment unavailable' : `AI risk assessment: ${assessment.risk} out of 100`}
            >
              {unavailable ? '--' : `${assessment.risk}/100`}
            </span>
            <button type="button" onClick={() => riskScore.mutate()}>Rescore</button>
          </div>
          <p className="diff-review-ai-assist-answer">{assessment.reasoning}</p>
        </div>;
      })()}
    </section>
    <section className="diff-review-ai-assist" aria-labelledby="diff-review-ai-assist-title">
      <h4 id="diff-review-ai-assist-title">AI assist</h4>
      <div className="diff-review-ai-assist-actions">
        {(Object.keys(ACTION_LABELS) as ReviewAssistAction[]).map((action) => {
          const hasCachedAnswer = Boolean(cachedAssistAnswers.data?.[action]);
          return <button
            key={action}
            type="button"
            disabled={assist.isPending || (action === 'compare_task_intent' && !taskIntent)}
            title={action === 'compare_task_intent' && !taskIntent ? 'No task is linked to this review.' : hasCachedAnswer ? 'Already answered — click to view.' : undefined}
            onClick={() => assist.mutate(action)}
          >{ACTION_LABELS[action]}{hasCachedAnswer ? ' ✓' : ''}</button>;
        })}
      </div>
      {assist.isPending && (streamedAnswer
        ? <p className="diff-review-ai-assist-answer" role="status">{streamedAnswer}</p>
        : <p className="diff-review-ai-status" role="status">Asking the model…</p>)}
      {assist.isError && <div className="diff-review-ai-assist-error" role="alert">
        <p>{assist.error instanceof Error ? assist.error.message : 'AI assist failed.'}</p>
        <button type="button" onClick={() => assist.variables && assist.mutate(assist.variables)}>Retry</button>
      </div>}
      {assist.isSuccess && <p className="diff-review-ai-assist-answer">{assist.data}</p>}
    </section>
    {children}
  </article>;
});
