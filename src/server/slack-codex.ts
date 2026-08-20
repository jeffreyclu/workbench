import { runAgentCommand } from './agent-runner.js';
import type { ResolvedSourceDraft } from '../shared/contracts.js';
import type { SourceSignal } from './source-scanner.js';

const resultPattern = /<slack-result>([\s\S]*?)<\/slack-result>/;

export type CodexRunner = (prompt: string) => Promise<string>;

const defaultRunner: CodexRunner = (prompt) => runAgentCommand('codex', process.cwd(), prompt);

function parseResult<T>(output: string): T {
  const match = output.match(resultPattern);
  if (!match) throw new Error('Slack connector returned no machine-readable result. Confirm Slack is installed and authenticated in Codex.');
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    throw new Error('Slack connector returned malformed data.');
  }
}

export async function resolveSlackPermalinkWithCodex(url: string, run: CodexRunner = defaultRunner): Promise<ResolvedSourceDraft> {
  const output = await run(`Use the authenticated Slack connector to open this exact Slack permalink and retrieve the complete root message and thread replies: ${url}

Do not use web search or guess from the URL. Preserve authors, timestamps, message text, and useful links while omitting connector metadata. If the connector cannot access the message, explain the concrete access problem.

Return exactly one block and no other text:
<slack-result>{"title":"concise task-oriented title derived from the thread","description":"complete standalone thread context","sourceUrl":${JSON.stringify(url)}}</slack-result>`);
  const result = parseResult<ResolvedSourceDraft>(output);
  if (!result.title?.trim() || !result.description?.trim()) throw new Error('Slack connector returned an empty thread.');
  return { source: 'Slack', sourceUrl: url, title: result.title.trim().slice(0, 240), description: result.description.trim().slice(0, 30_000) };
}

export async function scanSlackWithCodex(run: CodexRunner = defaultRunner): Promise<SourceSignal[]> {
  const output = await run(`Use the authenticated Slack connector to find Jeffrey's recent Slack context that may require work or change task priority. Search the last 24 hours.

Rank these highest:
1. A teammate directly asking Jeffrey to review code, a pull request, or a concrete implementation change.
2. A request, decision, blocker, incident, or follow-up involving the Connectors team or connectors product work.

Also include other concrete, actionable requests directed to Jeffrey. Exclude routine chatter, generic mentions, FYIs, and broad announcements without an action. Prefer the original request or thread permalink and include who asked and the concrete requested action in the summary. Do not invent tasks. Return at most 20 signals.

Return exactly one block and no other text:
<slack-result>{"signals":[{"title":"concise signal title","summary":"standalone context including relevant authors and thread details","url":"Slack permalink or null","occurredAt":"ISO timestamp or null"}]}</slack-result>`);
  const result = parseResult<{ signals?: Array<Partial<SourceSignal>> }>(output);
  if (!Array.isArray(result.signals)) throw new Error('Slack connector returned malformed signals.');
  return result.signals.slice(0, 30).flatMap((signal) => {
    if (typeof signal.title !== 'string' || typeof signal.summary !== 'string') return [];
    return [{ provider: 'slack', title: signal.title.slice(0, 240), summary: signal.summary.slice(0, 12_000), url: typeof signal.url === 'string' ? signal.url : null, occurredAt: typeof signal.occurredAt === 'string' ? signal.occurredAt : null }];
  });
}

export async function searchSlackWithCodex(query: string, run?: CodexRunner, signal?: AbortSignal): Promise<SourceSignal[]> {
  const execute = run ?? ((prompt: string) => runAgentCommand('codex', process.cwd(), prompt, undefined, signal));
  const output = await execute(`Use the authenticated Slack connector to search Slack for this exact request: ${JSON.stringify(query)}

Return the most relevant messages and threads, not merely recent activity. Preserve enough surrounding context to make each result useful. Return at most 20 results. Do not use web search or invent results.

Return exactly one block and no other text:
<slack-result>{"signals":[{"title":"concise result title","summary":"standalone context with author and relevant thread details","url":"Slack permalink or null","occurredAt":"ISO timestamp or null"}]}</slack-result>`);
  const result = parseResult<{ signals?: Array<Partial<SourceSignal>> }>(output);
  if (!Array.isArray(result.signals)) throw new Error('Slack connector returned malformed search results.');
  return result.signals.slice(0, 20).flatMap((signal) => typeof signal.title === 'string' && typeof signal.summary === 'string' ? [{ provider: 'slack', title: signal.title.slice(0, 240), summary: signal.summary.slice(0, 12_000), url: typeof signal.url === 'string' ? signal.url : null, occurredAt: typeof signal.occurredAt === 'string' ? signal.occurredAt : null }] : []);
}
