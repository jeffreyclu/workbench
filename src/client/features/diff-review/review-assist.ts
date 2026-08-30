import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sourceClient, type ReviewAssistActionName } from '../../data/source-client.js';
import type { ReviewDecision } from './logic.js';
import { reviewAssistDecisionPayload } from './logic.js';
import type { AutoScoreResult } from './auto-score.js';
import type { ReviewAssistTier } from '../../../shared/contracts.js';

export type ReviewAssistAction = ReviewAssistActionName;
export type ReviewAssistTaskIntent = { title: string; description: string } | null;

/** Long enough that arrowing through a queue of decisions costs nothing, short
 * enough that the answer is usually ready by the time a reviewer has read the
 * hunk and reached for the button. */
const PREFETCH_DWELL_MS = 1_200;

export const ACTION_LABELS: Record<ReviewAssistAction, string> = {
  score_risk: 'Score risk',
  explain: 'Explain this decision',
  what_could_break: 'What could break?',
  compare_task_intent: 'Compare against task intent',
};

export const ASSIST_ACTIONS = Object.keys(ACTION_LABELS) as ReviewAssistAction[];
/** Every action is cached and prefetched alike, but only the read-and-explain
 * questions belong in the assist row — the score has its own control. */
export const EXPLAIN_ACTIONS = ASSIST_ACTIONS.filter((action) => action !== 'score_risk');

export type CachedAssistAnswers = Partial<Record<ReviewAssistAction, string>>;

function cacheKey(decisionId: string, taskIntent: ReviewAssistTaskIntent, tier: ReviewAssistTier | null) {
  // Tier is part of the key for the same reason it is part of the server's
  // cache hash: a T1 skim and a T3 study are different answers.
  return ['review-assist-cache', decisionId, taskIntent?.title, taskIntent?.description, tier];
}

/** Cache-only reads: a reviewer (or another window) who already asked this
 * exact question about this exact decision sees the answer the instant the
 * decision opens, with no model spend and no click required. */
export function useCachedReviewAssistAnswers(decision: ReviewDecision | null, taskIntent: ReviewAssistTaskIntent, siblings: ReviewDecision[] = [], tier: ReviewAssistTier | null = null) {
  // Siblings feed the coverage-evidence pack, which is part of the server's
  // cache key. Reading with a different sibling set than the background scorer
  // wrote with would miss every cached answer, so both pass the whole review.
  const decisionPayload = decision ? reviewAssistDecisionPayload(decision, siblings) : null;
  return useQuery({
    queryKey: cacheKey(decision?.id ?? '', taskIntent, tier),
    enabled: Boolean(decisionPayload),
    // A cache lookup is cheap and is automatically repeated when the decision
    // or diff changes. Retrying a deterministic 4xx four times only hammers the
    // API and leaves a stale panel looking like background work is progressing.
    retry: false,
    queryFn: async () => {
      if (!decisionPayload) return {} as CachedAssistAnswers;
      const results = await Promise.all(ASSIST_ACTIONS.map((action) => sourceClient.lookupReviewAssist({ action, decision: decisionPayload, taskIntent, tier }).then((response) => [action, response.answer] as const)));
      return Object.fromEntries(results.filter(([, answer]) => answer !== null)) as CachedAssistAnswers;
    },
  });
}

/**
 * Warming the two questions reviewers ask most — how risky is this, and what
 * is it — for the one decision they are actually reading.
 *
 * This is deliberately headless and mounted by the review view rather than by
 * the panel that displays the answers. The detail now lives in a popover that
 * is closed most of the time, and warming that only ran while the popover was
 * open would make every first click pay the cold start this exists to prevent.
 */
export function useReviewAssistPrefetch(decision: ReviewDecision | null, taskIntent: ReviewAssistTaskIntent, autoScore: AutoScoreResult | undefined, siblings: ReviewDecision[] = []): void {
  const queryClient = useQueryClient();
  // Subscribing to the cache read rather than peeking at it: the popover that
  // used to own this query is closed most of the time, so nothing else would
  // populate the cache and every dwell would re-ask a question the server has
  // already answered.
  const cached = useCachedReviewAssistAnswers(decision, taskIntent, siblings);
  const hasScore = Boolean(cached.data?.score_risk ?? autoScore?.answer);
  const hasExplanation = Boolean(cached.data?.explain);
  // The decision and task intent fully determine the request, so the payload
  // travels by ref and the effect keys off their identity instead of re-firing
  // on every parent render.
  const prefetchInput = useRef<{ decisionPayload: ReturnType<typeof reviewAssistDecisionPayload> | null; taskIntent: ReviewAssistTaskIntent }>({ decisionPayload: null, taskIntent });
  prefetchInput.current = { decisionPayload: decision ? reviewAssistDecisionPayload(decision, siblings) : null, taskIntent };
  const decisionId = decision?.id ?? '';
  const prefetchKey = `${decisionId}|${taskIntent?.title ?? ''}|${taskIntent?.description ?? ''}`;

  useEffect(() => {
    if (!decisionId || cached.isPending) return;
    const wanted: ReviewAssistAction[] = [];
    if (!hasScore) wanted.push('score_risk');
    if (!hasExplanation) wanted.push('explain');
    if (wanted.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const { decisionPayload: payload, taskIntent: intent } = prefetchInput.current;
      if (!payload) return;
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
  }, [prefetchKey, decisionId, hasScore, hasExplanation, cached.isPending, queryClient]);
}
