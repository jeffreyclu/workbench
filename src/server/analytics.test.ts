import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { describeLifecycleChange } from './activity-log.js';
import { activityKindSequences, analyzeActivityKindNgrams, cycleTimeByStatus, ngramFrequencies, ngramsPrecedingKind, statusIntervals, taskCohortStatistics } from './analytics.js';
import type { WorkItemStatus } from '../shared/contracts.js';

describe('analytics: cycle time by status', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  function newItem(createdAt: string) {
    const item = repository.create({
      title: 'Ship the analytics query', description: '', priority: 1, status: 'ready',
      projectName: null, workspacePath: null, dueDate: null,
    });
    database.prepare('UPDATE work_items SET created_at = ? WHERE id = ?').run(createdAt, item.id);
    return item.id;
  }

  /**
   * Writes an activity through the same `addActivity` path production code
   * uses, then pins its timestamp — so the body text this test exercises is
   * byte-for-byte what `repository.ts` and `activity-log.ts` actually
   * produce, while the test still controls ordering deterministically
   * instead of racing `new Date().toISOString()` millisecond ties.
   */
  function logEditedStatus(workItemId: string, from: string, to: string, createdAt: string, extraEdits: string[] = []): void {
    const body = `${[...extraEdits, `Status: ${from} → ${to}`].join(' · ')}.`;
    const activity = repository.addActivity(workItemId, 'jeffrey', 'edited', body);
    database.prepare('UPDATE activities SET created_at = ? WHERE id = ?').run(createdAt, activity.id);
  }

  function logLifecycle(workItemId: string, kind: 'completed' | 'archived' | 'restored', body: string, createdAt: string): void {
    const activity = repository.addActivity(workItemId, 'system', kind, body);
    database.prepare('UPDATE activities SET created_at = ? WHERE id = ?').run(createdAt, activity.id);
  }

  it('reconstructs a known timeline into per-status intervals via LAG over status-transition events, not every activity', () => {
    const itemId = newItem('2026-01-01T00:00:00.000Z');

    logEditedStatus(itemId, 'ready', 'in_progress', '2026-01-01T02:00:00.000Z'); // ready: 2h
    // Renames the task in the same edit, so the "Status: X → Y" segment is not
    // the whole activity body and must be sliced out of it.
    logEditedStatus(itemId, 'in_progress', 'blocked', '2026-01-01T05:00:00.000Z', ['Renamed to "Ship it (blocked)"']); // in_progress: 3h
    logEditedStatus(itemId, 'blocked', 'in_progress', '2026-01-01T09:00:00.000Z'); // blocked: 4h
    logLifecycle(itemId, 'completed', describeLifecycleChange('complete'), '2026-01-01T15:00:00.000Z'); // in_progress: 6h

    const intervals = statusIntervals(database).filter((interval) => interval.workItemId === itemId);
    // julianday() carries floating-point noise at the ~1e-8 hour scale, so
    // round before comparing against the known timeline.
    expect(intervals.map((interval) => [interval.status, Math.round(interval.durationHours)])).toEqual([
      ['ready', 2],
      ['in_progress', 3],
      ['blocked', 4],
      ['in_progress', 6],
    ]);
    expect(intervals.every((interval) => interval.durationHours > 0)).toBe(true);
  });

  it('excludes an incomplete archive and its restore, which do not change status', () => {
    const itemId = newItem('2026-01-01T00:00:00.000Z');
    logEditedStatus(itemId, 'ready', 'in_progress', '2026-01-01T02:00:00.000Z');
    logLifecycle(itemId, 'archived', describeLifecycleChange('archive'), '2026-01-01T04:00:00.000Z');
    logLifecycle(itemId, 'restored', describeLifecycleChange('restore'), '2026-01-01T06:00:00.000Z');

    const intervals = statusIntervals(database).filter((interval) => interval.workItemId === itemId);
    // Only the one genuine "Status: ready → in_progress" edit produced a closed
    // interval; the incomplete archive/restore bodies contributed nothing.
    expect(intervals.map((interval) => interval.status)).toEqual(['ready']);
  });

  it('models a restore after completion as the deterministic done-to-ready transition', () => {
    const itemId = newItem('2026-01-01T00:00:00.000Z');
    logEditedStatus(itemId, 'ready', 'in_progress', '2026-01-01T02:00:00.000Z');
    logLifecycle(itemId, 'completed', describeLifecycleChange('complete'), '2026-01-01T05:00:00.000Z');
    logLifecycle(itemId, 'restored', describeLifecycleChange('restore'), '2026-01-01T07:00:00.000Z');
    logEditedStatus(itemId, 'ready', 'blocked', '2026-01-01T09:00:00.000Z');

    const intervals = statusIntervals(database).filter((interval) => interval.workItemId === itemId);
    expect(intervals.map((interval) => [interval.status, Math.round(interval.durationHours)])).toEqual([
      ['ready', 2],
      ['in_progress', 3],
      ['done', 2],
      ['ready', 2],
    ]);
  });

  it("excludes each work item's still-open final status since it is right-censored", () => {
    const itemId = newItem('2026-01-01T00:00:00.000Z');
    logEditedStatus(itemId, 'ready', 'in_progress', '2026-01-01T02:00:00.000Z');
    // No further transition: the "in_progress" tail must not appear as a closed interval.
    const intervals = statusIntervals(database).filter((interval) => interval.workItemId === itemId);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].status).toBe('ready');
  });

  it('buckets cycle time into p50/p95/p99 per status across many work items with non-zero durations', () => {
    const hours = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    let cursor = new Date('2026-02-01T00:00:00.000Z').getTime();
    for (const durationHours of hours) {
      const itemId = newItem(new Date(cursor).toISOString());
      logEditedStatus(itemId, 'ready', 'in_progress', new Date(cursor + durationHours * 3_600_000).toISOString());
      cursor += (durationHours + 1) * 3_600_000;
    }

    const stats = cycleTimeByStatus(database);
    const ready = stats.find((entry) => entry.status === 'ready');
    expect(ready).toBeDefined();
    expect(ready!.count).toBe(hours.length);
    expect(ready!.p50Hours).toBeGreaterThan(0);
    expect(ready!.p95Hours).toBeGreaterThanOrEqual(ready!.p50Hours);
    expect(ready!.p99Hours).toBeGreaterThanOrEqual(ready!.p95Hours);
    // Nearest-rank p50 of the 10 sorted durations lands on the 5th smallest.
    expect(ready!.p50Hours).toBe(8);
    expect(ready!.p99Hours).toBe(89);
  });
});

describe('analytics: task cohort comparison', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  function createItem(options: { project: string | null; source: 'manual' | 'linear'; createdAt: string; completedAt?: string; status?: WorkItemStatus }): string {
    const item = repository.create({
      title: 'Compare cohort outcomes', description: '', priority: 1, status: options.status ?? 'ready',
      projectName: options.project, workspacePath: null, dueDate: null,
    });
    database.prepare('UPDATE work_items SET source = ?, created_at = ?, status = ? WHERE id = ?')
      .run(options.source, options.createdAt, options.status ?? 'ready', item.id);
    if (options.completedAt) {
      const activity = repository.addActivity(item.id, 'system', 'completed', 'Completed the task.');
      database.prepare('UPDATE work_items SET completed_at = ?, status = ?, archived_at = ? WHERE id = ?')
        .run(options.completedAt, 'done', options.completedAt, item.id);
      database.prepare('UPDATE activities SET created_at = ? WHERE id = ?').run(options.completedAt, activity.id);
    }
    return item.id;
  }

  it('compares project cohorts with completion, cycle time, current status, and time-to-completion buckets', () => {
    createItem({ project: 'Alpha', source: 'manual', createdAt: '2026-01-05T00:00:00.000Z', completedAt: '2026-01-06T00:00:00.000Z' });
    createItem({ project: 'Alpha', source: 'manual', createdAt: '2026-01-05T00:00:00.000Z', status: 'blocked' });
    createItem({ project: 'Beta', source: 'linear', createdAt: '2026-01-06T00:00:00.000Z', completedAt: '2026-01-09T00:00:00.000Z' });

    const cohorts = taskCohortStatistics(database, 'project');
    expect(cohorts).toHaveLength(2);
    expect(cohorts.find((cohort) => cohort.cohort === 'Alpha')).toEqual({
      dimension: 'project', cohort: 'Alpha', workItemCount: 2, completedCount: 1, completionRate: 0.5,
      meanCycleTimeHours: 24, medianCycleTimeHours: 24,
      statusDistribution: [
        { status: 'blocked', count: 1, percentage: 0.5 },
        { status: 'done', count: 1, percentage: 0.5 },
      ],
      timeToCompletionDistribution: [
        { label: '< 1 day', count: 0 }, { label: '1–3 days', count: 1 }, { label: '3–7 days', count: 0 },
        { label: '7–14 days', count: 0 }, { label: '14+ days', count: 0 },
      ],
    });
    expect(cohorts.find((cohort) => cohort.cohort === 'Beta')).toMatchObject({
      completedCount: 1, completionRate: 1, meanCycleTimeHours: 72, medianCycleTimeHours: 72,
    });
  });

  it('groups the same outcomes by source and UTC creation-week without using actor data', () => {
    createItem({ project: null, source: 'manual', createdAt: '2026-01-04T23:00:00.000Z', completedAt: '2026-01-05T01:00:00.000Z' });
    createItem({ project: null, source: 'linear', createdAt: '2026-01-05T00:00:00.000Z', status: 'ready' });
    createItem({ project: null, source: 'linear', createdAt: '2026-01-12T00:00:00.000Z', completedAt: '2026-01-12T12:00:00.000Z' });

    expect(taskCohortStatistics(database, 'source')).toEqual(expect.arrayContaining([
      expect.objectContaining({ cohort: 'manual', workItemCount: 1, completedCount: 1, completionRate: 1 }),
      expect.objectContaining({ cohort: 'linear', workItemCount: 2, completedCount: 1, completionRate: 0.5 }),
    ]));
    expect(taskCohortStatistics(database, 'creation_week')).toEqual(expect.arrayContaining([
      expect.objectContaining({ cohort: '2025-12-29', workItemCount: 1 }),
      expect.objectContaining({ cohort: '2026-01-05', workItemCount: 1 }),
      expect.objectContaining({ cohort: '2026-01-12', workItemCount: 1 }),
    ]));
  });

  it('does not count an old completion activity after the task was restored', () => {
    const itemId = createItem({ project: 'Alpha', source: 'manual', createdAt: '2026-01-05T00:00:00.000Z', completedAt: '2026-01-06T00:00:00.000Z' });
    database.prepare('UPDATE work_items SET completed_at = NULL, archived_at = NULL, status = ? WHERE id = ?').run('ready', itemId);

    const [cohort] = taskCohortStatistics(database, 'project');
    expect(cohort).toMatchObject({ completedCount: 0, completionRate: 0, meanCycleTimeHours: null, medianCycleTimeHours: null });
    expect(cohort.timeToCompletionDistribution.every((bucket) => bucket.count === 0)).toBe(true);
  });
});

describe('analytics: n-gram sequence analysis', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  function newItem() {
    return repository.create({
      title: 'Ship n-gram analysis', description: '', priority: 1, status: 'ready',
      projectName: null, workspacePath: null, dueDate: null,
    }).id;
  }

  /** Logs `kinds` in order, one activity apiece, pinning strictly increasing timestamps so order is deterministic. */
  function logKinds(workItemId: string, kinds: string[]): void {
    let cursor = new Date('2030-01-01T00:00:00.000Z').getTime();
    for (const kind of kinds) {
      const activity = repository.addActivity(workItemId, 'system', kind, kind);
      database.prepare('UPDATE activities SET created_at = ? WHERE id = ?').run(new Date(cursor).toISOString(), activity.id);
      cursor += 60_000;
    }
  }

  it("reads each work item's activity kinds in chronological order, never mixing sequences across items", () => {
    const itemA = newItem();
    const itemB = newItem();
    logKinds(itemA, ['queued', 'progress', 'blocker']);
    logKinds(itemB, ['queued', 'progress', 'completed']);

    const sequences = activityKindSequences(database);
    expect(sequences.find((s) => s.workItemId === itemA)?.kinds).toEqual(['created', 'queued', 'progress', 'blocker']);
    expect(sequences.find((s) => s.workItemId === itemB)?.kinds).toEqual(['created', 'queued', 'progress', 'completed']);
  });

  it('counts bigram frequencies across every sequence, most common first', () => {
    const sequences = [
      { workItemId: 'a', kinds: ['queued', 'progress', 'blocker'] },
      { workItemId: 'b', kinds: ['queued', 'progress', 'completed'] },
    ];
    const freq = ngramFrequencies(sequences, 2);
    expect(freq[0]).toEqual({ sequence: ['queued', 'progress'], count: 2 });
    expect(freq).toContainEqual({ sequence: ['progress', 'blocker'], count: 1 });
    expect(freq).toContainEqual({ sequence: ['progress', 'completed'], count: 1 });
  });

  it('counts trigram frequencies, one entry per distinct 3-token window', () => {
    const sequences = [
      { workItemId: 'a', kinds: ['queued', 'progress', 'blocker'] },
      { workItemId: 'b', kinds: ['queued', 'progress', 'completed'] },
    ];
    const freq = ngramFrequencies(sequences, 3);
    expect(freq).toHaveLength(2);
    expect(freq).toContainEqual({ sequence: ['queued', 'progress', 'blocker'], count: 1 });
    expect(freq).toContainEqual({ sequence: ['queued', 'progress', 'completed'], count: 1 });
  });

  it('never lets an n-gram window span two work items', () => {
    const sequences = [
      { workItemId: 'a', kinds: ['queued'] },
      { workItemId: 'b', kinds: ['archived'] },
    ];
    expect(ngramFrequencies(sequences, 2)).toEqual([]);
  });

  it('ranks n-grams by lift toward a target kind and drops ones below minSupport', () => {
    const sequences = [
      // 'progress' → 'blocker' is consistently followed by 'archived'.
      { workItemId: '1', kinds: ['queued', 'progress', 'blocker', 'archived'] },
      { workItemId: '2', kinds: ['queued', 'progress', 'blocker', 'archived'] },
      { workItemId: '3', kinds: ['queued', 'progress', 'blocker', 'archived'] },
      // 'queued' → 'progress' also occurs often, but here it never precedes 'archived'.
      { workItemId: '4', kinds: ['queued', 'progress', 'completed'] },
      { workItemId: '5', kinds: ['queued', 'progress', 'completed'] },
      { workItemId: '6', kinds: ['queued', 'progress', 'completed'] },
      // 'x' → 'y' precedes 'archived' every time it occurs, but only occurs twice.
      { workItemId: '7', kinds: ['x', 'y', 'archived'] },
      { workItemId: '8', kinds: ['x', 'y', 'archived'] },
    ];

    const ranked = ngramsPrecedingKind(sequences, 'archived', 2, 3);

    expect(ranked.map((entry) => entry.sequence)).toEqual([['progress', 'blocker']]);
    expect(ranked.find((entry) => entry.sequence.join() === 'x,y')).toBeUndefined();

    const progressBlocker = ranked[0];
    expect(progressBlocker.count).toBe(3);
    expect(progressBlocker.precedingTargetCount).toBe(3);
    expect(progressBlocker.precedingTargetRate).toBe(1);
    expect(progressBlocker.lift).toBeGreaterThan(1);

  });

  it('returns frequency and lifecycle-outcome sections with sample context in one read-only report', () => {
    for (let index = 0; index < 5; index++) {
      logKinds(newItem(), ['execution_started', 'progress', 'archived']);
      logKinds(newItem(), ['model_selected', 'progress', 'agent_fallback']);
    }

    const analysis = analyzeActivityKindNgrams(database);

    expect(analysis.sample).toEqual({ workItemCount: 10, activityCount: 40, minSupport: 5 });
    expect(analysis.bigrams).toContainEqual({ sequence: ['execution_started', 'progress'], count: 5 });
    expect(analysis.trigrams).toContainEqual({ sequence: ['model_selected', 'progress', 'agent_fallback'], count: 5 });
    expect(analysis.precedingArchive.bigrams).toContainEqual(expect.objectContaining({
      sequence: ['execution_started', 'progress'], count: 5, precedingTargetCount: 5,
    }));
    expect(analysis.precedingAgentFallback.bigrams).toContainEqual(expect.objectContaining({
      sequence: ['model_selected', 'progress'], count: 5, precedingTargetCount: 5,
    }));
  });
});
