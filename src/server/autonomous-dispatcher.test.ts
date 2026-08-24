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

    const result = dispatchAutonomousWork(repository, { approved: true, agent: 'claude', model: 'sonnet', executionProfile: 'standard', reservedSet: 100, reservationId: 'test-reservation' });

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

    expect(dispatchAutonomousWork(repository, { approved: false, reason: 'Autonomous budget exhausted.' })).toEqual({ dispatched: false, reason: 'Autonomous budget exhausted.' });
    expect(repository.listRuns(item.id)).toHaveLength(0);
    database.close();
  });

  it('skips Jeffrey-owned and prerequisite-blocked work when selecting the next task', () => {
    const { database, repository } = seededRepository();
    const prerequisite = repository.create({ title: 'Implement prerequisite', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const blocked = repository.create({ title: 'Implement blocked task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const owned = repository.create({ title: 'Implement owned task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const eligible = repository.create({ title: 'Implement eligible task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    repository.update(blocked.id, { blockedByIds: [prerequisite.id] });
    repository.update(owned.id, { assignees: ['jeffrey'] });
    repository.reorder([blocked.id, owned.id, eligible.id, prerequisite.id]);

    expect(dispatchAutonomousWork(repository, { approved: true, agent: 'claude', model: 'sonnet', executionProfile: 'standard', reservedSet: 100, reservationId: 'test-reservation' })).toMatchObject({ dispatched: true, item: { id: eligible.id } });
    database.close();
  });

  it('honors the disabled kill switch and refuses a calibrated but over-budget dispatch', () => {
    const { database, repository } = seededRepository();
    const item = repository.create({ title: 'Implement governed task', description: '', priority: 1, status: 'backlog', projectName: null, workspacePath: null, dueDate: null });
    const now = new Date('2026-08-23T12:00:00.000Z');
    repository.createUsageCalibration({ provider: 'claude', observedAt: now.toISOString(), observedPercentage: 50, workbenchSet: 1, interactiveSet: 0, computedCeilingSet: 0 });

    expect(evaluateAutonomousDispatch(repository, { origin: 'autonomous', model: 'sonnet', workItemId: item.id, now, environment: {} })).toEqual(expect.objectContaining({ approved: false, reason: expect.stringMatching(/kill switch/i) }));
    expect(evaluateAutonomousDispatch(repository, { origin: 'autonomous', model: 'sonnet', workItemId: item.id, now, environment: { WORKBENCH_AUTONOMY_ENABLED: 'true' } })).toEqual(expect.objectContaining({ approved: false, reason: expect.stringMatching(/budget exhausted/i) }));
    expect(repository.listRuns(item.id)).toHaveLength(0);
    database.close();
  });
});
