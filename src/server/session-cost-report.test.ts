import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSessionCostReport, formatSessionCostReport } from '../../scripts/session-cost-report.js';
import { openDatabase } from './database.js';
import { WorkItemRepository } from './repository.js';
import type { AgentRunPromptSize } from '../shared/contracts.js';

const size = (overrides: Partial<AgentRunPromptSize>): AgentRunPromptSize => ({
  totalChars: 1_000, systemContractChars: 100, personaChars: 0, taskDescriptionChars: 0, strategyChars: 0, conversationHistoryChars: 0, shortTermMemoryChars: 0,
  durablePrefetchChars: 0, connectionContextChars: 0, repoRoutingBlockChars: 0, envelopeChars: 100, sessionMode: 'per_run', sessionStartup: false, ...overrides,
});

describe('session cost report', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

  it('groups runs by session mode and reports prompt chars, cache-read ratio, and time to first activity', () => {
    root = mkdtempSync(join(tmpdir(), 'workbench-cost-report-'));
    const path = join(root, 'workbench.db');
    const database = openDatabase(path);
    const repository = new WorkItemRepository(database);
    const item = repository.create({ title: 'Cost', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const record = (promptSize: AgentRunPromptSize, tokens: [number, number, number, number], startedAt: string, activityAt: string) => {
      const run = repository.createRun(item.id, 'analysis', 'claude', 'claude', '');
      repository.updateRun(run.id, { promptSize, startedAt, inputTokens: tokens[0], cacheCreationInputTokens: tokens[1], cacheReadInputTokens: tokens[2], outputTokens: tokens[3] });
      repository.addAgentRunDiagnostic(run.id, null, 'claude', 'prompt', {});
      database.prepare("UPDATE agent_run_diagnostics SET created_at = ? WHERE run_id = ? AND kind = 'prompt'").run(startedAt, run.id);
      repository.addAgentRunDiagnostic(run.id, null, 'claude', 'tool', {});
      database.prepare("UPDATE agent_run_diagnostics SET created_at = ? WHERE run_id = ? AND kind = 'tool'").run(activityAt, run.id);
    };
    record(size({ totalChars: 20_000, envelopeChars: 3_000, sessionMode: 'persistent', sessionStartup: true }), [10, 1_000, 0, 50], '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:06.000Z');
    record(size({ totalChars: 400, envelopeChars: 400, sessionMode: 'persistent' }), [10, 0, 990, 50], '2026-10-01T00:01:00.000Z', '2026-10-01T00:01:01.000Z');
    record(size({ totalChars: 20_000, envelopeChars: 3_000 }), [100, 900, 0, 70], '2026-10-01T00:02:00.000Z', '2026-10-01T00:02:09.000Z');
    database.close();

    const readOnly = new DatabaseSync(path, { readOnly: true });
    const groups = buildSessionCostReport(readOnly);
    readOnly.close();
    const persistent = groups.find((group) => group.sessionMode === 'persistent')!;
    const perRun = groups.find((group) => group.sessionMode === 'per_run')!;

    expect(persistent).toMatchObject({ turns: 2, startupTurns: 1, avgPromptChars: 10_200, avgEnvelopeChars: 1_700, outputTokens: 100, avgSecondsToFirstActivity: 3.5 });
    expect(persistent.cacheReadRatio).toBeCloseTo(990 / 2_010);
    expect(perRun).toMatchObject({ turns: 1, startupTurns: 0, avgPromptChars: 20_000, avgSecondsToFirstActivity: 9, cacheReadRatio: 0 });
    const text = formatSessionCostReport(groups);
    expect(text).toContain('persistent: 2 turn(s), 1 that spawned the process');
    expect(text).toContain('per_run: 1 turn(s), 0 that spawned the process');
    expect(text).toContain('cache-read ratio             49.3%');
  });

  it('measures session and per-run time to first activity from the earliest diagnostic', () => {
    root = mkdtempSync(join(tmpdir(), 'workbench-cost-report-'));
    const path = join(root, 'workbench.db');
    const database = openDatabase(path);
    const repository = new WorkItemRepository(database);
    const item = repository.create({ title: 'Cost', description: '', priority: 1, status: 'ready', projectName: null, workspacePath: null, dueDate: null });
    const startedAt = '2026-10-01T00:00:00.000Z';
    const diagnostic = (runId: string, kind: 'tool' | 'usage', at: string) => {
      repository.addAgentRunDiagnostic(runId, null, 'claude', kind, {});
      database.prepare('UPDATE agent_run_diagnostics SET created_at = ? WHERE run_id = ? AND kind = ? AND created_at = (SELECT MAX(created_at) FROM agent_run_diagnostics WHERE run_id = ? AND kind = ?)').run(at, runId, kind, runId, kind);
    };
    const session = repository.createRun(item.id, 'analysis', 'claude', 'claude', '');
    repository.updateRun(session.id, { promptSize: size({ sessionMode: 'persistent' }), startedAt });
    diagnostic(session.id, 'tool', '2026-10-01T00:00:00.400Z');
    diagnostic(session.id, 'usage', '2026-10-01T00:00:09.000Z');
    const perRun = repository.createRun(item.id, 'analysis', 'claude', 'claude', '');
    repository.updateRun(perRun.id, { promptSize: size({}), startedAt });
    diagnostic(perRun.id, 'usage', '2026-10-01T00:00:00.500Z');
    database.close();

    const readOnly = new DatabaseSync(path, { readOnly: true });
    const groups = buildSessionCostReport(readOnly);
    readOnly.close();
    expect(groups.find((group) => group.sessionMode === 'persistent')!.avgSecondsToFirstActivity).toBeCloseTo(0.4);
    expect(groups.find((group) => group.sessionMode === 'per_run')!.avgSecondsToFirstActivity).toBeCloseTo(0.5);
  });
});
