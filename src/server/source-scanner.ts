import type { SourceProvider } from '../shared/contracts.js';
import { WorkItemRepository } from './repository.js';
import { scanSlackMcp } from './slack-mcp.js';
import { isMcpReauthenticationError, mcpAuthenticationMessage, scanRemoteMcp } from './remote-mcp.js';
import { scanSlackWithCodex } from './slack-codex.js';
import { assertApprovedMcpServer, createOutboundFetch, type OutboundPolicyName } from './outbound-policy.js';

export interface SourceSignal {
  provider: string;
  title: string;
  summary: string;
  url: string | null;
  occurredAt: string | null;
  /** Current work remains discoverable until reviewed, even when it was last updated before the incremental window. */
  activeWork?: boolean;
  /** Passive source references are useful for search, but are not discovery tasks. */
  referenceOnly?: boolean;
}

async function requestJson<T>(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

type OutboundFetchFactory = (policy: OutboundPolicyName) => typeof fetch;

async function scanGitHub(settings: Record<string, string>, fetchForPolicy: OutboundFetchFactory = createOutboundFetch): Promise<SourceSignal[]> {
  const configuredQuery = settings.query?.replace(/\b(?:org|user):(?:"[^"]+"|\S+)/gi, '').trim();
  const queries = configuredQuery
    ? [{ query: configuredQuery, context: 'Matched your configured GitHub discovery scope.' }]
    : [
      { query: 'is:open is:pr review-requested:@me', context: 'GitHub review requested from you.' },
      { query: 'is:open assignee:@me', context: 'Open GitHub work assigned to you.' },
      { query: 'is:open is:pr author:@me review:changes_requested', context: 'Your open pull request has requested changes.' },
      { query: 'is:open is:pr involves:@me', context: 'Open GitHub pull request involving you.' },
    ];
  const organizations = ['writer', 'WriterInternal', 'WriterColab'];
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${settings.token}`, 'User-Agent': 'workbench-local' };
  const responses = await Promise.all(queries.flatMap(({ query, context }) => organizations.map(async (organization) => ({
    context,
    items: (await requestJson<{ items: Array<{ title: string; body: string | null; html_url: string; updated_at: string; repository_url: string }> }>(
      `https://api.github.com/search/issues?q=${encodeURIComponent(`${query} org:${organization}`)}&sort=updated&order=desc&per_page=15`, headers, fetchForPolicy('github-api'),
    )).items,
  }))));
  const unique = new Map<string, { item: (typeof responses)[number]['items'][number]; contexts: string[] }>();
  for (const response of responses) {
    for (const item of response.items) {
      const existing = unique.get(item.html_url);
      if (existing) existing.contexts.push(response.context);
      else unique.set(item.html_url, { item, contexts: [response.context] });
    }
  }
  return [...unique.values()].sort((left, right) => right.item.updated_at.localeCompare(left.item.updated_at)).slice(0, 30)
    .map(({ item, contexts }) => {
      const repository = item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, '');
      return { provider: 'github', title: item.title, summary: `${[...new Set(contexts)].join(' ')}\nRepository: ${repository}\n${item.body?.slice(0, 1_000) ?? ''}`.trim(), url: item.html_url, occurredAt: item.updated_at, activeWork: true };
    });
}

async function scanConfluence(settings: Record<string, string>, fetchForPolicy: OutboundFetchFactory = createOutboundFetch): Promise<SourceSignal[]> {
  const site = settings.siteUrl.replace(/\/$/, '');
  const cql = settings.cql || 'type in (page, blogpost) order by lastmodified desc';
  const auth = Buffer.from(`${settings.email}:${settings.token}`).toString('base64');
  const data = await requestJson<{ results: Array<{ title: string; excerpt?: string; url?: string; lastModified?: string; content?: { _links?: { webui?: string } } }> }>(
    `${site}/wiki/rest/api/search?limit=30&cql=${encodeURIComponent(cql)}`,
    { Accept: 'application/json', Authorization: `Basic ${auth}` }, fetchForPolicy('atlassian-api'),
  );
  return data.results.map((result) => ({ provider: 'confluence', title: result.title, summary: result.excerpt ?? '', url: result.url ?? (result.content?._links?.webui ? `${site}/wiki${result.content._links.webui}` : null), occurredAt: result.lastModified ?? null }));
}

async function scanGmail(settings: Record<string, string>, fetchForPolicy: OutboundFetchFactory = createOutboundFetch): Promise<SourceSignal[]> {
  const list = await requestJson<{ messages?: Array<{ id: string }> }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=${encodeURIComponent(settings.query || 'newer_than:1d')}`,
    { Authorization: `Bearer ${settings.accessToken}` }, fetchForPolicy('gmail-api'),
  );
  return Promise.all((list.messages ?? []).map(async ({ id }) => {
    const message = await requestJson<{ snippet: string; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { Authorization: `Bearer ${settings.accessToken}` }, fetchForPolicy('gmail-api'),
    );
    const headers = message.payload?.headers ?? [];
    const subject = headers.find((header) => header.name.toLowerCase() === 'subject')?.value || 'Email';
    const from = headers.find((header) => header.name.toLowerCase() === 'from')?.value || '';
    return { provider: 'gmail', title: subject, summary: `${from}\n${message.snippet}`, url: `https://mail.google.com/mail/u/0/#all/${id}`, occurredAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null };
  }));
}

const GRAFANA_URL = 'https://grafana.observability.writer.com';

async function scanGrafana(settings: Record<string, string>, fetchForPolicy: OutboundFetchFactory = createOutboundFetch): Promise<SourceSignal[]> {
  if (!settings.token) throw new Error('Grafana service-account token is missing. Add it in Sources.');
  const alerts = await requestJson<Array<{
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
    generatorURL?: string;
    startsAt?: string;
    updatedAt?: string;
    status?: { state?: string; silencedBy?: string[]; inhibitedBy?: string[] };
  }>>(
    `${GRAFANA_URL}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`,
    { Accept: 'application/json', Authorization: `Bearer ${settings.token}` }, fetchForPolicy('grafana-api'),
  );
  const query = settings.query?.trim().toLowerCase();
  return alerts.flatMap((alert) => {
    if (alert.status?.state && alert.status.state !== 'active') return [];
    if (alert.status?.silencedBy?.length || alert.status?.inhibitedBy?.length) return [];
    const labels = alert.labels ?? {};
    const annotations = alert.annotations ?? {};
    const name = labels.rulename || labels.alertname || annotations.summary || 'Grafana alert';
    const summary = [annotations.summary, annotations.description, labels.grafana_folder ? `Folder: ${labels.grafana_folder}` : null]
      .filter((value): value is string => Boolean(value)).join('\n');
    if (query && !`${name}\n${summary}\n${Object.values(labels).join(' ')}`.toLowerCase().includes(query)) return [];
    return [{ provider: 'grafana', title: `Investigate Grafana alert: ${name}`.slice(0, 240), summary: summary || 'A Grafana alert is firing and requires investigation.', url: alert.generatorURL || null, occurredAt: alert.updatedAt || alert.startsAt || null, activeWork: true }];
  }).slice(0, 30);
}

const scanners: Partial<Record<SourceProvider, (settings: Record<string, string>, fetchForPolicy?: OutboundFetchFactory) => Promise<SourceSignal[]>>> = { github: scanGitHub, slack: scanSlackMcp, confluence: scanConfluence, grafana: scanGrafana, gmail: scanGmail };

export function scanSource(provider: SourceProvider, settings: Record<string, string>, fetchForPolicy: OutboundFetchFactory = createOutboundFetch, saveCredentials?: (stored: Record<string, unknown>) => void): Promise<SourceSignal[]> {
  if (provider === 'gmail' && settings.serverUrl) return Promise.reject(assertApprovedMcpServer('gmail', settings.serverUrl));
  if ((provider === 'slack' || provider === 'figma' || provider === 'confluence') && settings.serverUrl) return scanRemoteMcp(provider, settings, undefined, saveCredentials);
  const scanner = scanners[provider];
  if (!scanner) throw new Error(`${provider} source settings are incomplete. Reconnect this source.`);
  return scanner(settings, fetchForPolicy);
}

export async function scanConnectedSources(repository: WorkItemRepository): Promise<{ signals: SourceSignal[]; errors: string[] }> {
  const connections = repository.listSourceConnections();
  const results = await Promise.all(connections.map(async ({ provider }) => {
    try {
      const signals = await scanSource(provider, repository.getSourceSettings(provider)!, createOutboundFetch, (next) => repository.updateSourceSettings(provider, next));
      repository.updateSourceScan(provider, null);
      return { signals, error: null };
    } catch (error) {
      const needsAuth = isMcpReauthenticationError(error);
      const message = needsAuth ? mcpAuthenticationMessage(provider) : error instanceof Error ? error.message : 'Scan failed.';
      if (needsAuth) repository.removeSourceConnection(provider);
      else repository.updateSourceScan(provider, message);
      return { signals: [] as SourceSignal[], error: `${provider}: ${message}` };
    }
  }));
  if (!connections.some(({ provider }) => provider === 'slack')) {
    try { results.push({ signals: await scanSlackWithCodex(), error: null }); }
    catch (error) { results.push({ signals: [], error: `slack: ${error instanceof Error ? error.message : 'Scan failed.'}` }); }
  }
  return { signals: results.flatMap((result) => result.signals), errors: results.flatMap((result) => result.error ? [result.error] : []) };
}
