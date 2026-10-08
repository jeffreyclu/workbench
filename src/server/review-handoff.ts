import type { AgentRun, AgentRunReviewHandoff } from '../shared/contracts.js';
import { claimsCompletion } from './final-response-policy.js';
import { extractMemoryCitations } from './repositories/memory-usage-repository.js';

export interface ObservedRunEvent {
  category: 'agent_file_read' | 'agent_file_write' | 'agent_tool_use';
  detail: string;
  streamKind?: 'decision' | 'tool' | 'file_read' | 'file_write';
  command?: string;
  exitCode?: number | null;
  /** Bounded text of an MCP tool's response, present only on response events. */
  result?: string;
}

/** Exit status the runner records for a command its external-action guard refused. */
const REFUSED_COMMAND_EXIT_CODE = 126;
const MAX_LIST_ITEMS = 10;

const verificationCommand = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:test|build|typecheck|lint|run\s+(?:test|build|typecheck|lint))\b|\b(?:vitest|jest|pytest|tsc|pyrefly|ruff|cargo\s+(?:test|build)|go\s+test)\b/i;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Paths the runner saw the agent write. */
export function observedFiles(events: ObservedRunEvent[]): string[] {
  return unique(events
    .filter((event) => event.category === 'agent_file_write')
    .map((event) => event.detail.replace(/^\[[^\]]+\]\s*/, '').replace(/^(?:add|create|delete|update):\s*/i, '').trim())
    .filter((path) => path && path !== 'file_change' && !path.includes('\n')));
}

// A blocker is a line that says so in words: a "Blockers:" label or the word
// "blocked". "Blockers: none" and review verdicts such as "1 blocking" are not.
const blockerLine = /\b(?:blockers?\s*:|blocked\b)/i;
const noBlockers = /\b(?:no|none|zero)\b[^.]{0,20}\bblockers?\b|\bblockers?\s*:\s*(?:none|n\/a|no)\b/i;

function blockersFromOutput(output: string): string[] {
  const lines = output.split('\n').map((line) => line.trim().replace(/^[-*]\s+/, '')).filter((line) => line && !/^#{1,6}\s/.test(line));
  return lines.filter((line) => blockerLine.test(line) && !noBlockers.test(line)).map((line) => line.slice(0, 500));
}

/** Citation ids from `record_learning` responses, which return `[file.md#N]`. */
export function learningsFromEvents(events: ObservedRunEvent[]): string[] {
  return unique(events
    .filter((event) => event.result && /(?:^|[.__])record_learning$/.test(event.detail))
    .flatMap((event) => extractMemoryCitations(event.result!).map((citation) => citation.entryId)));
}

/**
 * Builds a handoff from run-owned instructions and runner-observed events.
 * The final model message is a navigation summary only: it cannot establish
 * that a test, build, or any other command ran successfully.
 */
export function buildAgentRunReviewHandoff(run: AgentRun, output: string, events: ObservedRunEvent[], createdAt: string, captureGate?: string, badge?: string): AgentRunReviewHandoff {
  const files = observedFiles(events);
  const decisions = unique(events.filter((event) => event.streamKind === 'decision').map((event) => event.detail));
  const verification = events
    .filter((event) => event.command && event.exitCode !== undefined && verificationCommand.test(event.command))
    .map((event) => ({ command: event.command!, exitCode: event.exitCode ?? null, result: event.exitCode === 0 ? 'passed' as const : 'failed' as const }));
  // Final answers open with a "## Problem" heading; the summary is the first
  // line that says something.
  const summary = output.trim().split('\n').map((line) => line.trim()).find((line) => line && !/^#{1,6}\s/.test(line))?.slice(0, 1_000) || `Completed ${run.kind} run.`;

  const refused = events
    .filter((event) => event.exitCode === REFUSED_COMMAND_EXIT_CODE)
    .map((event) => `Refused: ${(event.command ?? event.detail).slice(0, 300)}`);
  const learnings = learningsFromEvents(events);
  const priorArt = extractMemoryCitations(output).map((citation) => citation.entryId).filter((id) => !learnings.includes(id));

  return {
    agentRunId: run.id,
    formatVersion: 2,
    summary,
    changes: files.map((path) => ({ path, summary: 'Changed during this run.', rationale: 'Observed file-write event from the coding runner.' })),
    acceptanceCriteria: run.instructions.trim() ? [{ criterion: run.instructions.trim(), files, decisions }] : [],
    // Contract impact is intentionally empty unless a future structured runner
    // event can state it. Filename and final-answer inference are not proof.
    contractChanges: [],
    verification,
    uncertainties: verification.length === 0 ? ['No completed test, build, typecheck, or lint command was observed by the runner.'] : [],
    tradeoffs: decisions.map((decision) => ({ decision, rationale: 'Recorded by the agent debugger during this run.' })),
    blockers: unique([...blockersFromOutput(output), ...refused]).slice(0, MAX_LIST_ITEMS),
    learnings: [...learnings.slice(0, MAX_LIST_ITEMS), ...(captureGate ? [captureGate] : []), ...(badge ? [badge] : [])],
    priorArt: priorArt.slice(0, MAX_LIST_ITEMS),
    unverifiedClaim: verification.length === 0 && claimsCompletion(output),
    createdAt,
  };
}
