import type { SourceProvider } from '../shared/contracts.js';
import { WorkItemRepository } from './repository.js';
import { scanSlackMcp } from './slack-mcp.js';
import { isMcpReauthenticationError, mcpAuthenticationMessage, scanRemoteMcp } from './remote-mcp.js';
import { scanSlackWithCodex } from './slack-codex.js';

export interface SourceSignal { provider: string; title: string; summary: string; url: string | null; occurredAt: string | null; }

async function requestJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function scanGitHub(settings: Record<string, string>): Promise<SourceSignal[]> {
  const query = (settings.query || 'is:open is:pr review-requested:@me').replace(/\b(?:org|user):(?:"[^"]+"|\S+)/gi, '').trim();
  const organizations = ['writer', 'WriterInternal', 'WriterColab'];
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${settings.token}`, 'User-Agent': 'workbench-local' };
  const responses = await Promise.all(organizations.map((organization) => requestJson<{ items: Array<{ title: string; body: string | null; html_url: string; updated_at: string; repository_url: string }> }>(
    `https://api.github.com/search/issues?q=${encodeURIComponent(`${query} org:${organization}`)}&sort=updated&order=desc&per_page=15`, headers,
  )));
  const unique = new Map(responses.flatMap((response) => response.items).map((item) => [item.html_url, item]));
  return [...unique.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, 30)
    .map((item) => ({ provider: 'github', title: item.title, summary: item.body?.slice(0, 1_000) || item.repository_url, url: item.html_url, occurredAt: item.updated_at }));
}

async function scanConfluence(settings: Record<string, string>): Promise<SourceSignal[]> {
  const site = settings.siteUrl.replace(/\/$/, '');
  const cql = settings.cql || 'type in (page, blogpost) order by lastmodified desc';
  const auth = Buffer.from(`${settings.email}:${settings.token}`).toString('base64');
  const data = await requestJson<{ results: Array<{ title: string; excerpt?: string; url?: string; lastModified?: string; content?: { _links?: { webui?: string } } }> }>(
    `${site}/wiki/rest/api/search?limit=30&cql=${encodeURIComponent(cql)}`,
    { Accept: 'application/json', Authorization: `Basic ${auth}` },
  );
  return data.results.map((result) => ({ provider: 'confluence', title: result.title, summary: result.excerpt ?? '', url: result.url ?? (result.content?._links?.webui ? `${site}/wiki${result.content._links.webui}` : null), occurredAt: result.lastModified ?? null }));
}

async function scanGmail(settings: Record<string, string>): Promise<SourceSignal[]> {
  const list = await requestJson<{ messages?: Array<{ id: string }> }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=30&q=${encodeURIComponent(settings.query || 'newer_than:1d')}`,
    { Authorization: `Bearer ${settings.accessToken}` },
  );
  return Promise.all((list.messages ?? []).map(async ({ id }) => {
    const message = await requestJson<{ snippet: string; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }> } }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
      { Authorization: `Bearer ${settings.accessToken}` },
    );
    const headers = message.payload?.headers ?? [];
    const subject = headers.find((header) => header.name.toLowerCase() === 'subject')?.value || 'Email';
    const from = headers.find((header) => header.name.toLowerCase() === 'from')?.value || '';
    return { provider: 'gmail', title: subject, summary: `${from}\n${message.snippet}`, url: `https://mail.google.com/mail/u/0/#all/${id}`, occurredAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null };
  }));
}

const scanners: Record<SourceProvider, (settings: Record<string, string>) => Promise<SourceSignal[]>> = { github: scanGitHub, slack: scanSlackMcp, confluence: scanConfluence, gmail: scanGmail };

export function scanSource(provider: SourceProvider, settings: Record<string, string>): Promise<SourceSignal[]> {
  if ((provider === 'slack' || provider === 'confluence' || provider === 'gmail') && settings.serverUrl) return scanRemoteMcp(provider, settings);
  return scanners[provider](settings);
}

export async function scanConnectedSources(repository: WorkItemRepository): Promise<{ signals: SourceSignal[]; errors: string[] }> {
  const connections = repository.listSourceConnections();
  const results = await Promise.all(connections.map(async ({ provider }) => {
    try {
      const signals = await scanSource(provider, repository.getSourceSettings(provider)!);
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
