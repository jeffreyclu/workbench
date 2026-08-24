import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { evaluateAutonomousDispatch, type AutonomousDispatchRequest } from './autonomy-governor.js';
import { WorkItemRepository } from './repository.js';
import { startOfIsoWeekUtc } from './usage-meter.js';

const now = new Date('2026-08-23T12:00:00.000Z');

function seed() {
  const database = openDatabase(':memory:');
  const repository = new WorkItemRepository(database);
  const item = repository.create({ title: 'Candidate task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
  repository.createUsageCalibration({ provider: 'claude', observedAt: now.toISOString(), observedPercentage: 50, workbenchSet: 1, interactiveSet: 0, computedCeilingSet: 1_000 });
  return { database, repository, item };
}

function request(workItemId: string, changes: Partial<AutonomousDispatchRequest> = {}): AutonomousDispatchRequest {
  return { origin: 'autonomous', model: 'sonnet', workItemId, environment: { WORKBENCH_AUTONOMY_ENABLED: 'true' }, now, ...changes };
}

describe('evaluateAutonomousDispatch', () => {
  it('refuses an over-budget request without creating a hold', () => {
    const { database, repository, item } = seed();
    // The ceiling is 1,000 SET but no run history exists, so the estimator falls back to
    // the 100,000 SET default — comfortably over any calibrated ceiling here.
    expect(evaluateAutonomousDispatch(repository, request(item.id)))
      .toEqual(expect.objectContaining({ approved: false, reason: expect.stringMatching(/budget exhausted/i) }));
    expect(repository.heldBudgetReservationSet('claude', now.toISOString())).toBe(0);
    database.close();
  });

  it('honors the administrative kill switch', () => {
    const { database, repository, item } = seed();
    expect(evaluateAutonomousDispatch(repository, request(item.id, { environment: {} })))
      .toEqual(expect.objectContaining({ approved: false, reason: expect.stringMatching(/kill switch/i) }));
    expect(repository.heldBudgetReservationSet('claude', now.toISOString())).toBe(0);
    database.close();
  });

  it('refuses models outside the Haiku/Sonnet allowlist', () => {
    const { database, repository, item } = seed();
    expect(evaluateAutonomousDispatch(repository, request(item.id, { model: 'opus' })))
      .toEqual(expect.objectContaining({ approved: false, reason: expect.stringMatching(/not on the autonomous allowlist/i) }));
    database.close();
  });

  it('refuses an invalid run origin', () => {
    const { database, repository, item } = seed();
    expect(evaluateAutonomousDispatch(repository, request(item.id, { origin: 'manual' })))
      .toEqual(expect.objectContaining({ approved: false, reason: expect.stringMatching(/invalid run origin/i) }));
    database.close();
  });

  it('accepts a valid autonomous Haiku/Sonnet request and atomically holds its required tokens', () => {
    const { database, repository, item } = seed();
    // Gives the SET estimator a 150 SET average per run: the 200 SET slice (1,000 ceiling
    // x 20% autonomous fraction) fits exactly one hold but not two.
    const priorRun = repository.createRun(item.id, 'execute', 'claude', 'claude', '', null, null, 'manual');
    repository.updateRun(priorRun.id, { model: 'haiku', inputTokens: 150, outputTokens: 0 });
    const windowStart = startOfIsoWeekUtc(now).toISOString();

    const accepted = evaluateAutonomousDispatch(repository, request(item.id, { model: 'haiku' }));
    expect(accepted).toMatchObject({ approved: true, model: 'haiku', reservedSet: 150, reservationId: expect.any(String) });
    if (!accepted.approved) throw new Error('expected approval');
    expect(repository.heldBudgetReservationSet('claude', windowStart)).toBe(150);

    // A second candidate cannot spend the same 200-SET slice while the first hold stands.
    expect(evaluateAutonomousDispatch(repository, request(item.id, { model: 'haiku' })))
      .toEqual(expect.objectContaining({ approved: false, reason: expect.stringMatching(/budget exhausted/i) }));
    database.close();
  });
});
