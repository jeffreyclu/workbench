import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { evaluateAutonomousDispatch, type AutonomousDispatchRequest, type AutonomousGovernorDependencies } from './autonomy-governor.js';
import { WorkItemRepository } from './repository.js';

const now = new Date('2026-08-23T12:00:00.000Z');
const resetAt = '2026-08-30T12:00:00.000Z';
const successfulScan: AutonomousGovernorDependencies = {
  scanUsage: () => ({
    freshInputTokens: 10, cacheReadInputTokens: 5, cacheWriteInputTokens: 0,
    outputTokens: 1, totalTrafficTokens: 16, samples: 1, scannedFiles: 1, error: null,
  }),
};
let temporaryDirectory = '';

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = '';
});

function seed(path = ':memory:', options: { ceiling?: number; calibrationAt?: string; resetsAt?: string | null; providerEnabled?: boolean; historyTokens?: number } = {}) {
  const database = openDatabase(path);
  const repository = new WorkItemRepository(database);
  const item = repository.create({ title: 'Candidate task', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
  repository.setAutonomyPolicy({ globalEnabled: true, targetFraction: 0.16, alarmFraction: 0.2 }, now.toISOString());
  repository.setAutonomyProviderPolicy('claude', { enabled: options.providerEnabled ?? true, weeklyCeilingSet: options.ceiling ?? 1_000 }, now.toISOString());
  repository.createUsageCalibration({
    provider: 'claude', observedAt: options.calibrationAt ?? now.toISOString(), observedPercentage: 50,
    resetsAt: options.resetsAt === undefined ? resetAt : options.resetsAt,
    workbenchSet: 1, interactiveSet: 1, computedCeilingSet: options.ceiling ?? 1_000,
  });
  const priorRun = repository.createRun(item.id, 'analysis', 'claude', 'claude', '', null, null, 'manual');
  repository.updateRun(priorRun.id, { status: 'completed', completedAt: now.toISOString(), model: 'sonnet', inputTokens: options.historyTokens ?? 100, outputTokens: 0 });
  return { database, repository, item };
}

function request(workItemId: string, changes: Partial<AutonomousDispatchRequest> = {}): AutonomousDispatchRequest {
  return { origin: 'autonomous', provider: 'claude', model: 'sonnet', workItemId, now, ...changes };
}

function expectRecordedRefusal(repository: WorkItemRepository, reasonCode: string) {
  expect(repository.listAutonomyGovernorDecisions(1)[0]).toMatchObject({ outcome: 'refused', reasonCode });
}

describe('evaluateAutonomousDispatch', () => {
  it('refuses and records when the stored global kill switch is off', () => {
    const { database, repository, item } = seed();
    repository.setAutonomyPolicy({ globalEnabled: false, targetFraction: 0.16, alarmFraction: 0.2 });
    expect(evaluateAutonomousDispatch(repository, request(item.id), successfulScan)).toMatchObject({ approved: false, reasonCode: 'kill_switch_off', reason: expect.any(String) });
    expectRecordedRefusal(repository, 'kill_switch_off');
    database.close();
  });

  it('refuses and records when the provider is disabled', () => {
    const { database, repository, item } = seed(':memory:', { providerEnabled: false });
    expect(evaluateAutonomousDispatch(repository, request(item.id), successfulScan)).toMatchObject({ approved: false, reasonCode: 'provider_disabled' });
    expectRecordedRefusal(repository, 'provider_disabled');
    database.close();
  });

  it('refuses and records a missing or stale calibration', () => {
    const { database, repository, item } = seed(':memory:', { calibrationAt: '2026-08-01T12:00:00.000Z', resetsAt: '2026-08-08T12:00:00.000Z' });
    expect(evaluateAutonomousDispatch(repository, request(item.id), successfulScan)).toMatchObject({ approved: false, reasonCode: 'calibration_missing_or_stale' });
    expectRecordedRefusal(repository, 'calibration_missing_or_stale');
    database.close();
  });

  it('refuses and records a failed transcript scan', () => {
    const { database, repository, item } = seed();
    const failedScan: AutonomousGovernorDependencies = { scanUsage: () => ({ ...successfulScan.scanUsage('claude', now, now), error: 'permission denied' }) };
    expect(evaluateAutonomousDispatch(repository, request(item.id), failedScan)).toMatchObject({ approved: false, reasonCode: 'transcript_scan_failed' });
    expectRecordedRefusal(repository, 'transcript_scan_failed');
    database.close();
  });

  it('refuses and records an empty transcript scan', () => {
    const { database, repository, item } = seed();
    const emptyScan: AutonomousGovernorDependencies = {
      scanUsage: () => ({ freshInputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, totalTrafficTokens: 0, samples: 0, scannedFiles: 0, error: null }),
    };
    expect(evaluateAutonomousDispatch(repository, request(item.id), emptyScan)).toMatchObject({ approved: false, reasonCode: 'transcript_scan_empty' });
    expectRecordedRefusal(repository, 'transcript_scan_empty');
    database.close();
  });

  it('refuses and records an inconsistent reset date', () => {
    const { database, repository, item } = seed(':memory:', { resetsAt: null });
    expect(evaluateAutonomousDispatch(repository, request(item.id), successfulScan)).toMatchObject({ approved: false, reasonCode: 'reset_date_inconsistent' });
    expectRecordedRefusal(repository, 'reset_date_inconsistent');
    database.close();
  });

  it('rejects and records Opus before any reservation is created', () => {
    const { database, repository, item } = seed();
    expect(evaluateAutonomousDispatch(repository, request(item.id, { model: 'opus', executionProfile: 'deep' }), successfulScan))
      .toMatchObject({ approved: false, reasonCode: 'model_not_allowed', reason: expect.stringMatching(/haiku, sonnet only/i) });
    expect(repository.heldBudgetReservationSet('claude', '2026-08-23T12:00:00.000Z')).toBe(0);
    expectRecordedRefusal(repository, 'model_not_allowed');
    database.close();
  });

  it('refuses a second autonomous dispatch while the first is queued and records the reason', () => {
    const { database, repository, item } = seed();
    repository.createRun(item.id, 'analysis', 'claude', 'claude', '', null, null, 'autonomous');

    expect(evaluateAutonomousDispatch(repository, request(item.id), successfulScan))
      .toMatchObject({ approved: false, reasonCode: 'active_run', reason: expect.stringMatching(/already active/i) });
    expectRecordedRefusal(repository, 'active_run');
    database.close();
  });

  it('refuses and records when spent plus held cannot fit the historical estimate under the 16% target', () => {
    const { database, repository, item } = seed(':memory:', { ceiling: 500, historyTokens: 100 });
    expect(evaluateAutonomousDispatch(repository, request(item.id), successfulScan)).toMatchObject({ approved: false, reasonCode: 'budget_exhausted' });
    expectRecordedRefusal(repository, 'budget_exhausted');
    database.close();
  });

  it('uses the completed agent+model historical average and records an atomic hold', () => {
    const { database, repository, item } = seed();
    const decision = evaluateAutonomousDispatch(repository, request(item.id, { executionProfile: 'deep' }), successfulScan);
    expect(decision).toMatchObject({
      approved: true, agent: 'claude', model: 'sonnet', executionProfile: 'deep',
      reservedSet: 100, reservationId: expect.any(String), windowStart: '2026-08-23T12:00:00.000Z', windowEnd: resetAt,
    });
    expect(repository.heldBudgetReservationSet('claude', '2026-08-23T12:00:00.000Z')).toBe(100);
    expect(repository.listAutonomyGovernorDecisions(1)[0]).toMatchObject({ outcome: 'allowed', reasonCode: 'reserved', estimatedSet: 100 });
    database.close();
  });

  it('allows only one of two callers sharing the same remaining allowance across database connections', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'workbench-governor-'));
    const path = join(temporaryDirectory, 'workbench.db');
    const first = seed(path);
    const secondDatabase = openDatabase(path);
    const secondRepository = new WorkItemRepository(secondDatabase);
    const secondItem = secondRepository.create({ title: 'Second candidate', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });

    const decisions = await Promise.all([
      Promise.resolve().then(() => evaluateAutonomousDispatch(first.repository, request(first.item.id), successfulScan)),
      Promise.resolve().then(() => evaluateAutonomousDispatch(secondRepository, request(secondItem.id), successfulScan)),
    ]);

    expect(decisions.filter((decision) => decision.approved)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.approved)).toEqual([expect.objectContaining({ reasonCode: 'budget_exhausted' })]);
    expect(first.repository.heldBudgetReservationSet('claude', '2026-08-23T12:00:00.000Z')).toBe(100);
    secondDatabase.close();
    first.database.close();
  });

  it('reconciles a held estimate to terminal run usage and reports the stored alarm threshold', () => {
    const { database, repository, item } = seed();
    const decision = evaluateAutonomousDispatch(repository, request(item.id), successfulScan);
    if (!decision.approved) throw new Error('expected approval');
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', '', null, null, 'autonomous');
    repository.updateRun(run.id, { status: 'completed', completedAt: now.toISOString(), model: 'sonnet', inputTokens: 250, outputTokens: 0 });
    expect(repository.attachBudgetReservationToRun(decision.reservationId, run.id)).toBe(true);

    expect(repository.reconcileAutonomousBudget(run.id, now.toISOString())).toEqual({ actualSet: 250, alarmTriggered: true });
    expect(database.prepare('SELECT status, reserved_set, actual_set, alarm_triggered FROM budget_reservations WHERE id = ?').get(decision.reservationId))
      .toEqual({ status: 'committed', reserved_set: 100, actual_set: 250, alarm_triggered: 1 });
    expect(repository.heldBudgetReservationSet('claude', decision.windowStart)).toBe(0);
    database.close();
  });
});
