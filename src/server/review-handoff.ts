import type { AgentRun, AgentRunReviewHandoff } from '../shared/contracts.js';

export interface ObservedRunEvent {
  category: 'agent_file_read' | 'agent_file_write' | 'agent_tool_use';
  detail: string;
  streamKind?: 'decision' | 'tool' | 'file_read' | 'file_write';
  command?: string;
  exitCode?: number | null;
}

const verificationCommand = /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|build|typecheck|lint))\b|\b(?:vitest|jest|tsc)\b/i;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function observedFiles(events: ObservedRunEvent[]): string[] {
  return unique(events.filter((event) => event.category === 'agent_file_write')
    .map((event) => event.detail.replace(/^(?:add|create|delete|update):\s*/i, '').trim())
    .filter((path) => path && path !== 'file_change' && !path.includes('\n')));
}

/**
 * Produces a reviewer map from durable task input and runner-observed events.
 * The agent's final prose is a navigation summary only; it never becomes test
 * or build proof, which requires a completed command event with an exit code.
 */
export function buildAgentRunReviewHandoff(run: AgentRun, output: string, events: ObservedRunEvent[], createdAt: string): AgentRunReviewHandoff {
  const files = observedFiles(events);
  const decisions = unique(events.filter((event) => event.streamKind === 'decision').map((event) => event.detail));
  const verification = events
    .filter((event) => event.command && event.exitCode !== undefined && verificationCommand.test(event.command))
    .map((event) => ({ command: event.command!, exitCode: event.exitCode ?? null, result: event.exitCode === 0 ? 'passed' as const : 'failed' as const }));
  const summary = output.trim().split('\n').find(Boolean)?.slice(0, 1_000) || `Completed ${run.kind} run.`;

  return {
    agentRunId: run.id,
    formatVersion: 1,
    summary,
    changes: files.map((path) => ({ path, summary: 'Updated during this run.', rationale: 'Observed file-write event from the coding runner.' })),
    acceptanceCriteria: run.instructions.trim() ? [{ criterion: run.instructions.trim(), files, decisions }] : [],
    contractChanges: [],
    verification,
    uncertainties: verification.length === 0 ? ['No completed test, build, typecheck, or lint command was observed by the runner.'] : [],
    tradeoffs: decisions.map((decision) => ({ decision, rationale: 'Recorded by the agent debugger during this run.' })),
    createdAt,
  };
}
