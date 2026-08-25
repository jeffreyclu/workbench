import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { dispatchAutonomousWork } from './autonomous-dispatcher.js';
import { evaluateAutonomousDispatch } from './autonomy-governor.js';

function seededRepository() {
  const database = openDatabase(':memory:');
  const repository = new WorkItemRepository(database);
  return { database, repository };
}

describe('autonomous dispatcher', () => {
  it('executes the highest queued eligible backlog item and records autonomous origin', () => {
    const { database, repository } = seededRepository();
    const lower = repository.create({ title: 'Implement lower priority task', description: '', priority: 2, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const higher = repository.create({ title: 'Implement highest priority task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    repository.reorder([higher.id, lower.id]);

    const result = dispatchAutonomousWork(repository, { approved: true, agent: 'claude', model: 'sonnet', executionProfile: 'standard', reservedSet: 100, reservationId: 'test-reservation', windowStart: '2026-08-23T00:00:00.000Z', windowEnd: '2026-08-30T00:00:00.000Z' });

    expect(result).toMatchObject({ dispatched: true, item: { id: higher.id }, run: { origin: 'autonomous', agent: 'claude', model: 'sonnet' } });
    expect(repository.listRuns(lower.id)).toHaveLength(0);
    expect(repository.listActivity(higher.id).some((activity) => activity.kind === 'autonomous_execution_started')).toBe(true);
    expect(repository.listAuditLog(10).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'autonomous-dispatcher', workItemId: higher.id }),
    ]));
    database.close();
  });

  it('does not dispatch when the governor refuses', () => {
    const { database, repository } = seededRepository();
    const item = repository.create({ title: 'Implement guarded task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });

    expect(dispatchAutonomousWork(repository, { approved: false, reasonCode: 'budget_exhausted', reason: 'Autonomous budget exhausted.' })).toEqual({ dispatched: false, reason: 'Autonomous budget exhausted.' });
    expect(repository.listRuns(item.id)).toHaveLength(0);
    database.close();
  });

  it('refuses a machine-created item from the same autonomous weekly window', () => {
    const { database, repository } = seededRepository();
    const windowStart = '2026-08-23T00:00:00.000Z';
    const proposal = repository.createMachineProposal({
      title: 'Machine-created discovery proposal', description: 'A reviewable proposal.', suggestedPriority: 1,
      suggestedQueuePosition: 1, rationale: 'Direct request.', runId: 'discovery-run', windowStart,
      sourceUrl: null, now: '2026-08-23T12:00:00.000Z',
    });
    // Jeffrey can promote it, but promotion must not bypass the weekly-window guard.
    expect(repository.update(proposal.id, { status: 'ready' })?.machineProposed).toBe(false);

    expect(dispatchAutonomousWork(repository, {
      approved: true, agent: 'claude', model: 'sonnet', executionProfile: 'standard', reservedSet: 100,
      reservationId: 'test-reservation', windowStart, windowEnd: '2026-08-30T00:00:00.000Z',
    })).toEqual({ dispatched: false, reason: 'Machine-proposed work cannot execute in the autonomous weekly window that created it.' });
    expect(repository.listRuns(proposal.id)).toHaveLength(0);
    database.close();
  });

  it('excludes every ineligible queue category before selecting the next task', () => {
    const { database, repository } = seededRepository();
    const completed = repository.create({ title: 'Completed task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const archived = repository.create({ title: 'Archived task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const blocked = repository.create({ title: 'Blocked task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const prerequisite = repository.create({ title: 'Completed prerequisite', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const prerequisiteBlocked = repository.create({ title: 'Dependency link still present', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const inProgress = repository.create({ title: 'Already in progress', description: '', priority: 1, status: 'in_progress', projectName: null, workspacePath: null, dueDate: null });
    const owned = repository.create({ title: 'Implement owned task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const eligible = repository.create({ title: 'Implement eligible task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    repository.reorder([completed.id, archived.id, blocked.id, prerequisiteBlocked.id, inProgress.id, owned.id, eligible.id, prerequisite.id]);
    repository.update(completed.id, { status: 'done' });
    repository.archive(archived.id, false);
    repository.update(blocked.id, { status: 'blocked' });
    repository.update(prerequisite.id, { status: 'done' });
    repository.update(prerequisiteBlocked.id, { blockedByIds: [prerequisite.id] });
    repository.update(inProgress.id, { status: 'in_progress' });
    repository.update(owned.id, { assignees: ['jeffrey'] });

    expect(dispatchAutonomousWork(repository, { approved: true, agent: 'claude', model: 'sonnet', executionProfile: 'standard', reservedSet: 100, reservationId: 'test-reservation', windowStart: '2026-08-23T00:00:00.000Z', windowEnd: '2026-08-30T00:00:00.000Z' })).toMatchObject({ dispatched: true, item: { id: eligible.id } });
    for (const item of [completed, archived, blocked, prerequisiteBlocked, inProgress, owned]) expect(repository.listRuns(item.id)).toHaveLength(0);
    database.close();
  });

  it('honors the stored disabled kill switch', () => {
    const { database, repository } = seededRepository();
    const item = repository.create({ title: 'Implement governed task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const now = new Date('2026-08-23T12:00:00.000Z');
    expect(evaluateAutonomousDispatch(repository, { origin: 'autonomous', provider: 'claude', model: 'sonnet', workItemId: item.id, now }))
      .toEqual(expect.objectContaining({ approved: false, reasonCode: 'kill_switch_off', reason: expect.stringMatching(/kill switch/i) }));
    expect(repository.listRuns(item.id)).toHaveLength(0);
    database.close();
  });
});
