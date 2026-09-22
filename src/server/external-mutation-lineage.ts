import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRun, WorkItem } from '../shared/contracts.js';
import type { ExternalActionAuthorization } from './external-action-authorization.js';
import type { WorkItemRepository } from './repository.js';

const execFileAsync = promisify(execFile);
const PUBLISH_ACTIONS = new Set(['commit', 'push', 'remote_branch', 'pr_create']);

export function authoritativeTicketIdentifier(item: Pick<WorkItem, 'sourceIdentifier' | 'sourceUrl'>): string | null {
  return item.sourceIdentifier?.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i)?.[1]?.toUpperCase()
    ?? item.sourceUrl?.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)\b/i)?.[1]?.toUpperCase()
    ?? null;
}

export function isPublishOnlyCommand(command: string): boolean {
  return /\b(?:push|pull request|\bpr\b|commit)\b/i.test(command)
    && !/\b(?:implement|build|fix|change|update|edit|refactor|add|remove|write code)\b/i.test(command);
}

export function authoritativeMutationLineageProblem(input: {
  ticket: string;
  branch: string;
  publishOnly: boolean;
  hasCompletedExecution: boolean;
}): string | null {
  const branchTickets = [...input.branch.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/gi)].map((match) => match[1].toUpperCase());
  const conflicting = branchTickets.find((ticket) => ticket !== input.ticket);
  if (conflicting) return `Publish blocked: authoritative ticket ${input.ticket} conflicts with branch ${input.branch}, which belongs to ${conflicting}. Fix the ticket's actual implementation in its routed repository; do not rename the branch or replay unrelated commits.`;
  if (input.publishOnly && !input.hasCompletedExecution) return `Publish blocked: ${input.ticket} has no completed Workbench execution in this conversation. The last implementation failed or never finished, so its branch cannot be pushed or opened as a PR.`;
  return null;
}

/** Mechanical preflight for git publication. Authorization answers whether
 * Jeffrey asked for the mutation; this separately proves that the mutation
 * still belongs to the linked authoritative ticket. */
export async function verifyAuthoritativeMutationLineage(
  repository: WorkItemRepository,
  item: WorkItem,
  authorization: ExternalActionAuthorization,
  sourceWorkspace: string,
  currentRun: Pick<AgentRun, 'id' | 'conversationId'>,
): Promise<string | null> {
  if (!authorization.granted || !authorization.capability.actionIds.some((action) => PUBLISH_ACTIONS.has(action))) return null;
  const ticket = authoritativeTicketIdentifier(item);
  if (!ticket) return null;
  const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: sourceWorkspace, maxBuffer: 1024 * 1024 });
  const branch = stdout.trim() || '(detached HEAD)';
  const hasCompletedExecution = repository.listRuns(item.id).some((candidate) => (
    candidate.id !== currentRun.id
    && candidate.kind === 'execute'
    && candidate.status === 'completed'
    && (!currentRun.conversationId || candidate.conversationId === currentRun.conversationId)
  ));
  const problem = authoritativeMutationLineageProblem({
    ticket,
    branch,
    publishOnly: isPublishOnlyCommand(authorization.capability.command),
    hasCompletedExecution,
  });
  if (problem) throw new Error(problem);
  return `Supervisor verified publish lineage for ${ticket} on ${branch}${hasCompletedExecution ? ' against a completed execution in this conversation' : ''}.`;
}
