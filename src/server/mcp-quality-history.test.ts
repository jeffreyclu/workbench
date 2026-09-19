import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendMcpQualityRun, defaultMcpQualityHistoryPath, readMcpQualityHistory } from './mcp-quality-history.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('MCP quality history', () => {
  it('reads shared runtime data from the stable Workbench root', () => {
    expect(defaultMcpQualityHistoryPath()).toBe(join(process.cwd(), 'data', 'mcpjam', 'history.jsonl'));
  });

  it('returns an empty state before the first check', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-mcp-history-'));
    directories.push(directory);
    expect(readMcpQualityHistory(join(directory, 'history.jsonl'))).toEqual({
      status: 'empty', latest: null, runs: [],
      automation: { enabled: false, running: false, cadenceHours: 24, nextRunAt: null, lastError: null },
      details: { hosts: [], tools: [], checks: [] },
    });
  });

  it('keeps newest checks first and reports the latest failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-mcp-history-'));
    directories.push(directory);
    const path = join(directory, 'history.jsonl');
    appendMcpQualityRun({ id: 'pass', checkedAt: '2026-09-18T10:00:00.000Z', status: 'passed', source: 'local', revision: 'abc1234', durationMs: 400, protocolScore: 100, compatibleHosts: 2, toolProbes: 50, totalTools: 50, breakingChanges: 0, failure: null }, path);
    appendMcpQualityRun({ id: 'fail', checkedAt: '2026-09-18T11:00:00.000Z', status: 'failed', source: 'promotion', revision: 'def5678', durationMs: 900, protocolScore: 100, compatibleHosts: 2, toolProbes: null, totalTools: 50, breakingChanges: 0, failure: 'A tool probe failed.' }, path);

    const history = readMcpQualityHistory(path);
    expect(history.status).toBe('degraded');
    expect(history.latest?.id).toBe('fail');
    expect(history.runs.map((run) => run.id)).toEqual(['fail', 'pass']);
  });

  it('ignores a partially written line without hiding valid history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-mcp-history-'));
    directories.push(directory);
    const path = join(directory, 'history.jsonl');
    writeFileSync(path, '{"incomplete":\n');
    appendMcpQualityRun({ id: 'pass', checkedAt: '2026-09-18T10:00:00.000Z', status: 'passed', source: 'ci', revision: null, durationMs: 300, protocolScore: 100, compatibleHosts: 2, toolProbes: 50, totalTools: 50, breakingChanges: 0, failure: null }, path);

    expect(readMcpQualityHistory(path).runs.map((run) => run.id)).toEqual(['pass']);
  });
});
