import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
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
  capabilityFile: string;
  eventFile: string;
};

/** Key naming the turn that wrote the file; its value is not a date, so the guard script never treats it as a grant. */
export const CAPABILITY_OWNER_KEY = '__turnId';

/** `turnId` records the writing turn so only that turn may clear the file (clearTurnCapability). */
export function writeTurnCapability(guard: ExternalActionProcessGuard, capability: Record<string, string>, turnId?: string): void {
  const temporaryFile = `${guard.capabilityFile}.${process.pid}.tmp`;
  const serialized = turnId ? { ...capability, [CAPABILITY_OWNER_KEY]: turnId } : capability;
  writeFileSync(temporaryFile, JSON.stringify(serialized), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryFile, guard.capabilityFile);
  guard.capability = { ...capability };
}

function capabilityOwner(guard: ExternalActionProcessGuard): string | null {
  try {
    const owner = (JSON.parse(readFileSync(guard.capabilityFile, 'utf8')) as Record<string, unknown>)[CAPABILITY_OWNER_KEY];
    return typeof owner === 'string' ? owner : null;
  } catch {
    return null;
  }
}

/** With `turnId`, a file written by a different turn is left alone. */
export function clearTurnCapability(guard: ExternalActionProcessGuard, turnId?: string): void {
  if (turnId && capabilityOwner(guard) !== turnId) return;
  writeTurnCapability(guard, {});
}

/** The capability file contents for one turn: each granted action with its expiry. */
export function turnCapabilityFor(authorization: ExternalActionAuthorization): Record<string, string> {
  const fallbackExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
  return authorization.granted
    ? Object.fromEntries(authorization.capability.actionIds.map((id) => [id, authorization.capability.expiresAtByAction?.[id] ?? fallbackExpiry]))
    : {};
}

export function createExternalActionProcessGuard(authorization: ExternalActionAuthorization): ExternalActionProcessGuard {
  const directory = mkdtempSync(join(tmpdir(), 'workbench-external-action-'));
  const capabilityFile = join(directory, 'capability.json');
  const eventFile = join(directory, 'refusals.jsonl');
  closeSync(openSync(eventFile, 'wx', 0o600));
  const capability = turnCapabilityFor(authorization);
  const guard = { capability, capabilityFile, eventFile };
  writeTurnCapability(guard, capability);
  return guard;
}

export function externalActionGuardEnvironment(guard?: ExternalActionProcessGuard): NodeJS.ProcessEnv {
  if (!guard) return { WORKBENCH_EXTERNAL_CAPABILITY: '{}' };
  return {
    WORKBENCH_EXTERNAL_CAPABILITY_FILE: guard.capabilityFile,
    WORKBENCH_EXTERNAL_ACTION_EVENT_FILE: guard.eventFile,
  };
}

/**
 * `persistent` is for a guard whose directory outlives the turn (a session
 * host's): only lines written after this call are reported, and the directory
 * is left in place.
 */
export function observeExternalActionRefusals(guard: ExternalActionProcessGuard, onRefusal: (refusal: ExternalActionRefusal) => void, options: { persistent?: boolean } = {}): () => void {
  let consumedLines = options.persistent ? readFileSync(guard.eventFile, 'utf8').split('\n').filter(Boolean).length : 0;
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
    if (!options.persistent) rmSync(dirname(guard.eventFile), { recursive: true, force: true });
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
