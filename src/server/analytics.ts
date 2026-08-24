import type { WorkbenchDatabase } from './database.js';

/**
 * Cycle-time / time-in-status analysis over the `activities` log.
 *
 * The naive version of this query — `LAG` over every activity row per
 * `work_item_id` — measures time between arbitrary log events (a rename next
 * to a comment next to a status change), not time spent in a status. That was
 * flagged in review and rejected. This module only follows the events that
 * actually carry a status transition:
 *
 *   - `kind = 'edited'` rows whose body contains a "Status: X → Y" segment
 *     (written by `summarizeWorkItemChanges` in activity-log.ts, one
 *     ` · `-joined segment among possibly several other edits, so the segment
 *     has to be sliced out rather than read as the whole body).
 *   - `kind = 'completed'` rows, which move a task to `done` without writing
 *     a "Status: X → Y" line (`repository.ts` `archive()`).
 *
 * `archived` without completing is deliberately excluded: it does not change
 * `status` in the schema. A `restored` row is included only when its preceding
 * status event was `completed`. That is the one case where `restore()`
 * deterministically changes `done → ready`; restoring an incomplete archive
 * leaves the status unchanged and is excluded.
 *
 * Each transition's duration is attributed to the status the item was *in*
 * beforehand (`from_status` on an edit, or the previous transition's
 * `to_status` for a `completed` row), for the time between that status
 * starting and this transition firing. The still-open final status of every
 * work item — the interval from its last transition to now — is excluded:
 * it is right-censored (still running) and would skew percentiles upward the
 * longer any open item happens to sit.
 */

export interface CycleTimeStatusStats {
  status: string;
  count: number;
  p50Hours: number;
  p95Hours: number;
  p99Hours: number;
}

export interface StatusInterval {
  workItemId: string;
  status: string;
  enteredAt: string;
  leftAt: string;
  durationHours: number;
}

interface StatusIntervalRow {
  work_item_id: string;
  status: string;
  entered_at: string;
  left_at: string;
  duration_hours: number;
}

/**
 * One row per closed status interval. `status` is the status active for the
 * interval `[entered_at, left_at)`; `duration_hours` is `left_at - entered_at`.
 * Uses `LAG` to pair each status-transition event with the previous one on
 * the same work item (or the item's `created_at` for the first transition).
 */
const STATUS_INTERVALS_SQL = `
  WITH status_edits AS (
    SELECT event_order, work_item_id, created_at, 'edited' AS kind,
      trim(substr(seg, 9, instr(seg, ' → ') - 9)) AS from_status,
      trim(substr(seg, instr(seg, ' → ') + 3)) AS to_status
    FROM (
      SELECT rowid AS event_order, work_item_id, created_at,
        CASE WHEN body LIKE '%Status: %→%' THEN
          substr(body, instr(body, 'Status: '),
            CASE WHEN instr(substr(body, instr(body, 'Status: ')), ' · ') > 0
              THEN instr(substr(body, instr(body, 'Status: ')), ' · ') - 1
              ELSE length(substr(body, instr(body, 'Status: '))) - 1
            END)
        ELSE NULL END AS seg
      FROM activities
      WHERE kind = 'edited'
    )
    WHERE seg IS NOT NULL
  ),
  completion_events AS (
    SELECT rowid AS event_order, work_item_id, created_at, 'completed' AS kind,
      NULL AS from_status, 'done' AS to_status
    FROM activities
    WHERE kind = 'completed'
  ),
  restore_events AS (
    SELECT rowid AS event_order, work_item_id, created_at, 'restored' AS kind,
      NULL AS from_status, NULL AS to_status
    FROM activities
    WHERE kind = 'restored'
  ),
  candidate_events AS (
    SELECT * FROM status_edits
    UNION ALL
    SELECT * FROM completion_events
  ),
  candidate_ordered AS (
    SELECT ce.*,
      LAG(ce.kind) OVER (PARTITION BY ce.work_item_id ORDER BY ce.created_at, ce.event_order) AS previous_kind
    FROM (
      SELECT * FROM candidate_events
      UNION ALL
      SELECT * FROM restore_events
    ) ce
  ),
  status_events AS (
    SELECT event_order, work_item_id, created_at, from_status, to_status
    FROM candidate_ordered
    WHERE kind IN ('edited', 'completed')
    UNION ALL
    SELECT event_order, work_item_id, created_at, 'done' AS from_status, 'ready' AS to_status
    FROM candidate_ordered
    WHERE kind = 'restored' AND previous_kind = 'completed'
  ),
  ordered AS (
    SELECT
      se.event_order,
      se.work_item_id,
      se.created_at,
      se.from_status,
      se.to_status,
      LAG(se.created_at) OVER (PARTITION BY se.work_item_id ORDER BY se.created_at, se.event_order) AS prev_created_at,
      LAG(se.to_status) OVER (PARTITION BY se.work_item_id ORDER BY se.created_at, se.event_order) AS prev_to_status,
      w.created_at AS item_created_at
    FROM status_events se
    JOIN work_items w ON w.id = se.work_item_id
  )
  SELECT
    event_order,
    work_item_id,
    COALESCE(from_status, prev_to_status, 'backlog') AS status,
    COALESCE(prev_created_at, item_created_at) AS entered_at,
    created_at AS left_at,
    (julianday(created_at) - julianday(COALESCE(prev_created_at, item_created_at))) * 24.0 AS duration_hours
  FROM ordered
  WHERE julianday(created_at) > julianday(COALESCE(prev_created_at, item_created_at))
  ORDER BY work_item_id, created_at, event_order
`;

/** Every closed status interval, oldest first per work item. For spot-checking a specific timeline, filter the result by `workItemId`. */
export function statusIntervals(database: WorkbenchDatabase): StatusInterval[] {
  const rows = database.prepare(STATUS_INTERVALS_SQL).all() as unknown as StatusIntervalRow[];
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    status: row.status,
    enteredAt: row.entered_at,
    leftAt: row.left_at,
    durationHours: row.duration_hours,
  }));
}

/** Nearest-rank percentile over a pre-sorted ascending array. Returns 0 for an empty input. */
function percentile(sortedAscending: number[], p: number): number {
  if (!sortedAscending.length) return 0;
  const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil(p * sortedAscending.length) - 1));
  return sortedAscending[index];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Cycle-time percentiles (p50/p95/p99), grouped by status, over every closed status interval in the log. */
export function cycleTimeByStatus(database: WorkbenchDatabase): CycleTimeStatusStats[] {
  const durationsByStatus = new Map<string, number[]>();
  for (const interval of statusIntervals(database)) {
    const durations = durationsByStatus.get(interval.status) ?? [];
    durations.push(interval.durationHours);
    durationsByStatus.set(interval.status, durations);
  }

  const stats: CycleTimeStatusStats[] = [];
  for (const [status, durations] of durationsByStatus) {
    const sorted = [...durations].sort((a, b) => a - b);
    stats.push({
      status,
      count: sorted.length,
      p50Hours: round2(percentile(sorted, 0.5)),
      p95Hours: round2(percentile(sorted, 0.95)),
      p99Hours: round2(percentile(sorted, 0.99)),
    });
  }
  return stats.sort((a, b) => b.count - a.count);
}

/** A supported task cohort. `creation_week` uses the Monday on which the UTC week begins. */
export type CohortDimension = 'project' | 'source' | 'creation_week';

export interface CohortStatusCount {
  status: string;
  count: number;
  percentage: number;
}

export interface TimeToCompletionBucket {
  label: '< 1 day' | '1–3 days' | '3–7 days' | '7–14 days' | '14+ days';
  count: number;
}

export interface CohortStatistics {
  dimension: CohortDimension;
  cohort: string;
  workItemCount: number;
  completedCount: number;
  completionRate: number;
  meanCycleTimeHours: number | null;
  medianCycleTimeHours: number | null;
  statusDistribution: CohortStatusCount[];
  timeToCompletionDistribution: TimeToCompletionBucket[];
}

interface CohortWorkItemRow {
  id: string;
  project_name: string | null;
  source: string;
  created_at: string;
  completed_at: string | null;
  status: string;
  completion_activity_at: string | null;
}

/**
 * Task outcomes with lifecycle evidence joined in. `completed_at` remains the
 * source of truth: an item can have an older `completed` activity and later be
 * restored, which deliberately makes it incomplete again. The activity join
 * establishes that the cohort report is based on the task lifecycle ledger
 * while keeping current task metadata (project/source/status) authoritative.
 */
const COHORT_WORK_ITEMS_SQL = `
  WITH completion_activities AS (
    SELECT work_item_id, MAX(created_at) AS completion_activity_at
    FROM activities
    WHERE kind = 'completed'
    GROUP BY work_item_id
  )
  SELECT w.id, w.project_name, w.source, w.created_at, w.completed_at, w.status,
    completion_activities.completion_activity_at
  FROM work_items w
  LEFT JOIN completion_activities ON completion_activities.work_item_id = w.id
  WHERE w.deleted_at IS NULL
  ORDER BY w.created_at, w.id
`;

const TIME_TO_COMPLETION_BUCKETS: Array<{ label: TimeToCompletionBucket['label']; upperHours: number }> = [
  { label: '< 1 day', upperHours: 24 },
  { label: '1–3 days', upperHours: 72 },
  { label: '3–7 days', upperHours: 168 },
  { label: '7–14 days', upperHours: 336 },
  { label: '14+ days', upperHours: Number.POSITIVE_INFINITY },
];

function cohortName(row: CohortWorkItemRow, dimension: CohortDimension): string {
  if (dimension === 'project') return row.project_name ?? 'Unassigned project';
  if (dimension === 'source') return row.source;
  // ISO strings sort chronologically, and SQLite's weekday modifier gives the
  // following Sunday; subtracting six days produces the UTC Monday.
  const createdAt = new Date(row.created_at);
  const weekday = (createdAt.getUTCDay() + 6) % 7;
  createdAt.setUTCDate(createdAt.getUTCDate() - weekday);
  return createdAt.toISOString().slice(0, 10);
}

/**
 * Compares aggregate task outcomes across one cohort dimension. No actor data
 * is read or returned: `activities.actor` only identifies human/system events,
 * not people, and is intentionally outside this analysis.
 */
export function taskCohortStatistics(database: WorkbenchDatabase, dimension: CohortDimension): CohortStatistics[] {
  const rows = database.prepare(COHORT_WORK_ITEMS_SQL).all() as unknown as CohortWorkItemRow[];
  const cohorts = new Map<string, CohortWorkItemRow[]>();
  for (const row of rows) {
    const name = cohortName(row, dimension);
    const items = cohorts.get(name) ?? [];
    items.push(row);
    cohorts.set(name, items);
  }

  return [...cohorts.entries()].map(([cohort, items]) => {
    const completedItems = items.filter((item) => item.completed_at !== null);
    const completedDurations = completedItems.flatMap((item) => {
      if (!item.completed_at) return [];
      const durationHours = (new Date(item.completed_at).getTime() - new Date(item.created_at).getTime()) / 3_600_000;
      return Number.isFinite(durationHours) && durationHours >= 0 ? [durationHours] : [];
    });
    const sortedDurations = [...completedDurations].sort((a, b) => a - b);
    const statusCounts = new Map<string, number>();
    for (const item of items) statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
    const distribution = TIME_TO_COMPLETION_BUCKETS.map(({ label, upperHours }, index) => ({
      label,
      count: completedDurations.filter((duration) => duration >= (index === 0 ? 0 : TIME_TO_COMPLETION_BUCKETS[index - 1].upperHours) && duration < upperHours).length,
    }));

    return {
      dimension,
      cohort,
      workItemCount: items.length,
      completedCount: completedItems.length,
      completionRate: round2(completedItems.length / items.length),
      meanCycleTimeHours: completedDurations.length
        ? round2(completedDurations.reduce((total, duration) => total + duration, 0) / completedDurations.length)
        : null,
      medianCycleTimeHours: completedDurations.length ? round2(percentile(sortedDurations, 0.5)) : null,
      statusDistribution: [...statusCounts.entries()]
        .map(([status, count]) => ({ status, count, percentage: round2(count / items.length) }))
        .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
      timeToCompletionDistribution: distribution,
    } satisfies CohortStatistics;
  }).sort((a, b) => b.workItemCount - a.workItemCount || a.cohort.localeCompare(b.cohort));
}

/**
 * N-gram sequence analysis over `activities.kind`.
 *
 * Each work item's activities are read in chronological order and treated as
 * one sequence of `kind` tokens (`'queued', 'progress', 'blocker', ...`).
 * Sequences from different work items are never mixed — an n-gram never spans
 * two items, since that pairing would be an artifact of row order, not a
 * process pattern.
 *
 * Two questions are answered:
 *   - `ngramFrequencies` — which bigrams/trigrams occur most often, anywhere
 *     in the log.
 *   - `ngramsPrecedingKind` — of the n-grams that occur, which ones are most
 *     often immediately followed by a specific event (`archived` for "archived
 *     without completing" per `repository.ts` `archive()`, which only ever
 *     logs `kind = 'archived'` on the non-completing path; `agent_fallback`
 *     for a mid-run agent handoff from `agent-runner.ts`). Ranked by lift —
 *     the n-gram's target rate divided by the target's base rate across every
 *     n-gram window — so a pattern that is merely common isn't mistaken for
 *     one that is predictive; `minSupport` (default 5) drops n-grams too rare
 *     for their rate to be meaningful.
 */

export interface KindSequence {
  workItemId: string;
  kinds: string[];
}

export interface NgramFrequency {
  sequence: string[];
  count: number;
}

export interface PredictiveNgram {
  sequence: string[];
  targetKind: string;
  count: number;
  precedingTargetCount: number;
  precedingTargetRate: number;
  lift: number;
}

export interface NgramAnalysis {
  sample: {
    workItemCount: number;
    activityCount: number;
    minSupport: number;
  };
  bigrams: NgramFrequency[];
  trigrams: NgramFrequency[];
  precedingArchive: {
    bigrams: PredictiveNgram[];
    trigrams: PredictiveNgram[];
  };
  precedingAgentFallback: {
    bigrams: PredictiveNgram[];
    trigrams: PredictiveNgram[];
  };
}

interface ActivityKindRow {
  work_item_id: string;
  kind: string;
}

const ACTIVITY_KIND_SEQUENCE_SQL = `
  SELECT work_item_id, kind
  FROM activities
  ORDER BY work_item_id, created_at, rowid
`;

/** Every work item's activity `kind` values, oldest first, one sequence per item. */
export function activityKindSequences(database: WorkbenchDatabase): KindSequence[] {
  const rows = database.prepare(ACTIVITY_KIND_SEQUENCE_SQL).all() as unknown as ActivityKindRow[];
  const sequences = new Map<string, string[]>();
  for (const row of rows) {
    const kinds = sequences.get(row.work_item_id) ?? [];
    kinds.push(row.kind);
    sequences.set(row.work_item_id, kinds);
  }
  return [...sequences.entries()].map(([workItemId, kinds]) => ({ workItemId, kinds }));
}

const ngramKey = (sequence: string[]): string => sequence.join(' → ');

/** Frequency of every contiguous n-gram of `kind` values, most common first. */
export function ngramFrequencies(sequences: KindSequence[], n: 2 | 3): NgramFrequency[] {
  const counts = new Map<string, NgramFrequency>();
  for (const { kinds } of sequences) {
    for (let i = 0; i + n <= kinds.length; i++) {
      const sequence = kinds.slice(i, i + n);
      const key = ngramKey(sequence);
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { sequence, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/**
 * N-grams ranked by how predictive they are of `targetKind` occurring as the
 * very next activity. `lift` above 1 means the n-gram raises the odds of
 * `targetKind` above its base rate; below 1 means it lowers them.
 */
export function ngramsPrecedingKind(sequences: KindSequence[], targetKind: string, n: 2 | 3, minSupport = 5): PredictiveNgram[] {
  const counts = new Map<string, { sequence: string[]; count: number; precedingTarget: number }>();
  let totalWindows = 0;
  let totalPrecedingTarget = 0;

  for (const { kinds } of sequences) {
    for (let i = 0; i + n < kinds.length; i++) {
      const sequence = kinds.slice(i, i + n);
      const next = kinds[i + n];
      const key = ngramKey(sequence);
      const entry = counts.get(key) ?? { sequence, count: 0, precedingTarget: 0 };
      entry.count += 1;
      if (next === targetKind) entry.precedingTarget += 1;
      counts.set(key, entry);
      totalWindows += 1;
      if (next === targetKind) totalPrecedingTarget += 1;
    }
  }

  const baselineRate = totalWindows > 0 ? totalPrecedingTarget / totalWindows : 0;

  return [...counts.values()]
    .filter((entry) => entry.count >= minSupport && entry.precedingTarget > 0)
    .map((entry) => {
      const precedingTargetRate = entry.precedingTarget / entry.count;
      return {
        sequence: entry.sequence,
        targetKind,
        count: entry.count,
        precedingTargetCount: entry.precedingTarget,
        precedingTargetRate: round2(precedingTargetRate),
        lift: baselineRate > 0 ? round2(precedingTargetRate / baselineRate) : 0,
      };
    })
    .sort((a, b) => b.lift - a.lift || b.precedingTargetCount - a.precedingTargetCount);
}

/**
 * The complete read-only n-gram report for the two lifecycle outcomes that
 * matter today: incomplete archive and agent fallback. The sample metadata
 * stays with the result so callers can judge whether a ranked pattern has
 * enough evidence, rather than treating a rate as meaningful in isolation.
 */
export function analyzeActivityKindNgrams(database: WorkbenchDatabase, minSupport = 5): NgramAnalysis {
  const sequences = activityKindSequences(database);
  return {
    sample: {
      workItemCount: sequences.length,
      activityCount: sequences.reduce((count, sequence) => count + sequence.kinds.length, 0),
      minSupport,
    },
    bigrams: ngramFrequencies(sequences, 2),
    trigrams: ngramFrequencies(sequences, 3),
    precedingArchive: {
      bigrams: ngramsPrecedingKind(sequences, 'archived', 2, minSupport),
      trigrams: ngramsPrecedingKind(sequences, 'archived', 3, minSupport),
    },
    precedingAgentFallback: {
      bigrams: ngramsPrecedingKind(sequences, 'agent_fallback', 2, minSupport),
      trigrams: ngramsPrecedingKind(sequences, 'agent_fallback', 3, minSupport),
    },
  };
}
