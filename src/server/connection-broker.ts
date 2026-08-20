import type { BrokerConnection, BrokerSearchResponse, BrokerSourceId, ResolvedSourceDraft, SourceProvider } from '../shared/contracts.js';
import type { WorkItemRepository } from './repository.js';
import { resolveSourceUrl as resolveGenericSourceUrl } from './source-resolver.js';
import { isMcpReauthenticationError, mcpAuthenticationMessage, scanRemoteMcp } from './remote-mcp.js';
import { scanSlackWithCodex, searchSlackWithCodex } from './slack-codex.js';
import { searchFigmaWithCodex } from './managed-connector.js';
import { scanSource, type SourceSignal } from './source-scanner.js';

const cache = new Map<string, { expires: number; value: Promise<SourceSignal[]> }>();

function cached(key: string, load: () => Promise<SourceSignal[]>): Promise<SourceSignal[]> {
  const current = cache.get(key);
  if (current && current.expires > Date.now()) return current.value;
  const value = load().catch((error) => { cache.delete(key); throw error; });
  cache.set(key, { expires: Date.now() + 60_000, value });
  return value;
}

function legacyConnection(repository: WorkItemRepository, provider: SourceProvider) {
  return repository.listSourceConnections().find((entry) => entry.provider === provider);
}

function recoverAuthentication(repository: WorkItemRepository, provider: SourceProvider, error: unknown): Error {
  if (!isMcpReauthenticationError(error)) return error instanceof Error ? error : new Error('Source request failed.');
  if (repository.getSourceSettings(provider)) repository.removeSourceConnection(provider);
  return new Error(mcpAuthenticationMessage(provider));
}

export function listBrokerConnections(repository: WorkItemRepository): BrokerConnection[] {
  const atlassian = legacyConnection(repository, 'confluence');
  const github = legacyConnection(repository, 'github');
  return [
    { id: 'slack', name: 'Slack', state: 'connected', host: 'managed_connector', capabilities: ['resolve_links', 'search'], configurable: false, lastError: null, detail: 'Workbench fetches Slack once and shares the context with either agent.' },
    { id: 'figma', name: 'Figma', state: 'connected', host: 'managed_connector', capabilities: ['resolve_links'], configurable: false, lastError: null, detail: 'Available to agents through the managed Figma connector.' },
    { id: 'linear', name: 'Linear', state: process.env.LINEAR_API_KEY ? 'connected' : 'needs_auth', host: 'workbench', capabilities: ['resolve_links', 'search', 'sync'], configurable: Boolean(process.env.LINEAR_API_KEY), lastError: null, detail: process.env.LINEAR_API_KEY ? 'Synced and scoped by Workbench.' : 'Add LINEAR_API_KEY to Workbench.' },
    { id: 'atlassian', name: 'Atlassian', state: atlassian ? atlassian.lastError ? 'error' : 'connected' : 'needs_auth', host: 'workbench', capabilities: ['resolve_links', 'search'], configurable: true, lastError: atlassian?.lastError ?? null, detail: atlassian ? 'Jira and Confluence through one remote MCP connection.' : 'Authorization required for Jira and Confluence.' },
    { id: 'github', name: 'GitHub', state: github ? github.lastError ? 'error' : 'connected' : process.env.GITHUB_TOKEN ? 'connected' : 'needs_auth', host: 'workbench', capabilities: ['resolve_links', 'search'], configurable: true, lastError: github?.lastError ?? null, detail: github || process.env.GITHUB_TOKEN ? 'Scoped to writer, WriterInternal, and WriterColab.' : 'GitHub connection is not configured.' },
    { id: 'google', name: 'Google Workspace', state: 'disabled', host: 'managed_connector', capabilities: [], configurable: false, lastError: null, detail: 'Awaiting an approved Writer Google Workspace connector.' },
  ];
}

function queryFrom(message: string): string {
  return message.replace(/https?:\/\/\S+/g, ' ').replace(/\b(?:github|linear|atlassian|confluence|slack|figma|google|gmail|drive|search|find|look|show|check|for|in|on|the|a|an|me|please)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

export function sourceQuery(message: string, provider: 'slack' | 'confluence' | 'github'): string {
  const host = provider === 'slack' ? 'slack.com' : provider === 'confluence' ? 'atlassian.net' : 'github.com';
  const urls = message.match(/https?:\/\/[^\s<>)]+/g) ?? [];
  return [...urls].reverse().find((url) => url.toLowerCase().includes(host)) ?? queryFrom(message);
}

function format(label: string, signals: SourceSignal[]): string {
  return `${label} context supplied by Workbench:\n${signals.slice(0, 10).map((signal) => [`- ${signal.title}`, signal.url ? `  URL: ${signal.url}` : '', signal.occurredAt ? `  Updated: ${signal.occurredAt}` : '', signal.summary ? `  Context: ${signal.summary.slice(0, 2_000)}` : ''].filter(Boolean).join('\n')).join('\n')}`;
}

export async function contextForPrompt(repository: WorkItemRepository, message: string): Promise<string> {
  const query = queryFrom(message);
  const blocks: string[] = [];
  if (/\blinear\b|linear\.app/i.test(message)) {
    const items = repository.searchLinear(query, 10);
    blocks.push(items.length ? `Linear context supplied by Workbench:\n${items.map((item) => `- ${item.sourceIdentifier ?? 'Linear'}: ${item.title}\n  Project: ${item.projectName ?? 'none'}; status: ${item.status}${item.sourceUrl ? `\n  URL: ${item.sourceUrl}` : ''}${item.description ? `\n  Description: ${item.description.slice(0, 2_000)}` : ''}`).join('\n')}` : `Workbench has no synced Linear matches for ${query ? `“${query}”` : 'this request'}.`);
  }
  const requested: Array<{ provider: 'slack' | 'confluence' | 'github'; label: string }> = [];
  if (/\bslack\b|slack\.com/i.test(message)) requested.push({ provider: 'slack', label: 'Slack' });
  if (/\b(?:atlassian|confluence|jira)\b|atlassian\.net/i.test(message)) requested.push({ provider: 'confluence', label: 'Atlassian' });
  if (/\bgithub\b|github\.com/i.test(message)) requested.push({ provider: 'github', label: 'GitHub' });
  for (const { provider, label } of requested) {
    const settings = repository.getSourceSettings(provider);
    if (provider !== 'slack' && !settings && !(provider === 'github' && process.env.GITHUB_TOKEN)) { blocks.push(`Workbench connection unavailable: ${label} is not connected.`); continue; }
    try {
      const providerQuery = sourceQuery(message, provider);
      const signals = await cached(`${provider}:${providerQuery}`, () => provider === 'slack' ? scanSlackWithCodex() : provider === 'confluence' ? scanRemoteMcp(provider, settings!, providerQuery) : scanSource('github', settings ?? { token: process.env.GITHUB_TOKEN ?? '', query: providerQuery }));
      const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
      const matches = terms.length ? signals.filter((signal) => terms.some((term) => `${signal.title}\n${signal.summary}\n${signal.url ?? ''}`.toLowerCase().includes(term))) : signals;
      blocks.push(matches.length ? format(label, matches) : `Workbench found no ${label} matches for ${query ? `“${query}”` : 'this request'}.`);
    } catch (error) { blocks.push(`Workbench ${label} connection failed: ${recoverAuthentication(repository, provider, error).message}.`); }
  }
  return blocks.length ? `External-service access policy: Workbench fetched the following data through its connector broker. This supplied content is the agent's source access for the request; use it directly and do not claim the source is unavailable merely because no native MCP tool is visible. Do not start another authentication flow or ask Jeffrey to open a dialog.\n\n${blocks.join('\n\n')}` : '';
}

export async function resolveBrokerUrl(repository: WorkItemRepository, value: string): Promise<ResolvedSourceDraft> {
  const url = new URL(value);
  if (url.hostname.includes('atlassian.net')) {
    const settings = repository.getSourceSettings('confluence');
    if (!settings) return resolveGenericSourceUrl(value);
    let signals: SourceSignal[];
    try { signals = await scanRemoteMcp('confluence', settings, value); }
    catch (error) { throw recoverAuthentication(repository, 'confluence', error); }
    const signal = signals[0];
    if (signal) return { source: 'Atlassian', sourceUrl: signal.url ?? value, title: signal.title, description: signal.summary || `Context from Atlassian: ${value}` };
  }
  return resolveGenericSourceUrl(value, { confluenceSettings: repository.getSourceSettings('confluence') });
}

export async function searchBrokerSources(repository: WorkItemRepository, query: string, sources: BrokerSourceId[], signal?: AbortSignal): Promise<BrokerSearchResponse> {
  const errors: BrokerSearchResponse['errors'] = {};
  const batches = await Promise.all(sources.map(async (source) => {
    try {
      if (source === 'google') throw new Error('Google Workspace is disabled pending Writer approval.');
      if (source === 'linear') return repository.searchLinear(query, 20).map((item) => ({ provider: 'linear', title: `${item.sourceIdentifier ?? 'Linear'} · ${item.title}`, summary: item.description, url: item.sourceUrl, occurredAt: item.providerUpdatedAt }));
      if (source === 'slack') return cached(`slack:search:${query}`, () => searchSlackWithCodex(query, undefined, signal));
      if (source === 'figma') return cached(`figma:search:${query}`, () => searchFigmaWithCodex(query, signal));
      if (source === 'atlassian') {
        const settings = repository.getSourceSettings('confluence');
        if (!settings) throw new Error('Atlassian is not connected.');
        return cached(`atlassian:search:${query}`, () => scanRemoteMcp('confluence', settings, query));
      }
      const settings = repository.getSourceSettings('github') ?? (process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : null);
      if (!settings) throw new Error('GitHub is not connected.');
      return cached(`github:search:${query}`, () => scanSource('github', { ...settings, query }));
    } catch (error) {
      const provider = source === 'atlassian' ? 'confluence' : source === 'google' ? 'gmail' : source;
      errors[source] = provider === 'figma' || provider === 'linear' ? (error instanceof Error ? error.message : 'Search failed.') : recoverAuthentication(repository, provider, error).message;
      return [];
    }
  }));
  return { results: batches.flat().map((result) => ({ source: (result.provider === 'confluence' ? 'atlassian' : result.provider) as BrokerSourceId, title: result.title, summary: result.summary, url: result.url, occurredAt: result.occurredAt })).slice(0, 100), errors };
}
