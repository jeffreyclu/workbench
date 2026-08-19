import { runAgentCommandWithFallback } from './agent-runner.js';
import { WorkItemRepository } from './repository.js';
import type { SourceSignal } from './source-scanner.js';

export async function createAgentDailyProposal(repository: WorkItemRepository, signals: SourceSignal[], scanErrors: string[]) {
  const items = repository.list();
  if (!items.length) throw new Error('Add at least one task before planning the stack.');
  if (items.length === 1 || signals.length === 0) return repository.buildDailyProposal();
  const prompt = `You are the daily planning agent for Jeffrey's attention stack.

Current stack, highest attention first:
${items.map((item, index) => `${index + 1}. [${item.id}] ${item.title}\nStatus: ${item.status}; due: ${item.dueDate ?? 'none'}; source: ${item.sourceUrl ?? item.sourceIdentifier ?? item.source}\n${item.description.slice(0, 800)}`).join('\n\n')}

New source signals from the last scan:
${signals.slice(0, 100).map((signal) => `[${signal.provider}] ${signal.title} (${signal.occurredAt ?? 'unknown time'})\n${signal.summary.slice(0, 600)}\n${signal.url ?? ''}`).join('\n\n')}

Scan errors: ${scanErrors.join('; ') || 'none'}

Preserve the existing relative order unless a source signal creates a meaningful reason to promote or demote a task. Recency alone is not sufficient. Do not add catalog items to the stack. Return every task ID exactly once. End with exactly:
<queue-proposal>{"orderedItemIds":["id"],"rationale":"specific reasons for meaningful movements, or why no movement is needed"}</queue-proposal>`;
  const { output } = await runAgentCommandWithFallback('claude', process.cwd(), prompt);
  const match = output.match(/<queue-proposal>([\s\S]*?)<\/queue-proposal>/);
  if (!match) throw new Error('Planning agent did not return a valid queue proposal.');
  const parsed = JSON.parse(match[1]) as { orderedItemIds?: unknown; rationale?: unknown };
  if (!Array.isArray(parsed.orderedItemIds) || typeof parsed.rationale !== 'string') throw new Error('Planning agent returned malformed queue data.');
  return repository.createProposal(parsed.orderedItemIds.map(String), parsed.rationale);
}
