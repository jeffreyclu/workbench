import { AUTONOMOUS_SLICE_FRACTION, computeWeeklyUsageReport, currentUsageCalibration, startOfIsoWeekUtc } from './usage-meter.js';
import type { WorkItemRepository } from './repository.js';
import type { AgentRun } from '../shared/contracts.js';

/** The only model tiers autonomous execution may reserve. No Opus or higher — see task 3a constraints. */
export const AUTONOMOUS_MODEL_ALLOWLIST = ['haiku', 'sonnet'] as const;
export type AutonomousModel = typeof AUTONOMOUS_MODEL_ALLOWLIST[number];
const ALLOWED_MODELS = new Set<string>(AUTONOMOUS_MODEL_ALLOWLIST);

export type AutonomousGovernorDecision =
  | { approved: true; agent: 'claude'; model: AutonomousModel; executionProfile: 'standard'; reservedSet: number; reservationId: string }
  | { approved: false; reason: string };

/**
 * The governor is deliberately fail-closed. The environment switch is the
 * emergency kill switch: an unset value is disabled, and no autonomous run can
 * reach agent execution before this function has approved and reserved budget.
 */
export function autonomousDispatchEnabled(environment = process.env): boolean {
  return environment.WORKBENCH_AUTONOMY_ENABLED === 'true'
    && environment.WORKBENCH_AUTONOMY_CLAUDE_ENABLED !== 'false';
}

export interface AutonomousDispatchRequest {
  /** Distinguishes a manual (human-triggered) run from one the autonomous dispatcher is trying to start. Only 'autonomous' can be approved here. */
  origin: AgentRun['origin'];
  model: string;
  /** The candidate task this dispatch would claim. Required to atomically hold its reservation; omit only when probing refusal paths that never reach the hold. */
  workItemId?: string;
  now?: Date;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Pure decision gate: no task claim, no run creation, no AI calls. The only
 * side effect is the atomic token hold on approval, made via a single
 * transactional repository call so a concurrent caller cannot double-spend
 * the same budget slice.
 */
export function evaluateAutonomousDispatch(repository: WorkItemRepository, request: AutonomousDispatchRequest): AutonomousGovernorDecision {
  const { origin, model, workItemId, now = new Date(), environment = process.env } = request;

  if (origin !== 'autonomous') return { approved: false, reason: `Invalid run origin for autonomous dispatch: '${origin}'.` };
  if (!autonomousDispatchEnabled(environment)) return { approved: false, reason: 'Autonomous dispatch is disabled by the kill switch.' };
  if (!ALLOWED_MODELS.has(model)) return { approved: false, reason: `Model '${model}' is not on the autonomous allowlist (haiku, sonnet only).` };
  if (repository.activeAutonomousRunCount() > 0) return { approved: false, reason: 'An autonomous run is already active.' };

  // Phase 3 currently dispatches Claude only. Codex has no reported ceiling yet,
  // so treating it as eligible would make the budget gate an illusion.
  const calibration = currentUsageCalibration(repository, 'claude', now);
  if (!calibration) return { approved: false, reason: 'Claude usage calibration is missing or stale.' };

  const report = computeWeeklyUsageReport(repository, now);
  const spent = report.claude.workbench.autonomous.setTokens;
  const reservedSet = repository.averageSetEstimate('claude', model) ?? 100_000;
  const limit = calibration.computedCeilingSet * AUTONOMOUS_SLICE_FRACTION;
  const windowStart = startOfIsoWeekUtc(now).toISOString();

  if (!workItemId) return { approved: false, reason: 'No candidate work item to reserve a hold against.' };

  const reservation = repository.tryReserveAutonomousBudget({
    provider: 'claude', model, workItemId, requiredTokenCount: reservedSet,
    spentTokenCount: spent, budgetTokenLimit: limit, windowStart, now: now.toISOString(),
  });
  if (!reservation) {
    const held = repository.heldBudgetReservationSet('claude', windowStart);
    return { approved: false, reason: `Autonomous budget exhausted: ${Math.ceil(spent + held)} SET spent or reserved of ${Math.floor(limit)} SET.` };
  }
  return { approved: true, agent: 'claude', model: model as AutonomousModel, executionProfile: 'standard', reservedSet, reservationId: reservation.reservationId };
}
