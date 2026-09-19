import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { McpQualityAutomationStatus } from '../shared/contracts.js';
import type { WorkItemRepository } from './repository.js';
import { OWNER_ID } from './scheduler.js';

export const MCP_QUALITY_CADENCE_MS = 24 * 60 * 60 * 1_000;
export const MCP_QUALITY_RETRY_MS = 60 * 60 * 1_000;
const IDLE_RECHECK_MS = 5 * 60 * 1_000;
const POLL_MS = 60 * 1_000;

let status: McpQualityAutomationStatus = {
  enabled: false,
  running: false,
  cadenceHours: 24,
  nextRunAt: null,
  lastError: null,
};

export function getMcpQualityAutomationStatus(): McpQualityAutomationStatus {
  return { ...status };
}

export function nextMcpQualityRunAt(latest: { checkedAt: string; status: 'passed' | 'failed' } | null, now = Date.now()): number {
  if (!latest) return now;
  const checkedAt = Date.parse(latest.checkedAt);
  if (!Number.isFinite(checkedAt)) return now;
  return checkedAt + (latest.status === 'failed' ? MCP_QUALITY_RETRY_MS : MCP_QUALITY_CADENCE_MS);
}

export function startMcpQualityMonitor(
  repository: WorkItemRepository,
  options: {
    now?: () => number;
    latest?: () => { checkedAt: string; status: 'passed' | 'failed' } | null;
    spawnCheck?: () => ChildProcess;
    pollMs?: number;
  } = {},
): { stop: () => void; checkNow: () => void } {
  const now = options.now ?? Date.now;
  const latest = options.latest ?? (() => {
    // Lazy import is unnecessary here: the history file is deliberately read by
    // the caller injected from index.ts so this module remains easy to test.
    return null;
  });
  const spawnCheck = options.spawnCheck ?? (() => spawn(process.execPath, ['--import', 'tsx', join(process.cwd(), 'scripts', 'mcpjam-check.ts')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_QUALITY_SOURCE: 'scheduled',
      MCP_QUALITY_ARTIFACT_DIRECTORY: join(process.cwd(), 'data', 'mcpjam', 'scheduled-latest'),
    },
    detached: true,
    stdio: 'ignore',
  }));
  let stopped = false;
  let child: ChildProcess | null = null;
  let nextAt = nextMcpQualityRunAt(latest(), now());
  status = { enabled: true, running: false, cadenceHours: 24, nextRunAt: new Date(nextAt).toISOString(), lastError: null };

  const checkNow = () => {
    if (stopped || child || now() < nextAt) return;
    if (repository.hasRuntimeWork(OWNER_ID) || repository.hasOwnedAgentWork(OWNER_ID)) {
      nextAt = now() + IDLE_RECHECK_MS;
      status = { ...status, nextRunAt: new Date(nextAt).toISOString() };
      return;
    }
    try {
      child = spawnCheck();
      child.unref();
      status = { ...status, running: true, nextRunAt: null, lastError: null };
      child.once('error', (error) => {
        child = null;
        nextAt = now() + MCP_QUALITY_RETRY_MS;
        status = { ...status, running: false, nextRunAt: new Date(nextAt).toISOString(), lastError: error.message };
      });
      child.once('exit', (code, signal) => {
        child = null;
        const passed = code === 0;
        nextAt = now() + (passed ? MCP_QUALITY_CADENCE_MS : MCP_QUALITY_RETRY_MS);
        status = {
          ...status,
          running: false,
          nextRunAt: new Date(nextAt).toISOString(),
          lastError: passed ? null : `Automatic MCPJam check exited ${signal ? `on ${signal}` : `with code ${code ?? 'unknown'}`}.`,
        };
      });
    } catch (error) {
      nextAt = now() + MCP_QUALITY_RETRY_MS;
      status = { ...status, running: false, nextRunAt: new Date(nextAt).toISOString(), lastError: error instanceof Error ? error.message : String(error) };
    }
  };

  checkNow();
  const timer = setInterval(checkNow, options.pollMs ?? POLL_MS);
  timer.unref();
  return {
    checkNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      status = { ...status, enabled: false, running: false, nextRunAt: null };
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { /* It already exited. */ }
      }
      child = null;
    },
  };
}
