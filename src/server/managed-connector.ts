import { runAgentCommand } from './agent-runner.js';
import type { SourceSignal } from './source-scanner.js';

type ManagedSearchProvider = 'grafana';

const DESCRIPTIONS: Record<ManagedSearchProvider, { label: string; connector: string; scope: string }> = {
  grafana: { label: 'Grafana', connector: 'Grafana', scope: 'dashboards, alerts, metrics, logs, or traces' },
};

/**
 * Searches a provider through the acting Codex agent's own authenticated MCP
 * connection instead of Workbench-stored OAuth tokens. This is the path used
 * when a connection was made with `codex mcp login`.
 */
async function searchWithCodexConnector(provider: ManagedSearchProvider, query: string, signal?: AbortSignal): Promise<SourceSignal[]> {
  const { label, connector, scope } = DESCRIPTIONS[provider];
  const output = await runAgentCommand('codex', process.cwd(), `Use only the authenticated ${connector} connector to search for ${scope} matching: ${JSON.stringify(query)}

Do not use web search and do not guess. Return at most 20 useful results. If ${label} search is unavailable through the connector, state that in the error field.

Return exactly one block and no other text:
<connector-result>{"results":[{"title":"result name","summary":"result context","url":"${label} URL or null"}],"error":null}</connector-result>`, undefined, signal, 'economy');
  const match = output.match(/<connector-result>([\s\S]*?)<\/connector-result>/) ?? output.match(/<figma-result>([\s\S]*?)<\/figma-result>/);
  if (!match) throw new Error(`${label} connector returned no machine-readable search result.`);
  const parsed = JSON.parse(match[1]) as { results?: Array<{ title?: unknown; summary?: unknown; url?: unknown }>; error?: unknown };
  if (typeof parsed.error === 'string' && parsed.error) throw new Error(parsed.error);
  if (!Array.isArray(parsed.results)) throw new Error(`${label} connector returned malformed search results.`);
  return parsed.results.slice(0, 20).flatMap((result) => typeof result.title === 'string' && typeof result.summary === 'string' ? [{ provider, title: result.title.slice(0, 240), summary: result.summary.slice(0, 12_000), url: typeof result.url === 'string' ? result.url : null, occurredAt: null }] : []);
}

export function searchGrafanaWithCodex(query: string, signal?: AbortSignal): Promise<SourceSignal[]> {
  return searchWithCodexConnector('grafana', query, signal);
}
