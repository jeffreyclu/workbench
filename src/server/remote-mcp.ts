import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SourceProvider } from '../shared/contracts.js';
import type { SourceSignal } from './source-scanner.js';
import { assertApprovedMcpServer, createOutboundFetch } from './outbound-policy.js';

export interface StoredOAuth { serverUrl: string; tokens?: OAuthTokens; clientInformation?: OAuthClientInformationMixed; credentialSource?: string }

interface ClaudeMcpCredential {
  serverUrl: string;
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret?: string;
  expiresAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function storedMcpCredentialsFromClaudeKeychain(payload: unknown, serverUrl: string): StoredOAuth | null {
  if (!isRecord(payload) || !isRecord(payload.mcpOAuth)) return null;
  const credentials = Object.values(payload.mcpOAuth).flatMap((value): ClaudeMcpCredential[] => {
    if (!isRecord(value) || value.serverUrl !== serverUrl || typeof value.accessToken !== 'string' || typeof value.clientId !== 'string') return [];
    return [{
      serverUrl,
      accessToken: value.accessToken,
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : undefined,
      clientId: value.clientId,
      clientSecret: typeof value.clientSecret === 'string' ? value.clientSecret : undefined,
      expiresAt: typeof value.expiresAt === 'number' ? value.expiresAt : undefined,
    }];
  }).sort((left, right) => (right.expiresAt ?? 0) - (left.expiresAt ?? 0));
  const credential = credentials[0];
  if (!credential) return null;
  return {
    serverUrl,
    credentialSource: 'claude-code',
    tokens: {
      access_token: credential.accessToken,
      token_type: 'Bearer',
      ...(credential.refreshToken ? { refresh_token: credential.refreshToken } : {}),
      ...(credential.expiresAt ? { expires_in: Math.max(1, Math.floor((credential.expiresAt - Date.now()) / 1_000)) } : {}),
    },
    clientInformation: {
      client_id: credential.clientId,
      ...(credential.clientSecret ? { client_secret: credential.clientSecret } : {}),
    },
  };
}

export function importSupportedMcpCredentials(serverUrl: string): StoredOAuth | null {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return storedMcpCredentialsFromClaudeKeychain(JSON.parse(raw), serverUrl);
  } catch { return null; }
}
class WorkbenchOAuthProvider implements OAuthClientProvider {
  private verifier = ''; private authUrl: URL | null = null;
  constructor(public readonly redirectUrl: string, private stored: StoredOAuth, private readonly onCredentialsChanged?: (stored: StoredOAuth) => void) {}
  get clientMetadata(): OAuthClientMetadata { return { client_name: 'Workbench', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.stored.clientInformation; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.stored.clientInformation = value; this.onCredentialsChanged?.(this.snapshot()); }
  tokens() { return this.stored.tokens; }
  saveTokens(value: OAuthTokens) { this.stored.tokens = value; this.onCredentialsChanged?.(this.snapshot()); }
  redirectToAuthorization(url: URL) { this.authUrl = url; }
  saveCodeVerifier(value: string) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error('MCP OAuth verifier is missing.'); return this.verifier; }
  authorizationUrl() { return this.authUrl; }
  snapshot() { return this.stored; }
}

type RemoteMcpProvider = Exclude<SourceProvider, 'github' | 'grafana'>;

function mcpPolicy(provider: RemoteMcpProvider) {
  return provider === 'slack' ? 'mcp-slack' : provider === 'figma' ? 'mcp-figma' : 'mcp-atlassian';
}

interface PendingMcp { provider: RemoteMcpProvider; oauth: WorkbenchOAuthProvider; transport: StreamableHTTPClientTransport; client: Client; createdAt: number }
const pending = new Map<string, PendingMcp>();

export function isMcpReauthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /refresh[_ ]token.*invalid|invalid[_ ]grant|token.*(?:expired|revoked)|unauthori[sz]ed|authentication required/i.test(message);
}

export function isMcpReauthenticationMessage(message: string): boolean {
  return /authorization expired\. Reconnect this source\.$/.test(message);
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
  const transport = new StreamableHTTPClientTransport(approvedServerUrl, { authProvider: oauth, fetch: createOutboundFetch(mcpPolicy(provider)) });
  const client = new Client({ name: 'workbench', version: '0.1.0' });
  let connectionError: unknown;
  try { await client.connect(transport); } catch (error) { connectionError = error; /* Expected while OAuth authorization is required. */ }
  const authorizationUrl = oauth.authorizationUrl();
  if (!authorizationUrl) {
    const detail = connectionError instanceof Error ? connectionError.message : connectionError ? String(connectionError) : '';
    await client.close().catch(() => undefined);
    throw new Error(detail ? `Could not start the MCP OAuth flow: ${detail}` : 'The MCP server did not provide an OAuth authorization flow.');
  }
  authorizationUrl.searchParams.set('state', state);
  pending.set(state, { provider, oauth, transport, client, createdAt: Date.now() });
  for (const [key, value] of pending) {
    if (Date.now() - value.createdAt <= 10 * 60_000) continue;
    pending.delete(key);
    void value.client.close().catch(() => undefined);
  }
  return authorizationUrl.toString();
}

export async function verifyRemoteMcpCredentials(provider: RemoteMcpProvider, stored: StoredOAuth): Promise<StoredOAuth> {
  const approvedServerUrl = assertApprovedMcpServer(provider, stored.serverUrl);
  const oauth = new WorkbenchOAuthProvider('http://127.0.0.1/unused', stored);
  const transport = new StreamableHTTPClientTransport(approvedServerUrl, { authProvider: oauth, fetch: createOutboundFetch(mcpPolicy(provider)) });
  const client = new Client({ name: 'workbench', version: '0.1.0' });
  try {
    await client.connect(transport);
    await client.listTools();
    return oauth.snapshot();
  } finally { await client.close().catch(() => undefined); }
}

export async function finishRemoteMcpOAuth(provider: RemoteMcpProvider, code: string, state: string): Promise<StoredOAuth> {
  const entry = pending.get(state); pending.delete(state);
  if (!entry || entry.provider !== provider || Date.now() - entry.createdAt > 10 * 60_000) throw new Error('MCP authorization expired. Start the connection again.');
  await entry.transport.finishAuth(code);
  await entry.client.close().catch(() => undefined);
  const verifiedServerUrl = assertApprovedMcpServer(provider, entry.oauth.snapshot().serverUrl);
  const verificationTransport = new StreamableHTTPClientTransport(verifiedServerUrl, { authProvider: entry.oauth, fetch: createOutboundFetch(mcpPolicy(provider)) });
  const verificationClient = new Client({ name: 'workbench', version: '0.1.0' });
  await verificationClient.connect(verificationTransport);
  await verificationClient.listTools();
  await verificationClient.close().catch(() => undefined);
  return entry.oauth.snapshot();
}

export interface FigmaMcpTarget { fileKey: string; nodeId?: string; url: string; title: string }

export function figmaMcpTarget(value: string): FigmaMcpTarget | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['figma.com', 'www.figma.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/(?:design|file|board)\/([^/]+)(?:\/([^/]+))?/);
    if (!match) return null;
    const rawNodeId = url.searchParams.get('node-id');
    const nodeId = rawNodeId?.match(/^\d+-\d+$/) ? rawNodeId.replace('-', ':') : rawNodeId ?? undefined;
    return {
      fileKey: decodeURIComponent(match[1]),
      ...(nodeId ? { nodeId } : {}),
      url: url.toString(),
      title: match[2] ? decodeURIComponent(match[2]).replace(/[-_]+/g, ' ') : `Figma file ${match[1]}`,
    };
  } catch { return null; }
}

function figmaTargets(settings: Record<string, unknown>, requestedQuery?: string): { targets: FigmaMcpTarget[]; searchQuery: string | null } {
  const directTarget = requestedQuery ? figmaMcpTarget(requestedQuery) : null;
  if (directTarget) return { targets: [directTarget], searchQuery: null };
  let roots: unknown = [];
  try { roots = typeof settings.figmaRoots === 'string' ? JSON.parse(settings.figmaRoots) : settings.figmaRoots; } catch { /* Invalid saved scope is reported below. */ }
  const targets = Array.isArray(roots) ? roots.flatMap((root) => typeof root === 'string' ? [figmaMcpTarget(root)].filter((target): target is FigmaMcpTarget => Boolean(target)) : []) : [];
  if (!targets.length) throw new Error('Add at least one valid Figma file, page, or node URL to the source scope.');
  return { targets, searchQuery: requestedQuery?.trim() || null };
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.filter((entry) => entry.type === 'text').map((entry) => entry.text ?? '').join('\n').trim();
}

function parseToolJson<T>(result: unknown, label: string): T {
  const text = toolText(result);
  if ((result as { isError?: boolean }).isError) throw new Error(text || `${label} failed.`);
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`${label} returned malformed data.`); }
}

async function scanAtlassianAssignedWork(client: Client, toolNames: Set<string>): Promise<SourceSignal[]> {
  if (!toolNames.has('getAccessibleAtlassianResources') || !toolNames.has('searchJiraIssuesUsingJql')) return [];
  const resources = parseToolJson<Array<{ id?: unknown; url?: unknown }>>(
    await client.callTool({ name: 'getAccessibleAtlassianResources', arguments: {} }),
    'Atlassian resource lookup',
  );
  const resource = resources.find((entry) => typeof entry.id === 'string' && typeof entry.url === 'string');
  if (!resource || typeof resource.id !== 'string' || typeof resource.url !== 'string') throw new Error('Atlassian returned no accessible Jira or Confluence site.');
  const resourceId = resource.id;
  const resourceUrl = resource.url;

  const jiraResult = parseToolJson<{ issues?: Array<{
    key?: unknown;
    fields?: {
      summary?: unknown;
      description?: unknown;
      updated?: unknown;
      status?: { name?: unknown };
      priority?: { name?: unknown };
      project?: { name?: unknown };
    };
  }> }>(await client.callTool({
    name: 'searchJiraIssuesUsingJql',
    arguments: {
      cloudId: resourceId,
      jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
      maxResults: 30,
      fields: ['summary', 'description', 'status', 'priority', 'updated', 'assignee', 'project'],
      responseContentFormat: 'markdown',
    },
  }), 'Atlassian Jira search');

  const jiraSignals = (jiraResult.issues ?? []).flatMap((issue): SourceSignal[] => {
    const fields = issue.fields ?? {};
    if (typeof issue.key !== 'string' || typeof fields.summary !== 'string') return [];
    const context = [
      `Open Jira work assigned to you (${issue.key}).`,
      typeof fields.status?.name === 'string' ? `Status: ${fields.status.name}` : null,
      typeof fields.priority?.name === 'string' ? `Priority: ${fields.priority.name}` : null,
      typeof fields.project?.name === 'string' ? `Project: ${fields.project.name}` : null,
      typeof fields.description === 'string' ? fields.description : null,
    ].filter((value): value is string => Boolean(value)).join('\n');
    return [{
      provider: 'confluence',
      title: `${issue.key} · ${fields.summary}`.slice(0, 240),
      summary: context.slice(0, 12_000),
      url: `${resourceUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(issue.key)}`,
      occurredAt: typeof fields.updated === 'string' ? fields.updated : null,
      activeWork: true,
    }];
  });

  if (!toolNames.has('searchConfluenceUsingCql')) return jiraSignals;
  const mentionResult = parseToolJson<{ results?: Array<{
    title?: unknown;
    excerpt?: unknown;
    url?: unknown;
    lastModified?: unknown;
    content?: { _links?: { webui?: unknown }; title?: unknown };
  }> }>(await client.callTool({
    name: 'searchConfluenceUsingCql',
    arguments: {
      cloudId: resourceId,
      cql: 'type = comment AND mention = currentUser() ORDER BY created DESC',
      limit: 30,
      expand: 'content.version,content.history',
    },
  }), 'Atlassian Confluence mention search');
  const mentionSignals = (mentionResult.results ?? []).flatMap((entry): SourceSignal[] => {
    const title = typeof entry.title === 'string' ? entry.title : typeof entry.content?.title === 'string' ? entry.content.title : null;
    if (!title) return [];
    const path = typeof entry.url === 'string' ? entry.url : typeof entry.content?._links?.webui === 'string' ? entry.content._links.webui : null;
    return [{
      provider: 'confluence',
      title: `Confluence mention: ${title}`.slice(0, 240),
      summary: `A Confluence comment mentions you.${typeof entry.excerpt === 'string' && entry.excerpt.trim() ? `\n${entry.excerpt.trim().slice(0, 2_000)}` : ''}`,
      url: path ? new URL(path, resourceUrl).toString() : null,
      occurredAt: typeof entry.lastModified === 'string' ? entry.lastModified : null,
      activeWork: true,
    }];
  });
  return [...jiraSignals, ...mentionSignals];
}

export async function scanRemoteMcp(provider: RemoteMcpProvider, settings: Record<string, unknown>, requestedQuery?: string, saveCredentials?: (stored: Record<string, unknown>) => void): Promise<SourceSignal[]> {
  const stored = settings as unknown as StoredOAuth;
  if (!stored.serverUrl || !stored.tokens) throw new Error('MCP OAuth credentials are missing. Reconnect this source.');
  const oauth = new WorkbenchOAuthProvider('http://127.0.0.1/unused', stored, (next) => saveCredentials?.(next as unknown as Record<string, unknown>));
  const approvedServerUrl = assertApprovedMcpServer(provider, stored.serverUrl);
  const transport = new StreamableHTTPClientTransport(approvedServerUrl, { authProvider: oauth, fetch: createOutboundFetch(mcpPolicy(provider)) });
  const client = new Client({ name: 'workbench', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    if (provider === 'figma') {
      const { targets, searchQuery } = figmaTargets(settings, requestedQuery);
      const toolName = searchQuery ? 'search_design_system' : 'get_metadata';
      if (!tools.some((entry) => entry.name === toolName)) throw new Error(`Figma MCP did not expose ${toolName}.`);
      return await Promise.all(targets.map(async (target) => {
        const result = await client.callTool({
          name: toolName,
          arguments: searchQuery
            ? { query: searchQuery, fileKey: target.fileKey }
            : { fileKey: target.fileKey, ...(target.nodeId ? { nodeId: target.nodeId } : {}) },
        });
        const text = toolText(result);
        if ((result as { isError?: boolean }).isError) throw new Error(text || 'Figma MCP request failed.');
        return { provider, title: target.title, summary: text.slice(0, 12_000), url: target.url, occurredAt: null, referenceOnly: true };
      }));
    }
    if (provider === 'confluence' && !requestedQuery) {
      const assignedWork = await scanAtlassianAssignedWork(client, new Set(tools.map((entry) => entry.name)));
      if (assignedWork.length > 0 || tools.some((entry) => entry.name === 'searchJiraIssuesUsingJql')) return assignedWork;
    }
    const tool = tools.find((entry) => entry.name === 'search') ?? tools.find((entry) => /search/i.test(entry.name)) ?? tools.find((entry) => /list|query/i.test(entry.name));
    if (!tool) throw new Error('The MCP server did not expose a searchable tool.');
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const args: Record<string, string | number> = {};
    const query = requestedQuery || (provider === 'confluence' ? 'recent Jira and Confluence work relevant to me' : provider === 'slack' ? 'recent messages requiring my attention' : 'recent messages and files requiring my attention');
    for (const key of ['query', 'search_query', 'text', 'cql']) if (key in properties) { args[key] = query; break; }
    if ('limit' in properties) args.limit = 30;
    const result = await client.callTool({ name: tool.name, arguments: args });
    if ((result as { isError?: boolean }).isError) {
      const errorText = toolText(result);
      throw new Error(errorText || `${provider} MCP search failed.`);
    }
    const text = toolText(result);
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
    return text ? [{ provider, title: `${provider === 'confluence' ? 'Atlassian' : provider === 'slack' ? 'Slack' : 'Google Workspace'} activity`, summary: text.slice(0, 12_000), url: null, occurredAt: new Date().toISOString() }] : [];
  } finally { await client.close().catch(() => undefined); }
}
