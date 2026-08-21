import type { QueueItemExplanation, QueueSignal, QueueSignalKey, WorkItem } from '../shared/contracts.js';
import { dueDaysFromToday, dueState, type DueState } from '../shared/due-date.js';

/**
 * Deterministic, explainable ranking for the attention stack.
 *
 * Two rules drive the design:
 *   1. Every position change must be attributable to a named signal, so the
 *      proposal can say *why* a task moved instead of asserting a new order.
 *   2. Yesterday's order is the default. Ranking starts from the current order
 *      and only swaps neighbours whose score gap clears `STABILITY_MARGIN`.
 *      A full re-sort would reshuffle the stack every morning on noise; the
 *      threshold pass means near-ties never move at all.
 *
 * The pass is a bubble sort with a threshold. It terminates because every swap
 * strictly reduces the number of adjacent pairs whose gap exceeds the margin,
 * and no pair can exceed the margin in both directions.
 */

/** Minimum score advantage required to displace the task ahead of you. */
export const STABILITY_MARGIN = 3;

/** Tasks already in flight before other work gets demoted for workload pressure. */
export const WORK_IN_PROGRESS_LIMIT = 3;

/** Signals whose weight is tuned by accepted/rejected proposal history. */
export const LEARNABLE_SIGNALS: QueueSignalKey[] = ['aging', 'deadline', 'blocker', 'source_change'];

export interface QueueContext {
  /** Epoch millis used for aging and deadline math. Injected so ranking is testable. */
  now: number;
  /** Active (non-done, non-archived) child tasks per parent id. */
  openChildren: Map<string, number>;
  /** Queued or running agent runs per work item id. */
  activeRuns: Map<string, number>;
  /** Item ids whose most recent activity note is an unresolved blocker. */
  unresolvedBlockers: Set<string>;
  /**
   * Blocker item id → how many still-open tasks list it as a prerequisite.
   * This is the reverse of `WorkItem.blockedBy`, which the planner reads off the
   * item itself; only the outgoing direction needs a lookup table.
   */
  openDependents: Map<string, number>;
  /** Item id → short description of source movement since the last plan. */
  sourceChanges: Map<string, string>;
  /** Learned weight per signal key, from proposals Jeffrey accepted or rejected. */
  feedback: Map<QueueSignalKey, FeedbackWeight>;
  /** IANA timezone used to interpret calendar-date deadlines. */
  timeZone?: string;
}

export interface FeedbackWeight { weight: number; accepted: number; rejected: number; }

export interface QueuePlan {
  orderedItemIds: string[];
  explanations: QueueItemExplanation[];
  rationale: string;
}

export interface ProposalOutcome { status: 'accepted' | 'rejected'; explanations: QueueItemExplanation[]; }

function signal(key: QueueSignalKey, delta: number, detail: string): QueueSignal {
  return { key, delta, detail };
}

function untouchedDays(item: WorkItem, now: number): number {
  const touched = new Date(item.lastTouchedAt).getTime();
  if (!Number.isFinite(touched)) return 0;
  return Math.max(0, (now - touched) / 86_400_000);
}

export function scoreItem(item: WorkItem, context: QueueContext, workInProgress: number): QueueSignal[] {
  const signals: QueueSignal[] = [];

  if (item.status === 'in_progress') signals.push(signal('status', 20, 'it is the work already in progress'));
  else if (item.status === 'ready') signals.push(signal('status', 4, 'it is ready to start'));
  else if (item.status === 'blocked') signals.push(signal('status', -8, 'it is blocked'));

  if (item.agentOutcome === 'needs_attention') signals.push(signal('agent_outcome', 16, 'an agent run needs attention'));
  else if (item.agentOutcome === 'follow_ups') signals.push(signal('agent_outcome', 10, 'agent follow-ups are waiting for review'));
  else if (item.agentOutcome === 'finished') signals.push(signal('agent_outcome', -5, 'the last agent run finished cleanly'));

  if (item.assignees.includes('jeffrey')) signals.push(signal('ownership', 2, 'it is assigned to you'));

  const days = Math.floor(untouchedDays(item, context.now));
  // Aging starts counting after one day so the stack is not tied at zero, and is
  // capped so stale work never outranks something actively urgent.
  if (days >= 1) signals.push(signal('aging', Math.min(8, days), `${days} day${days === 1 ? '' : 's'} without activity`));

  if (item.dueDate) {
    const state: DueState = dueState(item.dueDate, context.now, context.timeZone);
    const dueInDays = dueDaysFromToday(item.dueDate, context.now, context.timeZone);
    if (state === 'overdue') signals.push(signal('deadline', 10, 'the due date has already passed'));
    else if (dueInDays <= 1) signals.push(signal('deadline', 8, state === 'due_today' ? 'it is due today' : 'it is due tomorrow'));
    else if (dueInDays <= 3) signals.push(signal('deadline', 5, 'it is due within three days'));
  }

  const openChildren = context.openChildren.get(item.id) ?? 0;
  if (openChildren > 0) signals.push(signal('blocker', -6, `it is waiting on ${openChildren} open subtask${openChildren === 1 ? '' : 's'}`));
  // A task with open prerequisites cannot be dispatched at all — POST /execute
  // and POST /runs both reject it with 409 — so it sinks harder than a task that
  // is merely waiting on subtasks, which a human can still pick up and progress.
  const openDependencies = (item.blockedBy ?? []).filter((dependency) => dependency.isOpen);
  if (openDependencies.length > 0) {
    const titles = openDependencies.slice(0, 3).map((dependency) => dependency.title).join(', ');
    const overflow = openDependencies.length > 3 ? ` and ${openDependencies.length - 3} more` : '';
    signals.push(signal(
      'blocker',
      -12,
      `it is blocked by ${openDependencies.length} open prerequisite${openDependencies.length === 1 ? '' : 's'}: ${titles}${overflow}`,
    ));
  }
  if (context.unresolvedBlockers.has(item.id)) signals.push(signal('blocker', -4, 'its most recent note records an unresolved blocker'));

  // The mirror image: work on the critical path is promoted, because finishing it
  // is what opens the gate on everything queued behind it. Capped so a single hub
  // task with many dependents cannot dominate the whole stack.
  const dependents = context.openDependents.get(item.id) ?? 0;
  if (dependents > 0 && openDependencies.length === 0) {
    signals.push(signal('blocker', Math.min(9, 3 * dependents), `finishing it unblocks ${dependents} task${dependents === 1 ? '' : 's'}`));
  }

  const change = context.sourceChanges.get(item.id);
  if (change) signals.push(signal('source_change', 6, change));

  const running = context.activeRuns.get(item.id) ?? 0;
  if (running > 0) signals.push(signal('workload', -6, 'an agent is already working it'));
  else if (item.status !== 'in_progress' && workInProgress >= WORK_IN_PROGRESS_LIMIT) {
    signals.push(signal('workload', -3, `${workInProgress} tasks are already in progress`));
  }

  return applyFeedback(signals, context.feedback);
}

/**
 * Re-weights the signals Jeffrey has implicitly voted on. The adjustment is
 * reported as its own signal so the net effect stays visible instead of
 * silently inflating another factor.
 */
function applyFeedback(signals: QueueSignal[], feedback: Map<QueueSignalKey, FeedbackWeight>): QueueSignal[] {
  let adjustment = 0;
  const reasons: string[] = [];
  for (const entry of signals) {
    const learned = LEARNABLE_SIGNALS.includes(entry.key) ? feedback.get(entry.key) : undefined;
    if (!learned || learned.weight === 1) continue;
    adjustment += entry.delta * (learned.weight - 1);
    reasons.push(`${entry.key.replace('_', ' ')} counts ${learned.weight.toFixed(2)}× after ${learned.accepted} accepted and ${learned.rejected} rejected proposals`);
  }
  if (!reasons.length) return signals;
  return [...signals, signal('feedback', Math.round(adjustment * 100) / 100, [...new Set(reasons)].join('; '))];
}

export function stabilize(currentOrder: string[], scores: Map<string, number>, margin = STABILITY_MARGIN): string[] {
  const order = [...currentOrder];
  const limit = order.length * order.length + 1;
  for (let pass = 0; pass < limit; pass += 1) {
    let swapped = false;
    for (let index = 0; index < order.length - 1; index += 1) {
      const ahead = scores.get(order[index]) ?? 0;
      const behind = scores.get(order[index + 1]) ?? 0;
      if (behind - ahead > margin) {
        [order[index], order[index + 1]] = [order[index + 1], order[index]];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return order;
}

function dominantSignal(signals: QueueSignal[], promoted: boolean): QueueSignal | null {
  const relevant = signals.filter((entry) => (promoted ? entry.delta > 0 : entry.delta < 0));
  const pool = relevant.length ? relevant : signals;
  return pool.reduce<QueueSignal | null>((best, entry) => (!best || Math.abs(entry.delta) > Math.abs(best.delta) ? entry : best), null);
}

export function planQueue(items: WorkItem[], context: QueueContext): QueuePlan {
  const workInProgress = items.filter((item) => item.status === 'in_progress').length;
  const signalsById = new Map(items.map((item) => [item.id, scoreItem(item, context, workInProgress)]));
  const scores = new Map(items.map((item) => [
    item.id,
    (signalsById.get(item.id) ?? []).reduce((total, entry) => total + entry.delta, 0),
  ]));
  const currentOrder = items.map((item) => item.id);
  const orderedItemIds = stabilize(currentOrder, scores);

  const explanations: QueueItemExplanation[] = items.map((item) => ({
    itemId: item.id,
    title: item.title,
    score: Math.round((scores.get(item.id) ?? 0) * 100) / 100,
    signals: signalsById.get(item.id) ?? [],
    previousPosition: currentOrder.indexOf(item.id) + 1,
    proposedPosition: orderedItemIds.indexOf(item.id) + 1,
  }));

  const moved = explanations
    .filter((entry) => entry.previousPosition !== entry.proposedPosition)
    .sort((left, right) => Math.abs(right.previousPosition - right.proposedPosition) - Math.abs(left.previousPosition - left.proposedPosition));

  const rationale = moved.length
    ? moved.slice(0, 6).map((entry) => {
      const promoted = entry.proposedPosition < entry.previousPosition;
      const reason = dominantSignal(entry.signals, promoted);
      const direction = promoted ? 'moved up' : 'moved down';
      return reason
        ? `${entry.title}: ${direction} because ${reason.detail}.`
        : `${entry.title}: ${direction} to keep the stack consistent with the tasks around it.`;
    }).join(' ')
    : 'No meaningful new task context justified changing yesterday’s order.';

  return { orderedItemIds, explanations, rationale };
}

/**
 * Turns resolved proposals into per-signal weights. Accepting a proposal is a
 * vote for whatever signal drove its biggest moves; rejecting one is a vote
 * against. Weights are clamped so a run of agreements can never let one factor
 * dominate the stack.
 */
export function learnFeedbackWeights(history: ProposalOutcome[]): Map<QueueSignalKey, FeedbackWeight> {
  const tally = new Map<QueueSignalKey, { accepted: number; rejected: number }>();
  for (const outcome of history) {
    for (const entry of outcome.explanations) {
      if (entry.previousPosition === entry.proposedPosition) continue;
      const reason = dominantSignal(entry.signals ?? [], entry.proposedPosition < entry.previousPosition);
      if (!reason || !LEARNABLE_SIGNALS.includes(reason.key)) continue;
      const current = tally.get(reason.key) ?? { accepted: 0, rejected: 0 };
      if (outcome.status === 'accepted') current.accepted += 1; else current.rejected += 1;
      tally.set(reason.key, current);
    }
  }
  const weights = new Map<QueueSignalKey, FeedbackWeight>();
  for (const [key, counts] of tally) {
    const weight = Math.min(1.4, Math.max(0.6, 1 + 0.1 * (counts.accepted - counts.rejected)));
    if (weight !== 1) weights.set(key, { weight: Math.round(weight * 100) / 100, accepted: counts.accepted, rejected: counts.rejected });
  }
  return weights;
}
