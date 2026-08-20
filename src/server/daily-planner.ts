import { runAgentCommandWithFallback } from './agent-runner.js';
import { WorkItemRepository } from './repository.js';
import type { SourceSignal } from './source-scanner.js';

/**
 * The deterministic ranking in `queue-intelligence.ts` is the baseline. The agent
 * only gets to argue with it: it sees the computed score and named signals for
 * every task, and any departure it proposes has to be justified in the rationale.
 * If the agent fails, times out, or returns something malformed we fall back to
 * the deterministic proposal rather than skipping the morning plan entirely.
 */
export async function createAgentDailyProposal(repository: WorkItemRepository, signals: SourceSignal[], scanErrors: string[]) {
  const items = repository.list();
  if (!items.length) throw new Error('Add at least one task before planning the stack.');
  if (items.length === 1 || signals.length === 0) return repository.buildDailyProposal();

  const baseline = repository.explainQueue();
  const explanationById = new Map(baseline.explanations.map((entry) => [entry.itemId, entry]));
  const prompt = `You are the daily planning agent for Jeffrey's attention stack.

Current stack, highest attention first, with the deterministic score already computed for each task:
${items.map((item, index) => {
    const explanation = explanationById.get(item.id);
    const reasons = explanation?.signals.map((entry) => `${entry.key} ${entry.delta >= 0 ? '+' : ''}${entry.delta} (${entry.detail})`).join('; ') || 'no signals';
    return `${index + 1}. [${item.id}] ${item.title}\nScore: ${explanation?.score ?? 0}; signals: ${reasons}\nStatus: ${item.status}; due: ${item.dueDate ?? 'none'}; last meaningful activity: ${item.lastTouchedAt}; source: ${item.sourceUrl ?? item.sourceIdentifier ?? item.source}\n${item.description.slice(0, 300)}`;
  }).join('\n\n')}

Deterministic baseline order: ${baseline.orderedItemIds.join(', ')}
Baseline rationale: ${baseline.rationale}

New source signals from the last scan:
${signals.slice(0, 30).map((signal) => `[${signal.provider}] ${signal.title} (${signal.occurredAt ?? 'unknown time'})\n${signal.summary.slice(0, 240)}\n${signal.url ?? ''}`).join('\n\n')}

Scan errors: ${scanErrors.join('; ') || 'none'}

Start from the deterministic baseline order. Depart from it only when a source signal above carries information the scores could not see, and name that signal in the rationale for every task you move. Preserve the existing relative order otherwise. Do not displace active or urgent work solely because another task is old. Do not add catalog items to the stack. Return every task ID exactly once. End with exactly:
<queue-proposal>{"orderedItemIds":["id"],"rationale":"specific reasons for meaningful movements, or why no movement is needed"}</queue-proposal>`;

  try {
    const { output } = await runAgentCommandWithFallback('claude', process.cwd(), prompt, undefined, undefined, undefined, 'economy');
    const match = output.match(/<queue-proposal>([\s\S]*?)<\/queue-proposal>/);
    if (!match) throw new Error('Planning agent did not return a valid queue proposal.');
    const parsed = JSON.parse(match[1]) as { orderedItemIds?: unknown; rationale?: unknown };
    if (!Array.isArray(parsed.orderedItemIds) || typeof parsed.rationale !== 'string') throw new Error('Planning agent returned malformed queue data.');
    const orderedItemIds = parsed.orderedItemIds.map(String);
    // The explanations stay attached to the tasks even when the agent overrides the
    // order, so the proposal remains auditable and the accept/reject feedback loop
    // still has signals to learn from.
    return repository.createProposal(orderedItemIds, parsed.rationale, baseline.explanations.map((entry) => ({
      ...entry, proposedPosition: orderedItemIds.indexOf(entry.itemId) + 1,
    })));
  } catch (error) {
    console.error('Planning agent failed; falling back to the deterministic stack proposal:', error);
    return repository.buildDailyProposal();
  }
}
