import type { BrokerConnection, BrokerSearchResponse, BrokerSourceId, ResolvedSourceDraft, SourceProvider } from '../shared/contracts.js';
import type { WorkItemRepository } from './repository.js';
import { resolveSourceUrl as resolveGenericSourceUrl } from './source-resolver.js';
import { isMcpReauthenticationError, mcpAuthenticationMessage, scanRemoteMcp } from './remote-mcp.js';
import { searchSlackWithCodex } from './slack-codex.js';
import { searchAtlassianWithCodex, searchFigmaWithCodex, searchGrafanaWithCodex } from './managed-connector.js';
import { scanSource, type SourceSignal } from './source-scanner.js';
import { LinearProvider } from './providers/linear.js';

const cache = new Map<string, { expires: number; value: Promise<SourceSignal[]> }>();

function cached(key: string, load: () => Promise<SourceSignal[]>): Promise<SourceSignal[]> {
  const current = cache.get(key);
  if (current && current.expires > Date.now()) return current.value;
  const value = load().catch((error) => { cache.delete(key); throw error; });
  cache.set(key, { expires: Date.now() + 60_000, value });
  return value;
}

/** Atlassian is readable either through Codex's own OAuth (managed) or Workbench-stored MCP tokens. */
function scanAtlassian(settings: Record<string, string>, query: string, signal?: AbortSignal): Promise<SourceSignal[]> {
  return settings.mode === 'managed' ? searchAtlassianWithCodex(query, signal) : scanRemoteMcp('confluence', settings, query);
}

function legacyConnection(repository: WorkItemRepository, provider: SourceProvider) {
  return repository.listSourceConnections().find((entry) => entry.provider === provider);
}

function recoverAuthentication(repository: WorkItemRepository, provider: SourceProvider, error: unknown): Error {
  if (!isMcpReauthenticationError(error)) return error instanceof Error ? error : new Error('Source request failed.');
  const message = mcpAuthenticationMessage(provider);
  if (repository.getSourceSettings(provider)) repository.markSourceReauthRequired(provider, message);
  return new Error(message);
}

export function listBrokerConnections(repository: WorkItemRepository): BrokerConnection[] {
  const atlassian = legacyConnection(repository, 'confluence');
  const github = legacyConnection(repository, 'github');
  const slack = legacyConnection(repository, 'slack');
  const figma = legacyConnection(repository, 'figma');
  const grafana = legacyConnection(repository, 'grafana');
  return [
    { id: 'slack', name: 'Slack', state: slack?.lastError ? 'reauth_required' : 'connected', host: slack ? 'workbench' : 'managed_connector', capabilities: ['resolve_links', 'search'], configurable: true, lastError: slack?.lastError ?? null, detail: slack ? 'Connected through Slack MCP.' : 'Available through the acting agent’s authenticated ChatGPT connector.' },
    { id: 'figma', name: 'Figma', state: figma?.lastError ? 'reauth_required' : figma ? 'connected' : 'needs_auth', host: 'workbench', capabilities: ['resolve_links', 'search'], configurable: true, lastError: figma?.lastError ?? null, detail: figma ? 'Connected through Figma MCP.' : 'Authorize Figma MCP to enable design context.' },
    { id: 'grafana', name: 'Grafana', state: grafana ? grafana.lastError ? 'reauth_required' : 'connected' : 'needs_auth', host: 'managed_connector', capabilities: ['search'], configurable: true, lastError: grafana?.lastError ?? null, detail: grafana ? 'Grafana Cloud context through Codex.' : 'Authorize Grafana Cloud MCP to search your accessible observability data.' },
    { id: 'linear', name: 'Linear', state: process.env.LINEAR_API_KEY ? 'connected' : 'needs_auth', host: 'workbench', capabilities: ['resolve_links', 'search', 'sync'], configurable: Boolean(process.env.LINEAR_API_KEY), lastError: null, detail: process.env.LINEAR_API_KEY ? 'Synced and scoped by Workbench.' : 'Add LINEAR_API_KEY to Workbench.' },
    { id: 'atlassian', name: 'Atlassian', state: atlassian ? atlassian.lastError ? 'reauth_required' : 'connected' : 'needs_auth', host: 'workbench', capabilities: ['resolve_links', 'search'], configurable: true, lastError: atlassian?.lastError ?? null, detail: atlassian ? 'Jira and Confluence through one remote MCP connection.' : 'Authorization required for Jira and Confluence.' },
    { id: 'github', name: 'GitHub', state: github?.lastError ? 'reauth_required' : github || process.env.GITHUB_TOKEN ? 'connected' : 'needs_auth', host: 'workbench', capabilities: ['resolve_links', 'search'], configurable: true, lastError: github?.lastError ?? null, detail: github || process.env.GITHUB_TOKEN ? 'Uses one Workbench credential source for search and links.' : 'GitHub connection is not configured.' },
    { id: 'google', name: 'Google Workspace', state: 'disabled', host: 'managed_connector', capabilities: [], configurable: false, lastError: null, detail: 'Awaiting an approved Writer Google Workspace connector.' },
  ];
}

function queryFrom(message: string): string {
  return message.replace(/https?:\/\/\S+/g, ' ').replace(/\b(?:github|linear|atlassian|confluence|slack|figma|grafana|google|gmail|drive|search|find|look|show|check|for|in|on|the|a|an|me|please)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function sourceQuery(message: string, provider: 'slack' | 'confluence' | 'grafana' | 'github'): string {
  const host = provider === 'slack' ? 'slack.com' : provider === 'confluence' ? 'atlassian.net' : provider === 'grafana' ? 'grafana.net' : 'github.com';
  const urls = message.match(/https?:\/\/[^\s<>)]+/g) ?? [];
  return [...urls].reverse().find((url) => url.toLowerCase().includes(host)) ?? queryFrom(message);
}

function format(label: string, signals: SourceSignal[]): string {
  const body = signals.slice(0, 5).map((signal) => [`- ${signal.title}`, signal.url ? `  URL: ${signal.url}` : '', signal.occurredAt ? `  Updated: ${signal.occurredAt}` : '', signal.summary ? `  Context: ${signal.summary.slice(0, 900)}` : ''].filter(Boolean).join('\n')).join('\n');
  return `${label} context supplied by Workbench:\n${body.slice(0, 6_000)}`;
}

export async function contextForPrompt(repository: WorkItemRepository, message: string): Promise<string> {
  const query = queryFrom(message);
  const blocks: string[] = [];
  if (/\blinear\b|linear\.app/i.test(message)) {
    const items = repository.searchLinear(query, 5);
    blocks.push(items.length ? `Linear context supplied by Workbench:\n${items.map((item) => `- ${item.sourceIdentifier ?? 'Linear'}: ${item.title}\n  Project: ${item.projectName ?? 'none'}; status: ${item.status}${item.sourceUrl ? `\n  URL: ${item.sourceUrl}` : ''}${item.description ? `\n  Description: ${item.description.slice(0, 1_000)}` : ''}`).join('\n').slice(0, 6_000)}` : `Workbench has no synced Linear matches for ${query ? `“${query}”` : 'this request'}.`);
  }
  const requested: Array<{ provider: 'slack' | 'confluence' | 'grafana' | 'github'; label: string }> = [];
  if (/\bslack\b|slack\.com/i.test(message)) requested.push({ provider: 'slack', label: 'Slack' });
  if (/\b(?:atlassian|confluence|jira)\b|atlassian\.net/i.test(message)) requested.push({ provider: 'confluence', label: 'Atlassian' });
  if (/\bgrafana\b|grafana\.net/i.test(message)) requested.push({ provider: 'grafana', label: 'Grafana' });
  if (/\bgithub\b|github\.com/i.test(message)) requested.push({ provider: 'github', label: 'GitHub' });
  for (const { provider, label } of requested) {
    const settings = repository.getSourceSettings(provider);
    if (provider !== 'slack' && !settings && !(provider === 'github' && process.env.GITHUB_TOKEN)) { blocks.push(`Workbench connection unavailable: ${label} is not connected.`); continue; }
    try {
      const providerQuery = sourceQuery(message, provider);
      // A pasted GitHub issue/PR is stronger and cheaper context than a broad
      // search. Resolve it through Workbench's stored credential, then give the
      // resulting content directly to the agent.
      if (provider === 'github' && /^https:\/\/github\.com\//i.test(providerQuery)) {
        const draft = await resolveGenericSourceUrl(providerQuery, { githubSettings: settings ?? (process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : null) });
        blocks.push(`GitHub link context supplied by Workbench:\n- ${draft.title}\n  URL: ${draft.sourceUrl}\n  Context: ${draft.description.slice(0, 4_000)}`);
        continue;
      }
      const signals = await cached(`${provider}:${providerQuery}`, () => provider === 'slack' ? (!settings || settings.mode === 'managed' ? searchSlackWithCodex(providerQuery) : scanRemoteMcp(provider, settings, providerQuery)) : provider === 'confluence' ? scanAtlassian(settings!, providerQuery) : provider === 'grafana' ? searchGrafanaWithCodex(providerQuery) : scanSource('github', settings ?? { token: process.env.GITHUB_TOKEN ?? '', query: providerQuery }));
      const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
      const matches = terms.length ? signals.filter((signal) => terms.some((term) => `${signal.title}\n${signal.summary}\n${signal.url ?? ''}`.toLowerCase().includes(term))) : signals;
      blocks.push(matches.length ? format(label, matches) : `Workbench found no ${label} matches for ${query ? `“${query}”` : 'this request'}.`);
    } catch (error) { blocks.push(`Workbench ${label} connection failed: ${recoverAuthentication(repository, provider, error).message}.`); }
  }
  return blocks.length ? `Workbench-fetched source context (use directly; don't claim unavailable or start a new auth flow):\n\n${blocks.join('\n\n')}` : '';
}

export async function resolveBrokerUrl(repository: WorkItemRepository, value: string): Promise<ResolvedSourceDraft> {
  const url = new URL(value);
  if (url.hostname.includes('atlassian.net')) {
    const settings = repository.getSourceSettings('confluence');
    if (!settings) return resolveGenericSourceUrl(value);
    let signals: SourceSignal[];
    try { signals = await scanAtlassian(settings, value); }
    catch (error) { throw recoverAuthentication(repository, 'confluence', error); }
    const signal = signals[0];
    if (signal) return { source: 'Atlassian', sourceUrl: signal.url ?? value, title: signal.title, description: signal.summary || `Context from Atlassian: ${value}` };
  }
  return resolveGenericSourceUrl(value, {
    confluenceSettings: repository.getSourceSettings('confluence'),
    githubSettings: repository.getSourceSettings('github') ?? (process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : null),
  });
}

export async function searchBrokerSources(repository: WorkItemRepository, query: string, sources: BrokerSourceId[], signal?: AbortSignal): Promise<BrokerSearchResponse> {
  const errors: BrokerSearchResponse['errors'] = {};
  const batches = await Promise.all(sources.map(async (source) => {
    try {
      if (source === 'google') throw new Error('Google Workspace is disabled pending Writer approval.');
      if (source === 'linear') {
        // Start with the local catalog, but make Linear the live source for each
        // submitted search and persist what it returns for immediate assignment.
        // This avoids a full workspace sync while keeping current issues findable.
        const localItems = repository.searchLinear(query, 20);
        const config = repository.getLinearConfig();
        const provider = new LinearProvider(process.env.LINEAR_API_KEY ?? '', config.teamIds, config.projectIds);
        const liveItems = await provider.searchIssues(query, 20, signal);
        for (const item of liveItems) repository.upsertLinearItem(item);

        // An explicit identifier intentionally escapes configured sync scope:
        // Jeffrey can add a just-created Linear issue without waiting for sync.
        const identifier = query.match(/(?:\/issue\/)?([A-Za-z]+-\d+)/i)?.[1]?.toUpperCase();
        if (identifier && !liveItems.some((item) => item.sourceIdentifier === identifier)) {
          const item = await provider.fetchIssue(identifier);
          repository.upsertLinearItem(item);
          liveItems.unshift(item);
        }
        const seen = new Set<string>();
        return [...liveItems, ...localItems]
          .filter((item) => {
            const key = item.sourceIdentifier ?? item.sourceUrl ?? item.title;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 20)
          .map((item) => ({ provider: 'linear', title: `${item.sourceIdentifier ?? 'Linear'} · ${item.title}`, summary: item.description, url: item.sourceUrl, occurredAt: item.providerUpdatedAt }));
      }
      if (source === 'slack') { const settings = repository.getSourceSettings('slack'); return cached(`slack:search:${query}`, () => !settings || settings.mode === 'managed' ? searchSlackWithCodex(query, undefined, signal) : scanRemoteMcp('slack', settings, query)); }
      if (source === 'figma') { const settings = repository.getSourceSettings('figma'); if (!settings) throw new Error('Figma is not connected.'); return cached(`figma:search:${query}`, () => settings.mode === 'managed' ? searchFigmaWithCodex(query, signal) : scanRemoteMcp('figma', settings, query)); }
      if (source === 'grafana') { const settings = repository.getSourceSettings('grafana'); if (!settings) throw new Error('Grafana is not connected.'); return cached(`grafana:search:${query}`, () => searchGrafanaWithCodex(query, signal)); }
      if (source === 'atlassian') {
        const settings = repository.getSourceSettings('confluence');
        if (!settings) throw new Error('Atlassian is not connected.');
        return cached(`atlassian:search:${query}`, () => scanAtlassian(settings, query, signal));
      }
      const settings = repository.getSourceSettings('github') ?? (process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : null);
      if (!settings) throw new Error('GitHub is not connected.');
      return cached(`github:search:${query}`, () => scanSource('github', { ...settings, query }));
    } catch (error) {
      const provider = source === 'atlassian' ? 'confluence' : source === 'google' ? 'gmail' : source;
      errors[source] = provider === 'linear' ? (error instanceof Error ? error.message : 'Search failed.') : recoverAuthentication(repository, provider, error).message;
      return [];
    }
  }));
  return { results: batches.flat().map((result) => ({ source: (result.provider === 'confluence' ? 'atlassian' : result.provider) as BrokerSourceId, title: result.title, summary: result.summary, url: result.url, occurredAt: result.occurredAt })).slice(0, 100), errors };
}
