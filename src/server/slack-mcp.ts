import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { SourceSignal } from './source-scanner.js';
import { recordAudit } from './audit-log.js';

const slackMcpUrl = 'https://mcp.slack.com/mcp';
const slackAuthorizationUrl = 'https://slack.com/oauth/v2_user/authorize';
const slackTokenUrl = 'https://slack.com/api/oauth.v2.user.access';
const slackScopes = ['search:read.public', 'search:read.private', 'search:read.mpim', 'search:read.im'];

interface PendingAuthorization { verifier: string; createdAt: number }
const pendingAuthorizations = new Map<string, PendingAuthorization>();

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

export function slackOAuthConfigured(): boolean {
  return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

export function slackRedirectUri(): string {
  return process.env.SLACK_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? 4317}/api/source-connections/slack/oauth/callback`;
}

export function createSlackAuthorizationUrl(): string {
  if (!slackOAuthConfigured()) throw new Error('Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in .env first.');
  const state = randomUUID();
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  pendingAuthorizations.set(state, { verifier, createdAt: Date.now() });
  for (const [key, value] of pendingAuthorizations) {
    if (Date.now() - value.createdAt > 10 * 60_000) pendingAuthorizations.delete(key);
  }
  const url = new URL(slackAuthorizationUrl);
  url.searchParams.set('client_id', process.env.SLACK_CLIENT_ID!);
  url.searchParams.set('redirect_uri', slackRedirectUri());
  url.searchParams.set('user_scope', slackScopes.join(','));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeSlackAuthorization(code: string, state: string): Promise<{ accessToken: string; label: string }> {
  const pending = pendingAuthorizations.get(state);
  pendingAuthorizations.delete(state);
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error('Slack authorization expired. Start the connection again.');
  const body = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID!, client_secret: process.env.SLACK_CLIENT_SECRET!, code,
    redirect_uri: slackRedirectUri(), code_verifier: pending.verifier,
  });
  recordAudit('outbound_call', 'slack', `POST ${slackTokenUrl} (oauth token exchange)`);
  const response = await fetch(slackTokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) });
  const result = await response.json() as { ok?: boolean; error?: string; authed_user?: { access_token?: string }; team?: { name?: string } };
  if (!response.ok || !result.ok || !result.authed_user?.access_token) throw new Error(result.error ?? 'Slack did not return a user access token.');
  return { accessToken: result.authed_user.access_token, label: result.team?.name ? `Slack · ${result.team.name}` : 'Slack workspace' };
}

function textFromResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n').trim();
}

export async function scanSlackMcp(settings: Record<string, string>): Promise<SourceSignal[]> {
  if (!settings.accessToken) throw new Error('Slack OAuth credentials are missing. Reconnect Slack.');
  const client = new Client({ name: 'workbench', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(slackMcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${settings.accessToken}` } },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'slack_search_public_and_private')
      ?? listed.tools.find((candidate) => candidate.name.includes('search') && candidate.name.includes('private'))
      ?? listed.tools.find((candidate) => candidate.name.includes('search'));
    if (!tool) throw new Error('Slack MCP did not expose a search tool for the granted scopes.');
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const query = `${settings.query || 'to:me'} after:${since}`;
    const args: Record<string, string | number> = {};
    if ('query' in properties) args.query = query;
    else if ('search_query' in properties) args.search_query = query;
    else throw new Error(`Slack MCP search tool ${tool.name} has an unsupported input schema.`);
    if ('limit' in properties) args.limit = 50;
    recordAudit('outbound_call', 'slack', `MCP callTool ${tool.name} (${slackMcpUrl})`);
    const result = await client.callTool({ name: tool.name, arguments: args });
    const text = textFromResult(result);
    if (!text) return [];
    return [{ provider: 'slack', title: 'Slack activity requiring attention', summary: text.slice(0, 12_000), url: null, occurredAt: new Date().toISOString() }];
  } finally {
    await client.close().catch(() => undefined);
  }
}
