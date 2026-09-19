import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_QUALITY_CADENCE_MS, MCP_QUALITY_RETRY_MS, getMcpQualityAutomationStatus, nextMcpQualityRunAt, startMcpQualityMonitor } from './mcp-quality-monitor.js';
import type { WorkItemRepository } from './repository.js';

const monitors: Array<{ stop: () => void }> = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.restoreAllMocks();
});

function repository(busy = false): WorkItemRepository {
  return {
    hasRuntimeWork: vi.fn(() => busy),
    hasOwnedAgentWork: vi.fn(() => busy),
  } as unknown as WorkItemRepository;
}

function child(): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  process.unref = vi.fn(() => process);
  Object.defineProperty(process, 'pid', { value: 42 });
  return process;
}

describe('automatic MCP quality monitor', () => {
  it('schedules healthy checks once per day', () => {
    const now = Date.parse('2026-09-18T12:00:00.000Z');
    expect(nextMcpQualityRunAt({ checkedAt: '2026-09-18T10:00:00.000Z', status: 'passed' }, now))
      .toBe(Date.parse('2026-09-18T10:00:00.000Z') + MCP_QUALITY_CADENCE_MS);
    expect(nextMcpQualityRunAt({ checkedAt: '2026-09-18T10:00:00.000Z', status: 'failed' }, now))
      .toBe(Date.parse('2026-09-18T10:00:00.000Z') + MCP_QUALITY_RETRY_MS);
  });

  it('starts a due check automatically when Workbench is idle', () => {
    const spawned = child();
    const spawnCheck = vi.fn(() => spawned);
    const monitor = startMcpQualityMonitor(repository(), { now: () => 1_000, latest: () => null, spawnCheck, pollMs: 1_000_000 });
    monitors.push(monitor);

    expect(spawnCheck).toHaveBeenCalledOnce();
    expect(getMcpQualityAutomationStatus()).toMatchObject({ enabled: true, running: true, nextRunAt: null });
    spawned.emit('exit', 0, null);
    expect(getMcpQualityAutomationStatus()).toMatchObject({ running: false, lastError: null });
  });

  it('waits instead of competing with active agent work', () => {
    const spawnCheck = vi.fn(() => child());
    const monitor = startMcpQualityMonitor(repository(true), { now: () => 1_000, latest: () => null, spawnCheck, pollMs: 1_000_000 });
    monitors.push(monitor);

    expect(spawnCheck).not.toHaveBeenCalled();
    expect(getMcpQualityAutomationStatus()).toMatchObject({ enabled: true, running: false });
    expect(Date.parse(getMcpQualityAutomationStatus().nextRunAt ?? '')).toBeGreaterThan(1_000);
  });
});
