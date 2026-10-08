import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExternalActionAuthorization } from './external-action-authorization.js';
import type { AgentRun } from '../shared/contracts.js';
import type { WorkItemRepository } from './repository.js';

export type ExternalActionRefusal = {
  detail: string;
  command: string;
  requiredCapability: string;
};

export type ExternalActionProcessGuard = {
  capability: Record<string, string>;
  eventFile: string;
};

export function createExternalActionProcessGuard(authorization: ExternalActionAuthorization): ExternalActionProcessGuard {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-external-action-'));
  const eventFile = join(directory, 'refusals.jsonl');
  closeSync(openSync(eventFile, 'wx', 0o600));
  const fallbackExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
  const capability = authorization.granted
    ? Object.fromEntries(authorization.capability.actionIds.map((id) => [id, authorization.capability.expiresAtByAction?.[id] ?? fallbackExpiry]))
    : {};
  return { capability, eventFile };
}

export function externalActionGuardEnvironment(guard?: ExternalActionProcessGuard): NodeJS.ProcessEnv {
  if (!guard) return { WORKBENCH_EXTERNAL_CAPABILITY: '{}' };
  return {
    WORKBENCH_EXTERNAL_CAPABILITY: JSON.stringify(guard.capability),
    WORKBENCH_EXTERNAL_ACTION_EVENT_FILE: guard.eventFile,
  };
}

export function observeExternalActionRefusals(guard: ExternalActionProcessGuard, onRefusal: (refusal: ExternalActionRefusal) => void): () => void {
  let consumedLines = 0;
  const drain = () => {
    const lines = readFileSync(guard.eventFile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(consumedLines)) {
      try { onRefusal(JSON.parse(line) as ExternalActionRefusal); } catch { /* Ignore incomplete or malformed child output. */ }
    }
    consumedLines = lines.length;
  };
  let watcher: FSWatcher | null = watch(guard.eventFile, drain);
  return () => {
    watcher?.close();
    watcher = null;
    drain();
    rmSync(dirname(guard.eventFile), { recursive: true, force: true });
  };
}

export function recordExternalActionRefusal(
  repository: WorkItemRepository,
  run: Pick<AgentRun, 'id' | 'messageId' | 'agent'>,
  refusal: ExternalActionRefusal,
): void {
  repository.addAgentRunDiagnostic(run.id, run.messageId ?? null, run.agent, 'tool', { category: 'agent_tool_use', kind: 'tool', detail: refusal.detail });
  if (run.messageId) repository.addAgentStreamEvents(run.messageId, run.id, [{ kind: 'tool', detail: refusal.detail }]);
}
