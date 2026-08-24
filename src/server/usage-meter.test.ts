import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import { AUTONOMOUS_TARGET_FRACTION, CALIBRATION_MAX_AGE_DAYS, CLAUDE_PESSIMISTIC_CEILING_SET, computeWeeklyUsageReport, computeWorkbenchUsage, currentUsageCalibration, recordUsageCalibration, scanClaudeInteractiveUsage, startOfIsoWeekUtc } from './usage-meter.js';

describe('startOfIsoWeekUtc', () => {
  it('returns the preceding Monday 00:00 UTC', () => {
    expect(startOfIsoWeekUtc(new Date('2026-08-23T15:00:00.000Z')).toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(startOfIsoWeekUtc(new Date('2026-08-17T00:00:00.000Z')).toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });
});

describe('computeWorkbenchUsage', () => {
  let directory: string;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function seed() {
    directory = mkdtempSync(join(tmpdir(), 'workbench-usage-test-'));
    const database = openDatabase(join(directory, 'workbench.db'));
    const repository = new WorkItemRepository(database);
    const item = repository.create({
      title: 'Task', description: '', priority: 2, status: 'backlog',
      projectName: null, workspacePath: null, dueDate: null,
    });
    return { repository, item };
  }

  it('splits manual and autonomous SET by provider, excluding runs before the week starts', () => {
    const { repository, item } = seed();
    const weekStart = new Date('2026-08-17T00:00:00.000Z');

    const manualRun = repository.createRun(item.id, 'execute', 'claude', 'claude', '', null, null, 'manual');
    repository.updateRun(manualRun.id, { model: 'sonnet', inputTokens: 1000, outputTokens: 100 });

    const autonomousRun = repository.createRun(item.id, 'execute', 'claude', 'claude', '', null, null, 'autonomous');
    repository.updateRun(autonomousRun.id, { model: 'haiku', inputTokens: 2000, outputTokens: 200 });

    const codexRun = repository.createRun(item.id, 'execute', 'codex', 'codex', '', null, null, 'manual');
    repository.updateRun(codexRun.id, { model: 'gpt-5.6-terra', inputTokens: 500, outputTokens: 50 });

    const usage = computeWorkbenchUsage(repository, weekStart);

    expect(usage.claude.manual.inputTokens).toBe(1000);
    expect(usage.claude.manual.outputTokens).toBe(100);
    // Sonnet tier multiplier is 1: SET = 1000*1 + 100*5 = 1500.
    expect(usage.claude.manual.setTokens).toBeCloseTo(1500, 5);
    expect(usage.claude.manual.runCount).toBe(1);

    // Haiku tier multiplier is 5/15 = 0.3333...: SET = 0.3333*(2000*1 + 200*5) = 1000.
    expect(usage.claude.autonomous.setTokens).toBeCloseTo(1000, 1);
    expect(usage.claude.autonomous.runCount).toBe(1);

    expect(usage.codex.manual.runCount).toBe(1);
    expect(usage.codex.autonomous.runCount).toBe(0);
  });

  it('excludes runs created before the week window', () => {
    const { repository, item } = seed();
    repository.createRun(item.id, 'execute', 'claude', 'claude', '');
    // No run can predate "now", so a week window starting after every run must exclude all of them.
    const futureWeekStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const usage = computeWorkbenchUsage(repository, futureWeekStart);
    expect(usage.claude.manual.runCount).toBe(0);
    expect(usage.claude.autonomous.runCount).toBe(0);
  });

  it('defaults every run to manual origin, matching migration 021', () => {
    const { repository, item } = seed();
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', '');
    expect(run.origin).toBe('manual');
  });
});

describe('computeWeeklyUsageReport', () => {
  let directory: string;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  it('reports the pessimistic Claude ceiling and a null Codex ceiling, with the 20% autonomous slice', () => {
    directory = mkdtempSync(join(tmpdir(), 'workbench-usage-report-test-'));
    const database = openDatabase(join(directory, 'workbench.db'));
    const repository = new WorkItemRepository(database);

    const report = computeWeeklyUsageReport(repository, new Date('2026-08-23T15:00:00.000Z'));

    expect(report.claude.ceilingSet).toBe(CLAUDE_PESSIMISTIC_CEILING_SET);
    expect(report.codex.ceilingSet).toBeNull();
    expect(report.autonomousSliceFraction).toBe(0.2);
    expect(report.autonomousTargetFraction).toBe(AUTONOMOUS_TARGET_FRACTION);
    expect(report.autonomousTargetFraction).toBe(0.16);
  });
});

describe('recordUsageCalibration / currentUsageCalibration', () => {
  let directory: string;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  function seed() {
    directory = mkdtempSync(join(tmpdir(), 'workbench-calibration-test-'));
    const database = openDatabase(join(directory, 'workbench.db'));
    return new WorkItemRepository(database);
  }

  it('solves for the ceiling from this week\'s SET and the observed percentage, then replaces the pessimistic ceiling', () => {
    const repository = seed();
    const item = repository.create({
      title: 'Task', description: '', priority: 2, status: 'backlog',
      projectName: null, workspacePath: null, dueDate: null,
    });
    const observedAt = '2026-08-19T12:00:00.000Z'; // Wednesday, week of 2026-08-17
    const run = repository.createRun(item.id, 'execute', 'claude', 'claude', '', null, null, 'manual');
    // Sonnet multiplier 1: SET = 10000*1 + 1000*5 = 15000.
    repository.updateRun(run.id, { model: 'sonnet', inputTokens: 10000, outputTokens: 1000 });

    const calibration = recordUsageCalibration(repository, 'claude', observedAt, 10);

    expect(calibration.workbenchSet).toBeCloseTo(15000, 5);
    // interactiveSet comes from this machine's real ~/.claude/projects transcripts, so its exact
    // value is environment-dependent; only the ceiling formula's shape is asserted here.
    expect(calibration.interactiveSet).toBeGreaterThanOrEqual(0);
    expect(calibration.computedCeilingSet).toBeCloseTo((calibration.workbenchSet + calibration.interactiveSet) / 0.1, 5);

    const now = new Date('2026-08-20T00:00:00.000Z');
    const report = computeWeeklyUsageReport(repository, now);
    expect(report.claude.ceilingSet).toBeCloseTo(calibration.computedCeilingSet, 5);
    expect(report.claude.ceilingSet).not.toBe(CLAUDE_PESSIMISTIC_CEILING_SET);
    expect(report.claude.calibration?.id).toBe(calibration.id);
  });

  it('reads Codex calibrations the same way as Claude, replacing the null ceiling', () => {
    const repository = seed();
    const item = repository.create({
      title: 'Task', description: '', priority: 2, status: 'backlog',
      projectName: null, workspacePath: null, dueDate: null,
    });
    const observedAt = '2026-08-19T12:00:00.000Z'; // Wednesday, week of 2026-08-17
    const run = repository.createRun(item.id, 'execute', 'codex', 'codex', '', null, null, 'manual');
    repository.updateRun(run.id, { model: 'gpt-5', inputTokens: 10000, outputTokens: 1000 });

    const calibration = recordUsageCalibration(repository, 'codex', observedAt, 10);

    const now = new Date('2026-08-20T00:00:00.000Z');
    const report = computeWeeklyUsageReport(repository, now);
    expect(report.codex.ceilingSet).toBeCloseTo(calibration.computedCeilingSet, 5);
    expect(report.codex.ceilingSet).not.toBeNull();
    expect(report.codex.calibration?.id).toBe(calibration.id);
  });

  it('falls back to the pessimistic ceiling once the calibration is older than the max age', () => {
    const repository = seed();
    const observedAt = new Date('2026-08-01T00:00:00.000Z');
    recordUsageCalibration(repository, 'claude', observedAt.toISOString(), 50);

    const staleNow = new Date(observedAt.getTime() + (CALIBRATION_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(currentUsageCalibration(repository, 'claude', staleNow)).toBeNull();

    const report = computeWeeklyUsageReport(repository, staleNow);
    expect(report.claude.ceilingSet).toBe(CLAUDE_PESSIMISTIC_CEILING_SET);
    expect(report.claude.calibration).toBeNull();
  });

  it('uses the newest calibration when several have been recorded', () => {
    const repository = seed();
    recordUsageCalibration(repository, 'claude', '2026-08-17T00:00:00.000Z', 50);
    const latest = recordUsageCalibration(repository, 'claude', '2026-08-19T00:00:00.000Z', 25);

    const now = new Date('2026-08-20T00:00:00.000Z');
    const found = currentUsageCalibration(repository, 'claude', now);
    expect(found?.id).toBe(latest.id);
  });
});

describe('scanClaudeInteractiveUsage', () => {
  let root: string;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('sums SET from transcript usage samples within the week and ignores samples outside it', () => {
    root = mkdtempSync(join(tmpdir(), 'claude-projects-test-'));
    const projectDir = join(root, 'project-a');
    mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, 'session.jsonl');
    const inWeek = { timestamp: '2026-08-19T12:00:00.000Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: 1000 } } };
    const beforeWeek = { timestamp: '2026-08-01T12:00:00.000Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 999999, output_tokens: 999999 } } };
    writeFileSync(file, `${JSON.stringify(inWeek)}\n${JSON.stringify(beforeWeek)}\n`);
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);

    const weekStart = new Date('2026-08-17T00:00:00.000Z');
    const weekEnd = new Date('2026-08-24T00:00:00.000Z');
    const result = scanClaudeInteractiveUsage(weekStart, weekEnd, root);

    // Sonnet multiplier 1: SET = 100*1 + 40*1.25 + 1000*0.1 + 10*5 = 100+50+100+50 = 300.
    expect(result.setTokens).toBeCloseTo(300, 5);
    expect(result.scannedFiles).toBe(1);
    expect(result.unreadableFiles).toBe(0);
  });

  it('returns zeroed totals when the transcripts directory does not exist', () => {
    const result = scanClaudeInteractiveUsage(new Date('2026-08-17T00:00:00.000Z'), new Date('2026-08-24T00:00:00.000Z'), join(tmpdir(), 'does-not-exist-usage-meter'));
    expect(result).toEqual({ setTokens: 0, scannedFiles: 0, unreadableFiles: 0 });
  });
});
