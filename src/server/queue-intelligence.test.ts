import { describe, expect, it } from 'vitest';
import type { QueueItemExplanation, WorkItem } from '../shared/contracts.js';
import { learnFeedbackWeights, planQueue, stabilize, STABILITY_MARGIN, type QueueContext } from './queue-intelligence.js';

const NOW = Date.parse('2026-08-20T09:00:00.000Z');

function item(overrides: Partial<WorkItem> & { id: string; title: string }): WorkItem {
  return {
    description: '', status: 'ready', priority: 2, queuePosition: 1, source: 'manual', isQueued: true,
    archivedAt: null, completedAt: null, parentWorkItemId: null, completionStatus: 'incomplete',
    agentOutcome: null,
    sourceIdentifier: null, sourceUrl: null, sourceTags: [], projectName: null,
    workspacePath: null, strategy: '', assignees: [], labels: [], dueDate: null, providerUpdatedAt: null,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    lastTouchedAt: new Date(NOW).toISOString(), ...overrides, stack: overrides.stack ?? 'attention',
  };
}

function context(overrides: Partial<QueueContext> = {}): QueueContext {
  return {
    now: NOW, openChildren: new Map(), openDependents: new Map(), activeRuns: new Map(), unresolvedBlockers: new Set(),
    sourceChanges: new Map(), feedback: new Map(), ...overrides,
  };
}

const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const signalKeys = (plan: ReturnType<typeof planQueue>, id: string) =>
  plan.explanations.find((entry) => entry.itemId === id)!.signals.map((signal) => signal.key);

describe('queue intelligence', () => {
  it('keeps yesterday’s order when no score gap clears the stability margin', () => {
    const items = [item({ id: 'a', title: 'A' }), item({ id: 'b', title: 'B', assignees: ['jeffrey'] })];
    const plan = planQueue(items, context());

    expect(plan.orderedItemIds).toEqual(['a', 'b']);
    expect(plan.rationale).toContain('No meaningful new task context');
  });

  it('explains every task it moves with the signal that caused the move', () => {
    const items = [
      item({ id: 'fresh', title: 'Fresh task' }),
      item({ id: 'stale', title: 'Stale follow-up', lastTouchedAt: daysAgo(10) }),
      item({ id: 'due', title: 'Overdue report', dueDate: daysAgo(1) }),
    ];
    const plan = planQueue(items, context());

    // Both jump the fresh task, but `due` scores only two points above `stale`,
    // which is inside the stability margin, so yesterday's relative order holds.
    expect(plan.orderedItemIds).toEqual(['stale', 'due', 'fresh']);
    expect(plan.rationale).toContain('10 days without activity');
    expect(plan.rationale).toContain('the due date has already passed');
    const stale = plan.explanations.find((entry) => entry.itemId === 'stale')!;
    expect(stale.previousPosition).toBe(2);
    expect(stale.proposedPosition).toBe(1);
    expect(stale.signals).toContainEqual({ key: 'aging', delta: 8, detail: '10 days without activity' });
  });

  it('demotes work that is waiting on subtasks, an unresolved blocker note, or a running agent', () => {
    const items = [
      item({ id: 'parent', title: 'Parent epic' }),
      item({ id: 'noted', title: 'Blocked in practice' }),
      item({ id: 'running', title: 'Agent already on it' }),
      item({ id: 'plain', title: 'Plain work' }),
    ];
    const plan = planQueue(items, context({
      openChildren: new Map([['parent', 2]]),
      unresolvedBlockers: new Set(['noted']),
      activeRuns: new Map([['running', 1]]),
    }));

    expect(plan.orderedItemIds).toEqual(['plain', 'parent', 'noted', 'running']);
    expect(signalKeys(plan, 'parent')).toContain('blocker');
    expect(signalKeys(plan, 'running')).toContain('workload');
    expect(plan.rationale).toContain('waiting on 2 open subtasks');
  });

  it('promotes tasks whose source changed since the last plan', () => {
    const items = [item({ id: 'quiet', title: 'Quiet task' }), item({ id: 'moved', title: 'Source moved' })];
    const plan = planQueue(items, context({ sourceChanges: new Map([['moved', 'its linear source changed since the last plan']]) }));

    expect(plan.orderedItemIds).toEqual(['moved', 'quiet']);
    expect(plan.rationale).toContain('its linear source changed since the last plan');
  });

  it('holds ready work behind in-progress work once the workload limit is reached', () => {
    const busy = ['w1', 'w2', 'w3'].map((id) => item({ id, title: id, status: 'in_progress' }));
    const plan = planQueue([item({ id: 'next', title: 'Next up' }), ...busy], context());

    expect(plan.orderedItemIds).toEqual(['w1', 'w2', 'w3', 'next']);
    expect(signalKeys(plan, 'next')).toContain('workload');
  });

  it('never lets aging alone outrank work that is actively in progress', () => {
    const items = [
      item({ id: 'active', title: 'Active work', status: 'in_progress' }),
      item({ id: 'ancient', title: 'Ancient task', lastTouchedAt: daysAgo(400) }),
    ];

    expect(planQueue(items, context()).orderedItemIds).toEqual(['active', 'ancient']);
  });

  it('learns from accepted and rejected proposals and reports the adjustment as its own signal', () => {
    const explanations: QueueItemExplanation[] = [{
      itemId: 'stale', title: 'Stale follow-up', score: 8, previousPosition: 2, proposedPosition: 1,
      signals: [{ key: 'aging', delta: 8, detail: '8 days without activity' }],
    }];
    const weights = learnFeedbackWeights([
      { status: 'accepted', explanations },
      { status: 'accepted', explanations },
      { status: 'rejected', explanations },
    ]);

    expect(weights.get('aging')).toEqual({ weight: 1.1, accepted: 2, rejected: 1 });

    const plan = planQueue([item({ id: 'stale', title: 'Stale', lastTouchedAt: daysAgo(4) })], context({ feedback: weights }));
    const signals = plan.explanations[0].signals;
    expect(signals.find((signal) => signal.key === 'feedback')).toEqual({
      key: 'feedback', delta: 0.4,
      detail: 'aging counts 1.10× after 2 accepted and 1 rejected proposals',
    });
    // 4 (ready) + 4 (four days untouched) + 0.4 (learned aging weight).
    expect(plan.explanations[0].score).toBe(8.4);
  });

  it('clamps learned weights so one repeatedly accepted signal cannot dominate', () => {
    const explanations: QueueItemExplanation[] = [{
      itemId: 'due', title: 'Due', score: 10, previousPosition: 3, proposedPosition: 1,
      signals: [{ key: 'deadline', delta: 10, detail: 'the due date has already passed' }],
    }];
    const weights = learnFeedbackWeights(Array.from({ length: 12 }, () => ({ status: 'accepted' as const, explanations })));

    expect(weights.get('deadline')?.weight).toBe(1.4);
  });

  it('ignores signals it has no feedback for and proposals that moved nothing', () => {
    const weights = learnFeedbackWeights([{
      status: 'accepted',
      explanations: [{ itemId: 'a', title: 'A', score: 0, previousPosition: 1, proposedPosition: 1, signals: [{ key: 'aging', delta: 4, detail: '4 days' }] }],
    }]);

    expect(weights.size).toBe(0);
  });

  it('terminates and only swaps neighbours whose gap clears the margin', () => {
    const scores = new Map([['a', 0], ['b', STABILITY_MARGIN], ['c', 100]]);

    expect(stabilize(['a', 'b', 'c'], scores)).toEqual(['c', 'a', 'b']);
    expect(stabilize(['a', 'b'], new Map([['a', 0], ['b', STABILITY_MARGIN]]))).toEqual(['a', 'b']);
    expect(stabilize([], new Map())).toEqual([]);
  });

  it('scores deadline urgency in bands rather than a cliff at the due date', () => {
    const bands = [inDays(0.5), inDays(2), inDays(10)].map((dueDate, index) =>
      planQueue([item({ id: `d${index}`, title: 'Due', status: 'backlog', dueDate })], context()).explanations[0].score);

    expect(bands).toEqual([8, 5, 0]);
  });

  it('treats a deadline as due today in the configured Workbench timezone', () => {
    const now = Date.parse('2026-08-21T03:30:00.000Z'); // Aug 20, 23:30 in New York
    const task = item({ id: 'today', title: 'Due today', status: 'backlog', dueDate: '2026-08-20' });
    const plan = planQueue([task], context({ now, timeZone: 'America/New_York' }));

    expect(plan.explanations[0].signals).toContainEqual({ key: 'deadline', delta: 8, detail: 'it is due today' });
  });
});
