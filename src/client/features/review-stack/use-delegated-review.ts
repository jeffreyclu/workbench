import { useEffect, useMemo, useRef, useState } from 'react';
import { sourceClient } from '../../data/source-client.js';
import { reviewAssistDecisionPayload, type ReviewDecision } from '../../../shared/review-decisions.js';
import type { ReviewAssistTaskIntent } from '../diff-review/review-assist.js';
import { delegationOutcome, type DelegationTarget } from './review-delegation.js';

/** Two at a time. The same warm worker pool serves the reviewer's own clicks,
 * and a sweep that saturates it would make every deliberate question queue
 * behind work nobody asked for. */
const DELEGATION_CONCURRENCY = 2;

/** A ceiling on what one revision may spend unprompted. Past it the surface
 * says how many changes it left alone rather than implying it covered them. */
const DELEGATION_LIMIT = 60;

export interface DelegatedReviewProgress {
  running: boolean;
  completed: number;
  total: number;
  /** Turns that failed. Counted separately so a dead endpoint does not read as
   * a diff full of confidently settled changes. */
  failed: number;
  /** Delegable changes past the per-revision ceiling. */
  skipped: number;
}

const IDLE: DelegatedReviewProgress = { running: false, completed: 0, total: 0, failed: 0, skipped: 0 };

/**
 * Spending the delegated tiers without waiting for anyone to click.
 *
 * Routing has always said which changes were not Jeffrey's to read first, but
 * saying it was all it did: a T1 block was labelled delegated and then sat
 * there, settled in the queue's arithmetic and unexamined in fact. This is the
 * turn that label was promising. Answers land in the same server-side assist
 * cache the panel reads, so a change opened afterwards shows the delegated
 * answer immediately and costs nothing twice.
 *
 * Each change is attempted at most once per revision, and the attempt is
 * recorded before the request goes out — a re-render mid-flight must not buy
 * the same answer again. Answers are dropped when the revision moves, because
 * they are statements about specific code.
 */
export function useDelegatedReview(input: {
  targets: readonly DelegationTarget[];
  /** The whole review, for the coverage-evidence pack. Must match what the
   * cache-only read passes or the answer written here is never found again. */
  siblings: ReviewDecision[];
  taskIntent: ReviewAssistTaskIntent;
  revision: string | undefined;
  enabled: boolean;
  onAnswer?: (decisionId: string, answer: string) => void;
  onAutoReview?: (target: DelegationTarget) => void;
}): DelegatedReviewProgress {
  const { targets, revision, enabled } = input;
  const [progress, setProgress] = useState<DelegatedReviewProgress>(IDLE);
  const attempted = useRef<{ revision: string | undefined; keys: Set<string> }>({ revision: undefined, keys: new Set() });

  // The async body reads the newest inputs rather than the ones captured when
  // the sweep started: a sibling set or an intent that changed mid-sweep should
  // affect the turns still to come, not restart the ones already paid for.
  const latest = useRef(input);
  latest.current = input;

  const signature = useMemo(() => targets.map((target) => `${target.decisionId}:${target.tier}`).join('|'), [targets]);

  useEffect(() => {
    if (!enabled || !revision) return undefined;
    if (attempted.current.revision !== revision) {
      attempted.current = { revision, keys: new Set() };
      setProgress(IDLE);
    }
    const keys = attempted.current.keys;
    const room = DELEGATION_LIMIT - keys.size;
    const outstanding = latest.current.targets.filter((target) => !keys.has(`${target.decisionId}:${target.tier}`));
    if (outstanding.length === 0) return undefined;
    const pending = room > 0 ? outstanding.slice(0, room) : [];
    const skipped = outstanding.length - pending.length;
    if (skipped > 0) setProgress((current) => ({ ...current, skipped }));
    if (pending.length === 0) return undefined;
    // Claimed up front, not as each turn starts: the effect can re-run while
    // this sweep is in flight, and it must find nothing left to claim.
    for (const target of pending) keys.add(`${target.decisionId}:${target.tier}`);

    let cancelled = false;
    setProgress((current) => ({ ...current, running: true, total: current.total + pending.length }));
    const queue = pending.slice();
    const worker = async (): Promise<void> => {
      for (;;) {
        const target = queue.shift();
        if (!target || cancelled) return;
        try {
          const { answer } = await sourceClient.requestReviewAssist({
            action: 'explain',
            decision: reviewAssistDecisionPayload(target.decision, latest.current.siblings),
            taskIntent: latest.current.taskIntent,
            tier: target.tier,
          });
          if (cancelled) return;
          if (answer) latest.current.onAnswer?.(target.decisionId, answer);
          if (delegationOutcome(target.tier, answer).autoReview) latest.current.onAutoReview?.(target);
          setProgress((current) => ({ ...current, completed: current.completed + 1 }));
        } catch {
          if (cancelled) return;
          // A failed turn leaves the change owed. It is not retried within the
          // revision: the reviewer can still ask about it directly, and a
          // retry loop against a broken endpoint spends without informing.
          setProgress((current) => ({ ...current, completed: current.completed + 1, failed: current.failed + 1 }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(DELEGATION_CONCURRENCY, queue.length) }, () => worker()))
      .then(() => { if (!cancelled) setProgress((current) => ({ ...current, running: false })); });
    return () => { cancelled = true; };
  }, [enabled, revision, signature]);

  return progress;
}
