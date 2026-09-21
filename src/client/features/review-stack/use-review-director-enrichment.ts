import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReviewDirectorEntry } from '../../../shared/review-director.js';
import { reviewAssistDecisionPayload, type ReviewDecision } from '../../../shared/review-decisions.js';
import { sourceClient } from '../../data/source-client.js';
import { useAiProvider } from '../../hooks/ai-provider.js';
import type { CachedAssistAnswers, ReviewAssistTaskIntent } from '../diff-review/review-assist.js';

const ENRICHMENT_CONCURRENCY = 2;

export interface ReviewDirectorEnrichmentProgress {
  running: boolean;
  completed: number;
  total: number;
  failed: number;
  /** Scores returned by the same critical pass. The queue consumes them as
   * routing input instead of rendering them as decorative metadata. */
  riskScores: ReadonlyMap<string, string>;
  /** The exact answers counted as complete. The detail panel renders these
   * directly, so its content cannot lag behind the completion counter while a
   * separate cache lookup catches up. */
  answers: ReadonlyMap<string, CachedAssistAnswers>;
}

const IDLE: ReviewDirectorEnrichmentProgress = { running: false, completed: 0, total: 0, failed: 0, riskScores: new Map(), answers: new Map() };

/**
 * Completes the Review Director's critical analysis for diff sources the
 * server cannot reconstruct from the live working tree: pull requests, saved
 * reviews, branches, and commits. The endpoint's durable cache makes replaying
 * a source cheap, while the revision signature prevents duplicate requests in
 * one mounted review.
 */
export function useReviewDirectorEnrichment(input: {
  entries: readonly ReviewDirectorEntry[];
  decisions: ReviewDecision[];
  taskIntent: ReviewAssistTaskIntent;
  revision: string | undefined;
  enabled: boolean;
}): ReviewDirectorEnrichmentProgress {
  const { provider } = useAiProvider();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<ReviewDirectorEnrichmentProgress>(IDLE);
  const critical = useMemo(() => input.entries.filter((entry) => entry.critical), [input.entries]);
  const signature = `${input.revision ?? ''}|${provider}|${critical.map((entry) => entry.decision.id).join('|')}|${input.taskIntent?.title ?? ''}|${input.taskIntent?.description ?? ''}`;

  useEffect(() => {
    if (!input.enabled || !input.revision || critical.length === 0) {
      setProgress(IDLE);
      return undefined;
    }

    let cancelled = false;
    let cursor = 0;
    setProgress({ running: true, completed: 0, total: critical.length, failed: 0, riskScores: new Map(), answers: new Map() });

    const enrichNext = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const entry = critical[index];
        if (!entry || cancelled) return;

        let failed = false;
        let score: string | null = null;
        let prepared: CachedAssistAnswers | null = null;
        const payload = reviewAssistDecisionPayload(entry.decision, input.decisions);
        try {
          const response = await sourceClient.requestCriticalReviewAssist({ decision: payload, taskIntent: input.taskIntent, provider });
          const required = entry.enrichmentActions.filter((action) => action !== 'compare_task_intent' || input.taskIntent);
          if (!required.every((action) => Boolean(response.answers[action]?.trim()))) {
            throw new Error('Review Director returned an incomplete critical analysis.');
          }
          prepared = response.answers;
          score = prepared.score_risk ?? null;
          if (cancelled) return;
          void queryClient.invalidateQueries({ queryKey: ['review-assist-cache', entry.decision.id] });
        } catch {
          failed = true;
        }

        if (!cancelled) setProgress((current) => ({
          ...current,
          completed: current.completed + Number(!failed),
          failed: current.failed + Number(failed),
          running: current.completed + current.failed + 1 < current.total,
          riskScores: score ? new Map(current.riskScores).set(entry.decision.id, score) : current.riskScores,
          answers: prepared ? new Map(current.answers).set(entry.decision.id, prepared) : current.answers,
        }));
      }
    };

    void Promise.all(Array.from({ length: Math.min(ENRICHMENT_CONCURRENCY, critical.length) }, () => enrichNext()));
    return () => { cancelled = true; };
    // The signature fully describes the immutable work for this sweep. The
    // arrays themselves are recreated when verdicts land and must not restart
    // model work that is already in flight for the same source revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, input.enabled, queryClient]);

  return progress;
}
