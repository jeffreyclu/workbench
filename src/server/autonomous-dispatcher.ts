import { classifyExecution } from './agent-runner.js';
import { evaluateAutonomousDispatch, type AutonomousGovernorDecision } from './autonomy-governor.js';
import type { AgentRun, WorkItem } from '../shared/contracts.js';
import type { WorkItemRepository } from './repository.js';

export type AutonomousDispatchResult =
  | { dispatched: true; item: WorkItem; run: AgentRun; reason: string }
  | { dispatched: false; reason: string };

/** Selects the first dispatchable item from the durable attention-stack order. */
function nextEligibleItem(repository: WorkItemRepository): WorkItem | null {
  return repository.list().find((item) => (
    item.status === 'backlog' || item.status === 'ready'
  ) && item.assignees.every((assignee) => assignee !== 'jeffrey')
    && repository.listOpenDependencies(item.id).length === 0
    && repository.activeRunsForItem(item.id).length === 0) ?? null;
}

export function dispatchAutonomousWork(
  repository: WorkItemRepository,
  overrideDecision?: AutonomousGovernorDecision,
): AutonomousDispatchResult {
  const item = nextEligibleItem(repository);
  if (!item) return { dispatched: false, reason: 'No eligible backlog task is queued.' };

  // The governor decides (and atomically holds the budget) against this
  // specific candidate, so the hold and the claim never race apart.
  const decision = overrideDecision ?? evaluateAutonomousDispatch(repository, { origin: 'autonomous', model: 'sonnet', workItemId: item.id });
  if (!decision.approved) return { dispatched: false, reason: decision.reason };

  // The governor has reserved only a Claude Sonnet run. Do not reuse a manual
  // classification agent/profile, which might be Codex or autonomous-disallowed Opus.
  const classification = repository.getClassification(item.id) ?? repository.setClassification(item.id, classifyExecution(item));
  const conversation = repository.getOrCreateWorkConversation(item.id, item.title);
  repository.createSharedMessage('system', `Autonomous dispatch: ${item.title}`, 'completed', conversation.id);
  const reply = repository.createSharedMessage(decision.agent, '', 'running', conversation.id);
  const run = repository.createRun(item.id, classification.kind, decision.agent, decision.agent, classification.instructions, conversation.id, reply.id, 'autonomous');
  repository.updateRun(run.id, { model: decision.model, executionProfile: decision.executionProfile });
  repository.updateSharedMessage(reply.id, { model: decision.model, executionProfile: decision.executionProfile });
  repository.addActivity(item.id, 'system', 'autonomous_execution_started', `Autonomous dispatch approved by governor. Agent: ${decision.agent}; model: ${decision.model}; reserved ${Math.ceil(decision.reservedSet)} SET (reservation ${decision.reservationId}).`);
  repository.addAuditEntry('api_mutation', 'autonomous-dispatcher', `Governor-approved autonomous execution started for ${item.title}.`, item.id);
  return { dispatched: true, item, run: repository.getRun(run.id)!, reason: 'Governor approved autonomous dispatch.' };
}
