import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /** The changes whose delegated turn is claimed but unanswered — queued or in
   * flight. Per-decision because a running total cannot tell a reviewer whether
   * *this* change is still owed an answer or was never delegated at all. */
  pending: ReadonlySet<string>;
}

const NO_PENDING: ReadonlySet<string> = new Set();

const IDLE: DelegatedReviewProgress = { running: false, completed: 0, total: 0, failed: 0, skipped: 0, pending: NO_PENDING };

/**
 * One revision's delegated turns, and the workers spending them.
 *
 * The sweep deliberately outlives the render that started it. Its own answers
 * rewrite the target list — a delegated verdict removes the change it settled,
 * and a remembered answer can re-tier its neighbours — so an effect that tore
 * down its workers whenever that list moved would cancel the sweep with the
 * first answer it bought, leaving every remaining change claimed and unasked.
 * Later targets are pushed into the running sweep instead. Only a new revision
 * or the surface going away cancels one.
 */
interface DelegationSweep {
  revision: string;
  cancelled: boolean;
  queue: DelegationTarget[];
  workers: number;
}

const targetKey = (target: DelegationTarget): string => `${target.decisionId}:${target.tier}`;

/** Claims are counted rather than flagged: a change can be re-tiered while its
 * first delegated turn is still in flight, and the answer to that first turn
 * must not clear the marker the second one is still owed. */
function claimPending(counts: Map<string, number>, decisionId: string): void {
  counts.set(decisionId, (counts.get(decisionId) ?? 0) + 1);
}

function settlePending(counts: Map<string, number>, decisionId: string): void {
  const left = (counts.get(decisionId) ?? 0) - 1;
  if (left > 0) counts.set(decisionId, left);
  else counts.delete(decisionId);
}

const pendingSnapshot = (counts: Map<string, number>): ReadonlySet<string> => new Set(counts.keys());

/**
 * Spending the delegated tiers without waiting for anyone to click.
 *
 * Routing has always said which changes were not Jeffrey's to open first, but
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
  /** The files this block changes, read whole, for surfaces that can read
   * them. Without it a delegated turn sees a fragment and says so: the first
   * sweeps came back "not confident — I would need the surrounding code" on
   * seven answers in ten, and every one of those went straight back into the
   * reviewer's queue. Optional because a GitHub pull request has no files to
   * read here; that surface still gets the hunks-only answer. */
  loadFileContext?: (target: DelegationTarget) => Promise<Array<{ filePath: string; content: string }>>;
}): DelegatedReviewProgress {
  const { targets, revision, enabled } = input;
  const [progress, setProgress] = useState<DelegatedReviewProgress>(IDLE);
  const attempted = useRef<{ revision: string | undefined; keys: Set<string> }>({ revision: undefined, keys: new Set() });
  const sweep = useRef<DelegationSweep | null>(null);
  // Which changes are still owed a delegated answer, counted per decision so
  // the surfaces can mark the individual change rather than the whole sweep.
  const pendingCounts = useRef(new Map<string, number>());
  // Bumped when claims come back after the effect that could have taken them
  // has already run, so the sweep resumes instead of stopping one target short.
  const [resumeTick, setResumeTick] = useState(0);

  // The async body reads the newest inputs rather than the ones captured when
  // the sweep started: a sibling set or an intent that changed mid-sweep should
  // affect the turns still to come, not restart the ones already paid for.
  const latest = useRef(input);
  latest.current = input;

  const signature = useMemo(() => targets.map((target) => `${target.decisionId}:${target.tier}`).join('|'), [targets]);

  /**
   * Hands back everything a cancelled sweep claimed and never spent.
   *
   * Claims are taken up front so a re-render cannot buy the same answer twice.
   * That is right while a sweep is alive and fatal once one is cancelled: the
   * input goes false for a single render — a refetch that empties the diff, a
   * revision read back as undefined between two queries — and the sweep dies
   * holding a claim on every change it had not reached yet. The effect that
   * runs when the input returns finds all of them already attempted, queues
   * nothing, and the revision is left with the handful of answers the first
   * burst bought and a status line still saying it is working. Releasing the
   * unspent claims is what lets that effect pick the sweep back up.
   */
  const release = useCallback((run: DelegationSweep) => {
    const unspent = run.queue.splice(0);
    // A sweep whose revision has already been replaced holds claims against a
    // key set nobody reads: dropping its queue is the whole of the work.
    if (attempted.current.revision !== run.revision) return;
    for (const target of unspent) {
      attempted.current.keys.delete(targetKey(target));
      settlePending(pendingCounts.current, target.decisionId);
    }
    // A successor sweep for the same revision owns the progress line now, and
    // must not be reported finished by its predecessor's last worker.
    if (sweep.current && sweep.current !== run) {
      // Those claims are free again, but the successor computed its own list
      // before they were: nothing else would go back for them.
      if (unspent.length > 0) {
        setProgress((current) => ({ ...current, pending: pendingSnapshot(pendingCounts.current) }));
        setResumeTick((tick) => tick + 1);
      }
      return;
    }
    setProgress((current) => ({ ...current, running: false, pending: pendingSnapshot(pendingCounts.current), total: Math.max(current.completed, current.total - unspent.length) }));
  }, []);

  const spend = useCallback(async (run: DelegationSweep): Promise<void> => {
    // Put back rather than drop: the change is owed either way, and a claim
    // that outlives the sweep holding it is one nothing ever asks about again.
    const abandon = (target: DelegationTarget) => { run.queue.unshift(target); };
    for (;;) {
      const target = run.cancelled ? undefined : run.queue.shift();
      if (!target) break;
      try {
        // A file that cannot be read is not a failed turn: the answer is still
        // worth buying from the hunks alone, exactly as it was before context
        // existed.
        const fileContext = await (latest.current.loadFileContext?.(target).catch(() => []) ?? Promise.resolve([]));
        if (run.cancelled) { abandon(target); break; }
        const { answer } = await sourceClient.requestReviewAssist({
          action: 'explain',
          decision: reviewAssistDecisionPayload(target.decision, latest.current.siblings, fileContext),
          taskIntent: latest.current.taskIntent,
          tier: target.tier,
        });
        // The answer is bought and server-side cached, but nothing here applied
        // it. Owing the change again costs a cache hit, not another turn.
        if (run.cancelled) { abandon(target); break; }
        if (answer) latest.current.onAnswer?.(target.decisionId, answer);
        if (delegationOutcome(target.tier, answer).autoReview) latest.current.onAutoReview?.(target);
        settlePending(pendingCounts.current, target.decisionId);
        setProgress((current) => ({ ...current, completed: current.completed + 1, pending: pendingSnapshot(pendingCounts.current) }));
      } catch {
        if (run.cancelled) { abandon(target); break; }
        // A failed turn leaves the change owed. It is not retried within the
        // revision: the reviewer can still ask about it directly, and a
        // retry loop against a broken endpoint spends without informing.
        settlePending(pendingCounts.current, target.decisionId);
        setProgress((current) => ({ ...current, completed: current.completed + 1, failed: current.failed + 1, pending: pendingSnapshot(pendingCounts.current) }));
      }
    }
    run.workers -= 1;
    if (run.workers > 0) return;
    // The last worker out reports the sweep done, or — if it was cancelled —
    // gives back what it and its peers never got to.
    if (run.cancelled) release(run);
    else setProgress((current) => ({ ...current, running: false }));
  }, [release]);

  // Cancelled on the way out, so a sweep cannot keep spending against a surface
  // nobody is looking at.
  useEffect(() => () => {
    if (sweep.current) sweep.current.cancelled = true;
    sweep.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !revision) {
      if (sweep.current) {
        sweep.current.cancelled = true;
        release(sweep.current);
      }
      sweep.current = null;
      return;
    }
    if (sweep.current && sweep.current.revision !== revision) {
      sweep.current.cancelled = true;
      release(sweep.current);
      sweep.current = null;
    }
    if (attempted.current.revision !== revision) {
      attempted.current = { revision, keys: new Set() };
      pendingCounts.current.clear();
      setProgress(IDLE);
    }
    const keys = attempted.current.keys;
    const room = DELEGATION_LIMIT - keys.size;
    const outstanding = latest.current.targets.filter((target) => !keys.has(targetKey(target)));
    if (outstanding.length === 0) return;
    const pending = room > 0 ? outstanding.slice(0, room) : [];
    const skipped = outstanding.length - pending.length;
    if (skipped > 0) setProgress((current) => ({ ...current, skipped }));
    if (pending.length === 0) return;
    // Claimed up front, not as each turn starts: the effect can re-run while
    // this sweep is in flight, and it must find nothing left to claim.
    for (const target of pending) {
      keys.add(targetKey(target));
      claimPending(pendingCounts.current, target.decisionId);
    }
    const run = sweep.current ?? { revision, cancelled: false, queue: [], workers: 0 };
    sweep.current = run;
    run.queue.push(...pending);
    setProgress((current) => ({ ...current, running: true, total: current.total + pending.length, pending: pendingSnapshot(pendingCounts.current) }));
    const starting = Math.min(DELEGATION_CONCURRENCY - run.workers, run.queue.length);
    for (let index = 0; index < starting; index += 1) {
      run.workers += 1;
      void spend(run);
    }
  }, [enabled, release, resumeTick, revision, signature, spend]);

  return progress;
}
