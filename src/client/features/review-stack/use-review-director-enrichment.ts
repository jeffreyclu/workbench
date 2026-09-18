import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReviewDirectorEntry } from '../../../shared/review-director.js';
import { reviewAssistDecisionPayload, type ReviewDecision } from '../../../shared/review-decisions.js';
import { sourceClient } from '../../data/source-client.js';
import { useAiProvider } from '../../hooks/ai-provider.js';
import type { ReviewAssistTaskIntent } from '../diff-review/review-assist.js';

const ENRICHMENT_CONCURRENCY = 2;

export interface ReviewDirectorEnrichmentProgress {
  running: boolean;
  completed: number;
  total: number;
  failed: number;
}

const IDLE: ReviewDirectorEnrichmentProgress = { running: false, completed: 0, total: 0, failed: 0 };

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
    setProgress({ running: true, completed: 0, total: critical.length, failed: 0 });

    const enrichNext = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const entry = critical[index];
        if (!entry || cancelled) return;

        let failed = false;
        const payload = reviewAssistDecisionPayload(entry.decision, input.decisions);
        try {
          await sourceClient.requestCriticalReviewAssist({ decision: payload, taskIntent: input.taskIntent, provider });
          if (cancelled) return;
          await queryClient.invalidateQueries({ queryKey: ['review-assist-cache', entry.decision.id] });
        } catch {
          failed = true;
        }

        if (!cancelled) setProgress((current) => ({
          ...current,
          completed: current.completed + 1,
          failed: current.failed + Number(failed),
          running: current.completed + 1 < current.total,
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
