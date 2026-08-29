import { memo, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { sourceClient } from '../../data/source-client.js';
import { changeTypeLabel } from './logic.js';
import { DiffReviewHeuristicPanel } from './heuristic-panel.js';
import type { ReviewDecision } from './logic.js';
import { aiRiskBand, parseAiRiskScore, reviewAssistDecisionPayload } from './logic.js';
import type { AutoScoreResult } from './auto-score.js';
import { ACTION_LABELS, EXPLAIN_ACTIONS, useCachedReviewAssistAnswers, type ReviewAssistAction, type ReviewAssistTaskIntent } from './review-assist.js';

export type { ReviewAssistAction, ReviewAssistTaskIntent };

/**
 * Assistance is on demand only: nothing here fires until the reviewer clicks
 * one of these buttons, and a failed turn stays visible with its own retry
 * rather than folding into a neutral placeholder.
 *
 * This is popover content now, not a standing column. What a reviewer can read
 * off the code itself — which change this is, its state, its risk signals —
 * lives on the block's gutter marker instead, so the panel only carries what
 * has to be asked for.
 */
export const DiffReviewDecisionDetailCard = memo(function DiffReviewDecisionDetailCard({ decision, taskIntent, autoScore, titleId = 'diff-review-decision-title', decisions = [], children }: {
  decision: ReviewDecision;
  taskIntent: ReviewAssistTaskIntent;
  /** Result of the background pass that scores a diff once its agent comes to
   * rest, streamed in rather than requested by this panel. Absent means no pass
   * has reached this decision yet, which is different from a pass that tried
   * and failed — that arrives with `error` set and stays retryable. */
  autoScore?: AutoScoreResult;
  titleId?: string;
  /** Every decision in the review. Supplies the coverage-evidence pack, which
   * is how a new function's tests — always a different decision, since they
   * live in a different file — reach the model at all. */
  decisions?: ReviewDecision[];
  children: ReactNode;
}) {
  const decisionPayload = reviewAssistDecisionPayload(decision, decisions);

  // Streamed text is held separately from the mutation result so a turn in
  // flight is readable as it arrives; the mutation still owns the final,
  // persisted answer and the error state.
  const [streamedAnswer, setStreamedAnswer] = useState('');
  const assist = useMutation({
    mutationFn: (action: ReviewAssistAction) => {
      setStreamedAnswer('');
      return sourceClient.streamReviewAssist({ action, decision: decisionPayload, taskIntent }, (text) => setStreamedAnswer((previous) => previous + text));
    },
  });

  // Warming lives in the review view, not here: this panel is closed most of
  // the time and warming that stopped with it would leave every first click
  // paying a cold start. This read shares that hook's query, so an answer
  // already warmed is on screen the moment the popover opens.
  const cachedAssistAnswers = useCachedReviewAssistAnswers(decision, taskIntent, decisions);
  const cachedScore = cachedAssistAnswers.data?.score_risk ?? autoScore?.answer ?? undefined;

  // The freshest score wins: a just-finished rescore before the cache read that
  // will eventually agree with it.
  const scoredNow = assist.isSuccess && assist.variables === 'score_risk' ? assist.data : undefined;
  const riskScore = parseAiRiskScore(scoredNow ?? cachedScore);
  const unparsedScoreAnswer = !riskScore ? (scoredNow ?? cachedScore) : undefined;
  // A background failure is shown only while nothing better exists: a manual
  // rescore that succeeded supersedes it, but an unattended failure is never
  // quietly downgraded to "not scored yet".
  const autoScoreError = !riskScore && !unparsedScoreAnswer ? autoScore?.error : null;
  const scoringNow = assist.isPending && assist.variables === 'score_risk';

  return <article className="diff-review-decision-card" aria-labelledby={titleId}>
    <header>
      <div>
        <span className="diff-review-decision-eyebrow">Decision {decision.ordinal}</span>
        {/* The kind of change is the first thing that decides what a reviewer
          * owes this decision — coverage for new code, call sites for a
          * replacement, a reason for a deletion — so it sits next to the
          * ordinal rather than inside the AI panel. */}
        <span className="diff-review-decision-eyebrow"> · {changeTypeLabel(decision.changeType)}{decision.secondaryChangeTypes.length > 0 ? ` · also ${decision.secondaryChangeTypes.map((type) => changeTypeLabel(type).toLowerCase()).join(' + ')}` : ''}</span>
        <h3 id={titleId}>{decision.behavior}</h3>
      </div>
    </header>
    {/* The deterministic layer sits above the AI panel because it constrains
      * it: the change type selects the obligations the assist prompt carries,
      * and the evidence packs are what any coverage or call-site claim is
      * allowed to rest on. Collapsed by default, because a reviewer only opens
      * it when the verdict looks wrong — which is exactly when a description
      * of the heuristic would be useless and the trace is not. */}
    <DiffReviewHeuristicPanel decision={decision} decisions={decisions} />
    <section className="diff-review-ai-risk" aria-labelledby="diff-review-risk-title">
      {/* The score action lives beside the number it produces, not in the assist
        * row: it answers a different question, and its label swaps width once a
        * score exists, which reflowed that row on every rescore. */}
      <div className="diff-review-ai-risk-head">
        <h4 id="diff-review-risk-title">Risk</h4>
        <button
          type="button"
          className="diff-review-ai-risk-action"
          disabled={assist.isPending}
          onClick={() => assist.mutate('score_risk')}
        >{riskScore || unparsedScoreAnswer ? 'Rescore' : 'Score risk'}</button>
      </div>
      <div className="diff-review-ai-risk-score-row">
        {/* The 0-100 number, persisted per decision. It is produced by the
          * `Score risk` action above — never by an ambient pass over the diff. */}
        {riskScore
          ? <>
            <span className="diff-review-ai-risk-score" data-band={aiRiskBand(riskScore.score)}>AI risk score <b>{riskScore.score}</b><small>/100</small></span>
            {riskScore.reason && <small className="diff-review-ai-risk-reason">{riskScore.reason}</small>}
          </>
          : scoringNow
            ? <span className="diff-review-ai-risk-score is-pending" role="status">AI risk score <b>··</b><small>/100</small></span>
            : unparsedScoreAnswer
              ? <small className="diff-review-ai-risk-reason">{unparsedScoreAnswer}</small>
              : autoScoreError
                ? <small className="diff-review-ai-risk-reason is-error" role="alert">Background scoring failed: {autoScoreError} Use Score risk to retry.</small>
                : <small className="diff-review-ai-risk-reason">Not scored yet.</small>}
      </div>
    </section>
    <section className="diff-review-ai-assist" aria-labelledby="diff-review-ai-assist-title">
      <h4 id="diff-review-ai-assist-title">AI assist</h4>
      <div className="diff-review-ai-assist-actions">
        {EXPLAIN_ACTIONS.map((action) => {
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
      {/* A finished score reads as the badge above, not as a second copy of the
        * same two lines down here. */}
      {assist.isSuccess && assist.variables !== 'score_risk' && <p className="diff-review-ai-assist-answer">{assist.data}</p>}
    </section>
    {children}
  </article>;
});
