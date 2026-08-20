import { runAgentCommand } from './agent-runner.js';
import type { SourceSignal } from './source-scanner.js';

export async function searchFigmaWithCodex(query: string, signal?: AbortSignal): Promise<SourceSignal[]> {
  const output = await runAgentCommand('codex', process.cwd(), `Use only the authenticated Figma connector to search for files, pages, components, or design nodes matching: ${JSON.stringify(query)}

Do not use web search and do not guess. Return at most 20 useful results. If Figma search is unavailable through the connector, state that in the error field.

Return exactly one block and no other text:
<figma-result>{"results":[{"title":"result name","summary":"file/page/node context","url":"Figma URL or null"}],"error":null}</figma-result>`, undefined, signal, 'economy');
  const match = output.match(/<figma-result>([\s\S]*?)<\/figma-result>/);
  if (!match) throw new Error('Figma connector returned no machine-readable search result.');
  const parsed = JSON.parse(match[1]) as { results?: Array<{ title?: unknown; summary?: unknown; url?: unknown }>; error?: unknown };
  if (typeof parsed.error === 'string' && parsed.error) throw new Error(parsed.error);
  if (!Array.isArray(parsed.results)) throw new Error('Figma connector returned malformed search results.');
  return parsed.results.slice(0, 20).flatMap((result) => typeof result.title === 'string' && typeof result.summary === 'string' ? [{ provider: 'figma', title: result.title.slice(0, 240), summary: result.summary.slice(0, 12_000), url: typeof result.url === 'string' ? result.url : null, occurredAt: null }] : []);
}
