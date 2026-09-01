import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { recordAudit } from './audit-log.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

export class OutboundPolicyError extends Error {
  constructor(public readonly code: 'OUTBOUND_URL_BLOCKED' | 'OUTBOUND_REDIRECT_BLOCKED' | 'OUTBOUND_RESPONSE_TOO_LARGE', message: string) {
    super(message);
    this.name = 'OutboundPolicyError';
  }
}

export interface DnsAnswer { address: string; family: 4 | 6; }
export interface OutboundPolicyDependencies {
  resolve?(hostname: string): Promise<DnsAnswer[]>;
  transport?(input: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }): Promise<Response>;
  audit?(detail: string): void;
}

type HostRule = { hostname: string; subdomains?: boolean; path?: string };
export type OutboundPolicyName = 'source-page' | 'github-api' | 'gmail-api' | 'linear-api' | 'atlassian-api' | 'grafana-api' | 'slack-oauth' | 'mcp-slack' | 'mcp-figma' | 'mcp-atlassian';

const rules: Record<OutboundPolicyName, HostRule[]> = {
  'source-page': [
    { hostname: 'claude.ai' }, { hostname: 'github.com' }, { hostname: 'slack.com', subdomains: true },
    { hostname: 'atlassian.net', subdomains: true }, { hostname: 'mail.google.com' }, { hostname: 'linear.app', subdomains: true },
  ],
  'github-api': [{ hostname: 'api.github.com' }],
  'gmail-api': [{ hostname: 'gmail.googleapis.com' }],
  'linear-api': [{ hostname: 'api.linear.app' }],
  'atlassian-api': [{ hostname: 'atlassian.net', subdomains: true }],
  'grafana-api': [{ hostname: 'grafana.observability.writer.com' }],
  'slack-oauth': [{ hostname: 'slack.com' }],
  // Each MCP policy contains its fixed transport endpoint plus only the vendor
  // OAuth origins its SDK flow may discover, register against, or use for tokens.
  // Do not add arbitrary OAuth URLs from server metadata here.
  // Slack redirects OAuth discovery from mcp.slack.com to a region-specific
  // mcp-*.slack.com host. The configured transport endpoint is validated
  // independently by assertApprovedMcpServer below.
  'mcp-slack': [{ hostname: 'slack.com', subdomains: true }],
  // Figma publishes protected-resource metadata beneath /.well-known on the
  // MCP host before directing OAuth registration and token exchange to
  // api.figma.com. The configured transport endpoint is still constrained to
  // /mcp by assertApprovedMcpServer below.
  'mcp-figma': [{ hostname: 'mcp.figma.com' }, { hostname: 'www.figma.com' }, { hostname: 'api.figma.com' }],
  'mcp-atlassian': [
    // No path restriction on mcp.atlassian.com: the SDK's OAuth discovery flow
    // fetches /.well-known/oauth-protected-resource/<mcp-path> and
    // /.well-known/oauth-authorization-server on this same host before the
    // transport call to /v1/mcp/authv2, so a fixed-path rule blocks discovery.
    { hostname: 'mcp.atlassian.com' }, { hostname: 'auth.atlassian.com' }, { hostname: 'api.atlassian.com' },
  ],
};

function sanitizedUrl(url: URL): string { return `${url.origin}${url.pathname}`; }
function sameHost(rule: HostRule, hostname: string): boolean {
  return hostname === rule.hostname || Boolean(rule.subdomains && hostname.endsWith(`.${rule.hostname}`));
}

function allowedUrl(name: OutboundPolicyName, value: URL): boolean {
  if (value.protocol !== 'https:' || value.username || value.password) return false;
  return rules[name].some((rule) => sameHost(rule, value.hostname) && (!rule.path || value.pathname === rule.path));
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  const inRange = (base: number, bits: number) => (value >>> (32 - bits)) === (base >>> (32 - bits));
  return inRange(0x00000000, 8) || inRange(0x0a000000, 8) || inRange(0x64400000, 10)
    || inRange(0x7f000000, 8) || inRange(0xa9fe0000, 16) || inRange(0xac100000, 12)
    || inRange(0xc0a80000, 16) || inRange(0xc6120000, 15) || inRange(0xe0000000, 3);
}

function ipv6Value(address: string): bigint | null {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const expand = (half: string) => half ? half.split(':').filter(Boolean) : [];
  const left = expand(halves[0]);
  const right = expand(halves[1] ?? '');
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && left.length !== 8) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family !== 6) return true;
  const value = ipv6Value(address);
  if (value === null) return true;
  const prefix = (bits: bigint) => value >> (128n - bits);
  if (value === 0n || value === 1n || prefix(10n) === 0b1111111010n || prefix(7n) === 0b1111110n) return true;
  const mappedPrefix = value >> 32n;
  return mappedPrefix === 0xffffn && isBlockedIpv4((value & 0xffffffffn).toString(16).match(/../g)?.map((part) => String(parseInt(part, 16))).join('.') ?? '');
}

function redirectMethod(method: string, status: number): string {
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) return 'GET';
  return method;
}

function bodyForRedirect(method: string, body: RequestInit['body']): RequestInit['body'] {
  return method === 'GET' || method === 'HEAD' ? undefined : body ?? undefined;
}

function limitedResponse(response: Response, dispatcher: Agent, audit: (detail: string) => void, name: OutboundPolicyName, url: URL): Response {
  if (!response.body) {
    void dispatcher.close();
    return response;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void dispatcher.close();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          close();
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          audit(`blocked policy=${name} url=${sanitizedUrl(url)} reason=response_too_large streamed_bytes=${bytes}`);
          await reader.cancel();
          close();
          controller.error(new OutboundPolicyError('OUTBOUND_RESPONSE_TOO_LARGE', 'The outbound response exceeds the 2 MiB limit.'));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { close(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createOutboundFetch(name: OutboundPolicyName, dependencies: OutboundPolicyDependencies = {}): typeof fetch {
  const resolve = dependencies.resolve ?? (async (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }) as Promise<DnsAnswer[]>);
  const transport = dependencies.transport ?? ((input, init) => undiciFetch(input as never, init as never));
  const audit = dependencies.audit ?? ((detail: string) => recordAudit('outbound_call', name, detail));

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    let method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = init?.body;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));

    for (let redirects = 0; ; redirects += 1) {
      if (!allowedUrl(name, url)) {
        audit(`blocked policy=${name} url=${sanitizedUrl(url)}`);
        throw new OutboundPolicyError(redirects ? 'OUTBOUND_REDIRECT_BLOCKED' : 'OUTBOUND_URL_BLOCKED', 'This outbound URL is not approved for this provider.');
      }
      const answers = isIP(url.hostname) ? [{ address: url.hostname, family: isIP(url.hostname) as 4 | 6 }] : await resolve(url.hostname);
      if (!answers.length || answers.some((answer) => isBlockedAddress(answer.address))) {
        audit(`blocked policy=${name} url=${sanitizedUrl(url)} reason=non_public_address`);
        throw new OutboundPolicyError(redirects ? 'OUTBOUND_REDIRECT_BLOCKED' : 'OUTBOUND_URL_BLOCKED', 'This outbound URL resolves to a blocked network address.');
      }
      const lookup = (_hostname: string, options: { all?: boolean }, callback: (error: Error | null, address: string | DnsAnswer[], family?: 4 | 6) => void) => {
        if (options.all) callback(null, answers);
        else callback(null, answers[0].address, answers[0].family);
      };
      const dispatcher = new Agent({ connect: { lookup } });
      audit(`attempt policy=${name} method=${method} url=${sanitizedUrl(url)}`);
      let response: Response;
      try {
        response = await transport(url, { ...init, method, body: bodyForRedirect(method, body), headers, redirect: 'manual', dispatcher } as never);
      } catch (error) {
        audit(`outcome policy=${name} url=${sanitizedUrl(url)} error=transport_failure`);
        void dispatcher.close();
        throw error;
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (redirects >= MAX_REDIRECTS) {
          await response.body?.cancel();
          void dispatcher.close();
          audit(`blocked policy=${name} url=${sanitizedUrl(url)} reason=redirect_limit`);
          throw new OutboundPolicyError('OUTBOUND_REDIRECT_BLOCKED', 'The outbound request exceeded the redirect limit.');
        }
        const next = new URL(response.headers.get('location')!, url);
        if (next.protocol !== 'https:' || !allowedUrl(name, next)) {
          await response.body?.cancel();
          void dispatcher.close();
          audit(`blocked policy=${name} from=${sanitizedUrl(url)} to=${sanitizedUrl(next)} reason=redirect_target`);
          throw new OutboundPolicyError('OUTBOUND_REDIRECT_BLOCKED', 'The outbound redirect target is not approved for this provider.');
        }
        if (next.origin !== url.origin) SENSITIVE_HEADERS.forEach((header) => headers.delete(header));
        audit(`redirect policy=${name} from=${sanitizedUrl(url)} to=${sanitizedUrl(next)} status=${response.status}`);
        void dispatcher.close();
        method = redirectMethod(method, response.status);
        url = next;
        continue;
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        void dispatcher.close();
        audit(`blocked policy=${name} url=${sanitizedUrl(url)} reason=response_too_large declared_bytes=${declared}`);
        throw new OutboundPolicyError('OUTBOUND_RESPONSE_TOO_LARGE', 'The outbound response exceeds the 2 MiB limit.');
      }
      audit(`outcome policy=${name} url=${sanitizedUrl(url)} status=${response.status}`);
      return limitedResponse(response, dispatcher, audit, name, url);
    }
  }) as typeof fetch;
}

export function assertApprovedMcpServer(provider: 'slack' | 'figma' | 'confluence' | 'gmail', value: string): URL {
  if (provider === 'gmail') throw new OutboundPolicyError('OUTBOUND_URL_BLOCKED', 'Gmail MCP server overrides are not approved. Use the Gmail source connection.');
  const url = new URL(value);
  const policy = provider === 'slack' ? 'mcp-slack' : provider === 'figma' ? 'mcp-figma' : 'mcp-atlassian';
  const canonicalTransport = provider === 'slack' ? { hostname: 'mcp.slack.com', pathname: '/mcp' }
    : provider === 'figma' ? { hostname: 'mcp.figma.com', pathname: '/mcp' }
      : { hostname: 'mcp.atlassian.com', pathname: '/v1/mcp/authv2' };
  const isApprovedTransport = url.hostname === canonicalTransport.hostname
    && url.pathname === canonicalTransport.pathname && !url.search && !url.hash;
  if (!allowedUrl(policy, url) || !isApprovedTransport) throw new OutboundPolicyError('OUTBOUND_URL_BLOCKED', 'This MCP server URL is not approved for this provider.');
  return url;
}
