import { classifyExecution } from './agent-runner.js';
import { evaluateAutonomousDispatch, type AutonomousGovernorDecision } from './autonomy-governor.js';
import type { AgentRun, WorkItem } from '../shared/contracts.js';
import type { WorkItemRepository } from './repository.js';

export type AutonomousDispatchResult =
  | { dispatched: true; item: WorkItem; run: AgentRun; reason: string }
  | { dispatched: false; reason: string };

/** Selects the first dispatchable item from the durable attention-stack order. */
function nextEligibleItem(repository: WorkItemRepository): WorkItem | null {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return repository.list().find((item) => (
    item.status === 'backlog' || item.status === 'ready'
  ) && !item.archivedAt
    && !item.machineProposed
    && !(item.machineProposalWindowStart && new Date(item.createdAt).getTime() >= sevenDaysAgo)
    && !item.assignees.includes('jeffrey')
    // A dependency link is an explicit instruction to wait, even after its
    // prerequisite has completed. Jeffrey clears it when the task is ready.
    && (item.blockedBy?.length ?? 0) === 0
    && repository.activeRunsForItem(item.id).length === 0) ?? null;
}

export function dispatchAutonomousWork(
  repository: WorkItemRepository,
  overrideDecision?: AutonomousGovernorDecision,
): AutonomousDispatchResult {
  const queued = repository.list().find((item) => (
    item.status === 'backlog' || item.status === 'ready'
  ) && !item.archivedAt && !item.assignees.includes('jeffrey')
    && (item.blockedBy?.length ?? 0) === 0 && repository.activeRunsForItem(item.id).length === 0) ?? null;
  if (queued?.machineProposalWindowStart && overrideDecision?.approved && repository.isMachineProposalCreatedInWindow(queued, overrideDecision.windowStart)) {
    return { dispatched: false, reason: 'Machine-proposed work cannot execute in the autonomous weekly window that created it.' };
  }
  const item = nextEligibleItem(repository);
  if (!item) return { dispatched: false, reason: 'No eligible backlog task is queued.' };

  // The governor decides (and atomically holds the budget) against this
  // specific candidate, so the hold and the claim never race apart.
  const decision = overrideDecision ?? evaluateAutonomousDispatch(repository, { origin: 'autonomous', provider: 'claude', model: 'sonnet', workItemId: item.id });
  if (!decision.approved) return { dispatched: false, reason: decision.reason };

  // The governor has reserved only a Claude Sonnet run. Do not reuse a manual
  // classification agent/profile, which might be Codex or autonomous-disallowed Opus.
  const classification = repository.getClassification(item.id) ?? repository.setClassification(item.id, classifyExecution(item));
  const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
  repository.createSharedMessage('system', `Autonomous dispatch: ${item.title}`, 'completed', conversation.id);
  const reply = repository.createSharedMessage(decision.agent, '', 'running', conversation.id);
  const run = repository.createRun(item.id, classification.kind, decision.agent, decision.agent, classification.instructions, conversation.id, reply.id, 'autonomous');
  repository.updateRun(run.id, { model: decision.model, executionProfile: decision.executionProfile });
  if (!overrideDecision && !repository.attachBudgetReservationToRun(decision.reservationId, run.id)) {
    throw new Error(`Governor reservation ${decision.reservationId} could not be attached to autonomous run ${run.id}.`);
  }
  repository.updateSharedMessage(reply.id, { model: decision.model, executionProfile: decision.executionProfile });
  repository.addActivity(item.id, 'system', 'autonomous_execution_started', `Autonomous dispatch approved by governor. Agent: ${decision.agent}; model: ${decision.model}; reserved ${Math.ceil(decision.reservedSet)} SET (reservation ${decision.reservationId}).`);
  repository.addAuditEntry('api_mutation', 'autonomous-dispatcher', `Governor-approved autonomous execution started for ${item.title}.`, item.id);
  return { dispatched: true, item, run: repository.getRun(run.id)!, reason: 'Governor approved autonomous dispatch.' };
}
