import type { AgentRun, AgentRunReviewHandoff } from '../shared/contracts.js';

export interface ObservedRunEvent {
  category: 'agent_file_read' | 'agent_file_write' | 'agent_tool_use';
  detail: string;
  streamKind?: 'decision' | 'tool' | 'file_read' | 'file_write';
  command?: string;
  exitCode?: number | null;
}

const verificationCommand = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|build|typecheck|lint|run\s+(?:test|build|typecheck|lint))\b|\b(?:vitest|jest|pytest|tsc|pyrefly|ruff|cargo\s+(?:test|build)|go\s+test)\b/i;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function observedFiles(events: ObservedRunEvent[]): string[] {
  return unique(events
    .filter((event) => event.category === 'agent_file_write')
    .map((event) => event.detail.replace(/^\[[^\]]+\]\s*/, '').replace(/^(?:add|create|delete|update):\s*/i, '').trim())
    .filter((path) => path && path !== 'file_change' && !path.includes('\n')));
}

/**
 * Builds a review map from run-owned instructions and runner-observed events.
 * The final model message is a navigation summary only: it cannot establish
 * that a test, build, or any other command ran successfully.
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
    changes: files.map((path) => ({ path, summary: 'Changed during this run.', rationale: 'Observed file-write event from the coding runner.' })),
    acceptanceCriteria: run.instructions.trim() ? [{ criterion: run.instructions.trim(), files, decisions }] : [],
    // Contract impact is intentionally empty unless a future structured runner
    // event can state it. Filename and final-answer inference are not proof.
    contractChanges: [],
    verification,
    uncertainties: verification.length === 0 ? ['No completed test, build, typecheck, or lint command was observed by the runner.'] : [],
    tradeoffs: decisions.map((decision) => ({ decision, rationale: 'Recorded by the agent debugger during this run.' })),
    createdAt,
  };
}
