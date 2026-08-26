import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SourceProvider } from '../shared/contracts.js';
import type { SourceSignal } from './source-scanner.js';
import { assertApprovedMcpServer, createOutboundFetch } from './outbound-policy.js';

interface StoredOAuth { serverUrl: string; tokens?: OAuthTokens; clientInformation?: OAuthClientInformationMixed }
class WorkbenchOAuthProvider implements OAuthClientProvider {
  private verifier = ''; private authUrl: URL | null = null;
  constructor(public readonly redirectUrl: string, private stored: StoredOAuth) {}
  get clientMetadata(): OAuthClientMetadata { return { client_name: 'Workbench', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.stored.clientInformation; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.stored.clientInformation = value; }
  tokens() { return this.stored.tokens; }
  saveTokens(value: OAuthTokens) { this.stored.tokens = value; }
  redirectToAuthorization(url: URL) { this.authUrl = url; }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error('MCP OAuth verifier is missing.'); return this.verifier; }
  authorizationUrl() { return this.authUrl; }
  snapshot() { return this.stored; }
}

type RemoteMcpProvider = Exclude<SourceProvider, 'github' | 'grafana'>;

interface PendingMcp { provider: RemoteMcpProvider; oauth: WorkbenchOAuthProvider; transport: StreamableHTTPClientTransport; client: Client; createdAt: number }
const pending = new Map<string, PendingMcp>();

export function isMcpReauthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /refresh[_ ]token.*invalid|invalid[_ ]grant|token.*(?:expired|revoked)|unauthori[sz]ed|authentication required/i.test(message);
}

export function mcpAuthenticationMessage(provider: SourceProvider): string {
  const name = provider === 'confluence' ? 'Atlassian' : provider === 'gmail' ? 'Google Workspace' : provider.charAt(0).toUpperCase() + provider.slice(1);
  return `${name} authorization expired. Reconnect this source.`;
}

export async function startRemoteMcpOAuth(provider: RemoteMcpProvider, serverUrl: string, callbackBase: string): Promise<string> {
  const approvedServerUrl = assertApprovedMcpServer(provider, serverUrl);
  const state = randomUUID();
  const stored: StoredOAuth = { serverUrl: approvedServerUrl.toString() };
  const oauth = new WorkbenchOAuthProvider(`${callbackBase}/${provider}/mcp/oauth/callback`, stored);
  const transport = new StreamableHTTPClientTransport(approvedServerUrl, { authProvider: oauth, fetch: createOutboundFetch(provider === 'slack' ? 'mcp-slack' : provider === 'figma' ? 'mcp-figma' : 'mcp-atlassian') });
  const client = new Client({ name: 'workbench', version: '0.1.0' });
  try { await client.connect(transport); } catch { /* Expected while OAuth authorization is required. */ }
  const authorizationUrl = oauth.authorizationUrl();
  if (!authorizationUrl) throw new Error('The MCP server did not provide an OAuth authorization flow.');
  authorizationUrl.searchParams.set('state', state);
  pending.set(state, { provider, oauth, transport, client, createdAt: Date.now() });
  for (const [key, value] of pending) if (Date.now() - value.createdAt > 10 * 60_000) pending.delete(key);
  return authorizationUrl.toString();
}

export async function finishRemoteMcpOAuth(provider: RemoteMcpProvider, code: string, state: string): Promise<StoredOAuth> {
  const entry = pending.get(state); pending.delete(state);
  if (!entry || entry.provider !== provider || Date.now() - entry.createdAt > 10 * 60_000) throw new Error('MCP authorization expired. Start the connection again.');
  await entry.transport.finishAuth(code);
  await entry.client.close().catch(() => undefined);
  const verifiedServerUrl = assertApprovedMcpServer(provider, entry.oauth.snapshot().serverUrl);
  const verificationTransport = new StreamableHTTPClientTransport(verifiedServerUrl, { authProvider: entry.oauth, fetch: createOutboundFetch(provider === 'slack' ? 'mcp-slack' : provider === 'figma' ? 'mcp-figma' : 'mcp-atlassian') });
  const verificationClient = new Client({ name: 'workbench', version: '0.1.0' });
  await verificationClient.connect(verificationTransport);
  await verificationClient.listTools();
  await verificationClient.close().catch(() => undefined);
  return entry.oauth.snapshot();
}

export async function scanRemoteMcp(provider: RemoteMcpProvider, settings: Record<string, unknown>, requestedQuery?: string): Promise<SourceSignal[]> {
  const stored = settings as unknown as StoredOAuth;
  if (!stored.serverUrl || !stored.tokens) throw new Error('MCP OAuth credentials are missing. Reconnect this source.');
  const oauth = new WorkbenchOAuthProvider('http://localhost/unused', stored);
  const approvedServerUrl = assertApprovedMcpServer(provider, stored.serverUrl);
  const transport = new StreamableHTTPClientTransport(approvedServerUrl, { authProvider: oauth, fetch: createOutboundFetch(provider === 'slack' ? 'mcp-slack' : provider === 'figma' ? 'mcp-figma' : 'mcp-atlassian') });
  const client = new Client({ name: 'workbench', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const tool = tools.find((entry) => entry.name === 'search') ?? tools.find((entry) => /search/i.test(entry.name)) ?? tools.find((entry) => /list|query/i.test(entry.name));
    if (!tool) throw new Error('The MCP server did not expose a searchable tool.');
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const args: Record<string, string | number> = {};
    const query = requestedQuery || (provider === 'confluence' ? 'recent Jira and Confluence work relevant to me' : provider === 'slack' ? 'recent messages requiring my attention' : provider === 'figma' ? 'recent Figma files relevant to me' : 'recent messages and files requiring my attention');
    for (const key of ['query', 'search_query', 'text', 'cql']) if (key in properties) { args[key] = query; break; }
    if ('limit' in properties) args.limit = 30;
    const result = await client.callTool({ name: tool.name, arguments: args });
    if ((result as { isError?: boolean }).isError) {
      const errorText = ((result as { content?: Array<{ type?: string; text?: string }> }).content ?? []).filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '').join('\n').trim();
      throw new Error(errorText || `${provider} MCP search failed.`);
    }
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const text = content.filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '').join('\n').trim();
    if (provider === 'confluence' && tool.name === 'search' && text) {
      try {
        const parsed = JSON.parse(text) as { results?: Array<{ title?: unknown; text?: unknown; url?: unknown; type?: unknown }> };
        if (Array.isArray(parsed.results)) {
          const terms = (requestedQuery ?? '').toLowerCase().split(/\s+/).filter((term) => term.length > 1);
          const ranked = parsed.results.map((entry, index) => {
            const title = typeof entry.title === 'string' ? entry.title.toLowerCase() : '';
            const body = typeof entry.text === 'string' ? entry.text.toLowerCase() : '';
            const score = terms.reduce((total, term) => total + (title.includes(term) ? 20 : 0) + (body.includes(term) ? 3 : 0), 0);
            return { entry, index, score };
          }).filter(({ score }) => !terms.length || score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
          return ranked.slice(0, 30).flatMap(({ entry }) => {
          if (typeof entry.title !== 'string') return [];
          const type = typeof entry.type === 'string' ? entry.type : 'result';
          return [{ provider, title: entry.title.slice(0, 240), summary: `${type === 'issue' ? 'Jira issue' : type === 'page' ? 'Confluence page' : 'Atlassian result'}${typeof entry.text === 'string' && entry.text.trim() ? `\n${entry.text.trim().slice(0, 2_000)}` : ''}`, url: typeof entry.url === 'string' ? entry.url : null, occurredAt: null }];
          });
        }
      } catch { throw new Error('Atlassian returned malformed search results.'); }
    }
    return text ? [{ provider, title: `${provider === 'confluence' ? 'Atlassian' : provider === 'slack' ? 'Slack' : provider === 'figma' ? 'Figma' : 'Google Workspace'} activity`, summary: text.slice(0, 12_000), url: null, occurredAt: new Date().toISOString() }] : [];
  } finally { await client.close().catch(() => undefined); }
}
