import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sourceClient, type ReviewAssistActionName } from '../../data/source-client.js';
import type { ReviewDecision } from './logic.js';
import { aiRiskBand, parseAiRiskScore, reviewStateLabel, riskSignalLabel } from './logic.js';

export type ReviewAssistAction = ReviewAssistActionName;
export type ReviewAssistTaskIntent = { title: string; description: string } | null;

/** Long enough that arrowing through a queue of decisions costs nothing, short
 * enough that the answer is usually ready by the time a reviewer has read the
 * hunk and reached for the button. */
const PREFETCH_DWELL_MS = 1_200;

const ACTION_LABELS: Record<ReviewAssistAction, string> = {
  score_risk: 'Score risk',
  explain: 'Explain this decision',
  what_could_break: 'What could break?',
  compare_task_intent: 'Compare against task intent',
};

const ASSIST_ACTIONS = Object.keys(ACTION_LABELS) as ReviewAssistAction[];
/** Every action is cached and prefetched alike, but only the read-and-explain
 * questions belong in the assist row — the score has its own control. */
const EXPLAIN_ACTIONS = ASSIST_ACTIONS.filter((action) => action !== 'score_risk');

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
      const results = await Promise.all(ASSIST_ACTIONS.map((action) => sourceClient.lookupReviewAssist({ action, decision: decisionPayload, taskIntent }).then((response) => [action, response.answer] as const)));
      return Object.fromEntries(results.filter(([, answer]) => answer !== null)) as Partial<Record<ReviewAssistAction, string>>;
    },
  });

  // Warming the two questions reviewers ask most — how risky is this, and what
  // is it — for the one decision they are actually reading. A warm model
  // session still needs a few seconds to write an answer, so the only way a
  // click can be instant is for the answer to already exist. This stays
  // deliberately narrow: the focused decision only, after a dwell, never a
  // score bubble on every hunk in the diff.
  const cachedScore = cachedAssistAnswers.data?.score_risk;
  const cachedExplanation = cachedAssistAnswers.data?.explain;
  // The decision and task intent fully determine the request, so the payload
  // travels by ref and the effect keys off their identity instead of re-firing
  // on every parent render.
  const prefetchInput = useRef({ decisionPayload, taskIntent });
  prefetchInput.current = { decisionPayload, taskIntent };
  const prefetchKey = `${decision.id}|${taskIntent?.title ?? ''}|${taskIntent?.description ?? ''}`;
  useEffect(() => {
    if (cachedAssistAnswers.isPending) return;
    const wanted: ReviewAssistAction[] = [];
    if (!cachedScore) wanted.push('score_risk');
    if (!cachedExplanation) wanted.push('explain');
    if (wanted.length === 0) return;
    let cancelled = false;
    const decisionId = prefetchKey.split('|')[0];
    const timer = setTimeout(() => {
      const { decisionPayload: payload, taskIntent: intent } = prefetchInput.current;
      // Sequential, not concurrent: two prefetches at once would take both warm
      // sessions and leave a real click paying a cold start — the exact case
      // the warm pool exists to prevent. The score goes first because it is the
      // shortest answer and the number a reviewer scans for.
      void wanted.reduce((chain, action) => chain.then(async () => {
        if (cancelled) return;
        await sourceClient.streamReviewAssist({ action, decision: payload, taskIntent: intent }, () => {});
        if (!cancelled) await queryClient.invalidateQueries({ queryKey: ['review-assist-cache', decisionId] });
      }), Promise.resolve())
        // A failed prefetch stays silent: the reviewer never asked for it, and
        // clicking the button still surfaces the failure with its own retry.
        .catch(() => {});
    }, PREFETCH_DWELL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [prefetchKey, cachedScore, cachedExplanation, cachedAssistAnswers.isPending, queryClient]);

  // The freshest score wins: a just-finished rescore before the cache read that
  // will eventually agree with it.
  const scoredNow = assist.isSuccess && assist.variables === 'score_risk' ? assist.data : undefined;
  const riskScore = parseAiRiskScore(scoredNow ?? cachedScore);
  const unparsedScoreAnswer = !riskScore ? (scoredNow ?? cachedScore) : undefined;
  const scoringNow = assist.isPending && assist.variables === 'score_risk';

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
      {/* The score action lives beside the number it produces, not in the assist
        * row: it answers a different question, and its label swaps width once a
        * score exists, which reflowed that row on every rescore. */}
      <div className="diff-review-ai-risk-head">
        <h4 id="diff-review-risk-title">Risk signals</h4>
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
              : <small className="diff-review-ai-risk-reason">Not scored yet.</small>}
      </div>
      <div>
        {decision.riskSignals.length === 0
          ? <p>No elevated risk signals detected.</p>
          : decision.riskSignals.map((signal) => <span key={signal} className="diff-review-queue-risk-score">{riskSignalLabel(signal)}</span>)}
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
