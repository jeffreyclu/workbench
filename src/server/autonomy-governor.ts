import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentRun, UsageCalibration } from '../shared/contracts.js';
import { scanClaudeLocalUsage, scanCodexLocalUsage, type LocalUsageTotals } from './local-usage.js';
import type { WorkItemRepository } from './repository.js';
import { currentUsageCalibration } from './usage-meter.js';

/** The only model tiers an autonomous caller may request. Effort may rise; model tier may not. */
export const AUTONOMOUS_MODEL_ALLOWLIST = ['haiku', 'sonnet'] as const;
export type AutonomousModel = typeof AUTONOMOUS_MODEL_ALLOWLIST[number];
const ALLOWED_MODELS = new Set<string>(AUTONOMOUS_MODEL_ALLOWLIST);
const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

export type AutonomousRefusalCode =
  | 'invalid_origin'
  | 'kill_switch_off'
  | 'provider_disabled'
  | 'model_not_allowed'
  | 'active_run'
  | 'calibration_missing_or_stale'
  | 'transcript_scan_failed'
  | 'transcript_scan_empty'
  | 'reset_date_inconsistent'
  | 'missing_work_item'
  | 'cost_history_missing'
  | 'budget_exhausted';

export type AutonomousGovernorDecision =
  | {
    approved: true;
    agent: AgentRun['agent'];
    model: AutonomousModel;
    executionProfile: NonNullable<AgentRun['executionProfile']>;
    reservedSet: number;
    reservationId: string;
    windowStart: string;
    windowEnd: string;
  }
  | { approved: false; reasonCode: AutonomousRefusalCode; reason: string };

export interface AutonomousDispatchRequest {
  origin: AgentRun['origin'];
  provider: AgentRun['agent'];
  model: string;
  workItemId?: string;
  /** Reasoning effort is independent of the allowlisted model tier. */
  executionProfile?: NonNullable<AgentRun['executionProfile']>;
  now?: Date;
}

export interface AutonomousGovernorDependencies {
  scanUsage(provider: AgentRun['agent'], windowStart: Date, windowEnd: Date): LocalUsageTotals;
}

const defaultDependencies: AutonomousGovernorDependencies = {
  scanUsage(provider, windowStart, windowEnd) {
    if (provider === 'claude') return scanClaudeLocalUsage(windowStart, windowEnd, join(homedir(), '.claude', 'projects'));
    const codexRoot = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    return scanCodexLocalUsage(windowStart, windowEnd, join(codexRoot, 'sessions'));
  },
};

/**
 * Resolves the provider's current seven-day window from the reset date captured
 * by calibration. A stale weekly reset is rolled forward by whole weeks; a
 * missing, malformed, backwards, or non-weekly date fails closed.
 */
export function resolveProviderBudgetWindow(calibration: UsageCalibration, now: Date): { start: Date; end: Date } | null {
  const observedAt = new Date(calibration.observedAt);
  const recordedReset = calibration.resetsAt ? new Date(calibration.resetsAt) : null;
  if (!Number.isFinite(observedAt.getTime()) || !recordedReset || !Number.isFinite(recordedReset.getTime())) return null;
  const observedToReset = recordedReset.getTime() - observedAt.getTime();
  if (observedToReset <= 0 || observedToReset > WEEK_MS) return null;

  let endMs = recordedReset.getTime();
  if (endMs <= now.getTime()) endMs += Math.ceil((now.getTime() - endMs + 1) / WEEK_MS) * WEEK_MS;
  const startMs = endMs - WEEK_MS;
  if (now.getTime() < startMs || now.getTime() >= endMs || endMs - now.getTime() > WEEK_MS) return null;
  return { start: new Date(startMs), end: new Date(endMs) };
}

/**
 * The single phase-3a gate. It reads stored policy and measured usage, records
 * every refusal, and creates one atomic budget hold on approval. It never
 * creates a run, claims a task, invokes a provider, or spawns a process.
 */
export function evaluateAutonomousDispatch(
  repository: WorkItemRepository,
  request: AutonomousDispatchRequest,
  dependencies: AutonomousGovernorDependencies = defaultDependencies,
): AutonomousGovernorDecision {
  const { origin, provider, model, workItemId, executionProfile = 'standard', now = new Date() } = request;
  const refuse = (reasonCode: AutonomousRefusalCode, reason: string, estimatedSet: number | null = null): AutonomousGovernorDecision => {
    repository.recordAutonomyGovernorDecision({
      provider, model, workItemId: workItemId ?? null, outcome: 'refused', reasonCode, reason,
      estimatedSet, reservationId: null, createdAt: now.toISOString(),
    });
    return { approved: false, reasonCode, reason };
  };

  if (origin !== 'autonomous') return refuse('invalid_origin', `Invalid run origin for autonomous dispatch: '${origin}'.`);

  const policy = repository.getAutonomyPolicy();
  if (!policy.globalEnabled) return refuse('kill_switch_off', 'Autonomous dispatch is disabled by the stored global kill switch.');
  const providerPolicy = policy.providers[provider];
  if (!providerPolicy?.enabled) return refuse('provider_disabled', `Autonomous dispatch is disabled for provider '${provider}'.`);
  if (!ALLOWED_MODELS.has(model)) return refuse('model_not_allowed', `Model '${model}' is not on the autonomous allowlist (haiku, sonnet only).`);
  if (repository.activeAutonomousRunCount() > 0) return refuse('active_run', 'An autonomous run is already active.');

  const calibration = currentUsageCalibration(repository, provider, now);
  if (!calibration) return refuse('calibration_missing_or_stale', `${provider} usage calibration is missing or older than 14 days.`);
  const window = resolveProviderBudgetWindow(calibration, now);
  if (!window) return refuse('reset_date_inconsistent', `${provider} calibration has a missing or inconsistent weekly reset date.`);

  const scan = dependencies.scanUsage(provider, window.start, window.end);
  if (scan.error) return refuse('transcript_scan_failed', `${provider} transcript scan failed: ${scan.error}`);
  if (scan.scannedFiles === 0 || scan.samples === 0) return refuse('transcript_scan_empty', `${provider} transcript scan returned no usage samples for the current provider window.`);
  if (!workItemId) return refuse('missing_work_item', 'No candidate work item was supplied for the budget reservation.');

  const reservedSet = repository.averageSetEstimate(provider, model);
  if (reservedSet === null || !Number.isFinite(reservedSet) || reservedSet <= 0) {
    return refuse('cost_history_missing', `No completed ${provider}+${model} run history is available to estimate this dispatch.`);
  }

  const limit = providerPolicy.weeklyCeilingSet * policy.targetFraction;
  const reservation = repository.tryReserveAutonomousBudget({
    provider, model, workItemId, requiredTokenCount: reservedSet, budgetTokenLimit: limit,
    windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(), now: now.toISOString(),
  });
  if (!reservation.approved) {
    return refuse(
      'budget_exhausted',
      `Autonomous budget exhausted: ${Math.ceil(reservation.spentSet + reservation.heldSet)} SET spent or reserved of ${Math.floor(limit)} SET target.`,
      reservedSet,
    );
  }

  repository.recordAutonomyGovernorDecision({
    provider, model, workItemId, outcome: 'allowed', reasonCode: 'reserved', reason: 'Stored policy checks passed and budget was reserved atomically.',
    estimatedSet: reservedSet, reservationId: reservation.reservationId, createdAt: now.toISOString(),
  });
  return {
    approved: true, agent: provider, model: model as AutonomousModel, executionProfile,
    reservedSet, reservationId: reservation.reservationId,
    windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(),
  };
}
