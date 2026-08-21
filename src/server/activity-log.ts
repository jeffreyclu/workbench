import type { AgentRun, WorkItem } from '../shared/contracts.js';
import type { ExecutionProfile } from './agent-runner.js';

/**
 * Human-readable text for the task activity log. Two kinds of events live here:
 * the decisions Workbench makes on Jeffrey's behalf (execution type, agent,
 * model tier) and the edits Jeffrey makes by hand. Both are formatted in one
 * place so the log reads consistently and stays testable without a database.
 */

const profileEffort: Record<ExecutionProfile, string> = { economy: 'low effort', standard: 'medium effort', deep: 'high effort' };

/** Why a run ended up on a given model tier. */
export type ExecutionProfileSource = 'requested' | 'task' | 'prompt';

export function describeExecutionRouting(input: {
  kind: AgentRun['kind'];
  agents: AgentRun['agent'][];
  reason: string;
  agentSource: 'assigned' | 'balanced';
  requestedProfile: ExecutionProfile | null;
}): string {
  const agentText = input.agents.join(' + ');
  const agentReason = input.agentSource === 'assigned' ? 'assigned to this task' : 'auto-picked to balance agent load';
  const tierText = input.requestedProfile ? `${input.requestedProfile} (you chose it)` : 'auto (picked when the run starts)';
  return `Execution type: ${input.kind} (${input.reason}). Agent: ${agentText} (${agentReason}). Model tier: ${tierText}.`;
}

export function describeModelSelection(input: {
  agent: AgentRun['agent'];
  kind: AgentRun['kind'];
  model: string;
  profile: ExecutionProfile;
  source: ExecutionProfileSource;
}): string {
  const why = input.source === 'requested'
    ? 'you chose this tier'
    : input.source === 'prompt'
      ? 'raised by the assembled run prompt'
      : 'matched to the task context';
  return `Model: ${input.agent} ${input.model} · ${input.profile} tier, ${profileEffort[input.profile]} (${why}). Running ${input.kind}.`;
}

export function describeAgentFallback(input: {
  from: AgentRun['agent'];
  to: AgentRun['agent'];
  model: string;
  reason: string;
}): string {
  return `${input.from} was unavailable (${input.reason.slice(0, 240)}); continued with ${input.to} on ${input.model}.`;
}

/** A lifecycle move Jeffrey (or an assistant acting for him) applied to a task. */
export type LifecycleAction = 'archive' | 'complete' | 'restore';

const lifecycleText: Record<LifecycleAction, string> = {
  archive: 'Archived without completing',
  complete: 'Completed and moved to the archive',
  restore: 'Restored from the archive',
};

/**
 * Archiving, completing, and restoring are the lifecycle moves that take a task
 * out of the queue or put it back. `reason` is set when Workbench applied the
 * move as a consequence of something else, so the log never shows a task
 * vanishing with no explanation.
 */
export function describeLifecycleChange(action: LifecycleAction, reason?: string): string {
  return reason ? `${lifecycleText[action]} because ${reason}.` : `${lifecycleText[action]}.`;
}

function quote(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `"${trimmed.slice(0, 80)}…"` : `"${trimmed}"`;
}

function orNone(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : 'none';
}

function listOrNone(values: readonly string[]): string {
  return values.length ? values.join(', ') : 'none';
}

/**
 * One line per pertinent field change, ready to join into a single activity
 * entry. Queue position and stack are deliberately excluded: both already emit
 * their own activity, and reordering the queue is not a decision worth
 * replaying line by line.
 */
export function summarizeWorkItemChanges(before: WorkItem, after: WorkItem): string[] {
  const lines: string[] = [];
  if (before.title !== after.title) lines.push(`Renamed to ${quote(after.title)}`);
  if (before.status !== after.status) lines.push(`Status: ${before.status} → ${after.status}`);
  if (before.priority !== after.priority) lines.push(`Priority: ${before.priority} → ${after.priority}`);
  if (before.assignees.join() !== after.assignees.join()) lines.push(`Owners: ${listOrNone(before.assignees)} → ${listOrNone(after.assignees)}`);
  if (before.dueDate !== after.dueDate) lines.push(`Due date: ${orNone(before.dueDate)} → ${orNone(after.dueDate)}`);
  if (before.projectName !== after.projectName) lines.push(`Project: ${orNone(before.projectName)} → ${orNone(after.projectName)}`);
  if (before.workspacePath !== after.workspacePath) lines.push(`Workspace: ${orNone(before.workspacePath)} → ${orNone(after.workspacePath)}`);
  if (before.labels.join() !== after.labels.join()) lines.push(`Labels: ${listOrNone(before.labels)} → ${listOrNone(after.labels)}`);
  if (before.description !== after.description) lines.push(after.description.trim() ? 'Edited the description' : 'Cleared the description');
  if (before.strategy !== after.strategy) lines.push(after.strategy.trim() ? 'Edited the strategy' : 'Cleared the strategy');
  const beforeBlockers = (before.blockedBy ?? []).map((dependency) => dependency.id).join();
  const afterBlockers = (after.blockedBy ?? []).map((dependency) => dependency.id).join();
  if (beforeBlockers !== afterBlockers) {
    const count = (after.blockedBy ?? []).length;
    lines.push(count ? `Prerequisites: ${count} task${count === 1 ? '' : 's'}` : 'Cleared the prerequisites');
  }
  return lines;
}
