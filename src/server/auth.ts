import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const authCookieName = 'workbench_token';
const openPaths = new Set(['/api/health']);
const artifactCommentPath = /^\/api\/artifacts\/[A-Za-z0-9_-]{1,64}\/comments$/;

export interface GateRequest {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | null } | null;
}
interface GateResponse { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: string): unknown }

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export function configuredToken(): string | null {
  const token = process.env.WORKBENCH_TOKEN?.trim();
  return token ? token : null;
}

export function tokensMatch(expected: string, candidate: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(candidate));
}

export function readCookie(header: string | undefined, name: string): string | null {
  for (const pair of (header ?? '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return null;
}

function bearerToken(request: GateRequest): string | null {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  return value?.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : null;
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  const bracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  const mapped = bracketed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return (mapped ? mapped[1] : bracketed).toLowerCase();
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    result = (result << 8) | value;
  }
  return result >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const zoneIndex = ip.indexOf('%');
  const address = zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;
  if (!address.includes(':')) return null;
  const doubleColon = address.includes('::');
  if ((address.match(/::/g) ?? []).length > 1) return null;

  const expandGroup = (parts: string[]): string[] | null => {
    if (parts.length === 0) return [];
    const last = parts[parts.length - 1];
    if (last.includes('.')) {
      const ipv4 = ipv4ToInt(last);
      if (ipv4 === null) return null;
      return [...parts.slice(0, -1), ((ipv4 >>> 16) & 0xffff).toString(16), (ipv4 & 0xffff).toString(16)];
    }
    return parts;
  };

  let headParts: string[];
  let tailParts: string[];
  if (doubleColon) {
    const [headRaw, tailRaw] = address.split('::');
    headParts = headRaw ? headRaw.split(':') : [];
    tailParts = tailRaw ? tailRaw.split(':') : [];
  } else {
    headParts = address.split(':');
    tailParts = [];
  }

  const head = expandGroup(headParts);
  const tail = expandGroup(tailParts);
  if (head === null || tail === null) return null;

  const missing = 8 - head.length - tail.length;
  if (doubleColon ? missing < 0 : missing !== 0) return null;
  const groups = doubleColon ? [...head, ...Array(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function matchesCidr(ip: string, cidr: string): boolean {
  const normalizedIp = normalizeIp(ip);
  const [rangeRaw, prefixRaw] = cidr.includes('/') ? cidr.split('/') : [cidr, null];
  const normalizedRange = normalizeIp(rangeRaw);
  const ipv4 = ipv4ToInt(normalizedIp);
  const rangeIpv4 = ipv4ToInt(normalizedRange);
  if (ipv4 !== null && rangeIpv4 !== null) {
    const prefix = prefixRaw ? Number(prefixRaw) : 32;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipv4 & mask) === (rangeIpv4 & mask);
  }
  if (ipv4 !== null || rangeIpv4 !== null) return false;

  const prefix = prefixRaw ? Number(prefixRaw) : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
  const ipBig = ipv6ToBigInt(normalizedIp);
  const rangeBig = ipv6ToBigInt(normalizedRange);
  if (ipBig === null || rangeBig === null) return false;
  const full = (1n << 128n) - 1n;
  const mask = prefix === 0 ? 0n : (full << BigInt(128 - prefix)) & full;
  return (ipBig & mask) === (rangeBig & mask);
}

function isLoopbackIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (normalized === '::1') return true;
  const ipv4 = ipv4ToInt(normalized);
  return ipv4 !== null && (ipv4 >>> 24) === 127;
}

function trustedProxyList(env: NodeJS.ProcessEnv): string[] {
  return (env.WORKBENCH_TRUSTED_PROXIES ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function isTrustedProxyIp(ip: string, trustedProxies: string[]): boolean {
  return trustedProxies.some((cidr) => matchesCidr(ip, cidr));
}

function socketAddress(request: GateRequest): string | null {
  const address = request.socket?.remoteAddress;
  return address ? normalizeIp(address) : null;
}

function forwardedForChain(request: GateRequest): string[] {
  const header = request.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
}

/**
 * The immediate TCP peer is the only address the transport itself vouches for.
 * X-Forwarded-For is client-controlled and only trustworthy for hops behind a
 * peer we have explicitly configured as a trusted proxy, walked right-to-left
 * (nearest hop first) so a spoofed header from an untrusted peer never counts.
 */
function resolveClientAddress(request: GateRequest, trustedProxies: string[]): string | null {
  const peer = socketAddress(request);
  if (!peer) return null;
  if (!isTrustedProxyIp(peer, trustedProxies)) return peer;
  const chain = forwardedForChain(request);
  let client = peer;
  for (let index = chain.length - 1; index >= 0; index--) {
    const hop = normalizeIp(chain[index]);
    client = hop;
    if (!isTrustedProxyIp(hop, trustedProxies)) break;
  }
  return client;
}

function isSecure(request: GateRequest, trustedProxies: string[]): boolean {
  const peer = socketAddress(request);
  if (!peer || !isTrustedProxyIp(peer, trustedProxies)) return false;
  const proto = request.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim() === 'https';
}

/**
 * Coworkers who open a shared artifact hold no Workbench token, so writing
 * feedback back is the single route that answers without one — and only when
 * feedback is configured. Reads of that feedback stay gated: the exemption
 * covers POST and its CORS preflight, never GET.
 */
export function isOpenRequest(pathname: string, method = 'GET', env: NodeJS.ProcessEnv = process.env): boolean {
  if (openPaths.has(pathname)) return true;
  const feedbackConfigured = Boolean(env.WORKBENCH_PUBLIC_URL?.trim() && env.ARTIFACT_PUBLIC_BASE_URL?.trim());
  const upper = method.toUpperCase();
  return feedbackConfigured && (upper === 'POST' || upper === 'OPTIONS') && artifactCommentPath.test(pathname);
}

/**
 * Shared by the HTTP gate and WebSocket upgrade handler. WebSocket clients do
 * not get a request body or a redirect, so they authenticate with the existing
 * same-site cookie (or a trusted proxy's Authorization header) only.
 */
export function isRequestAuthorized(request: GateRequest, token: string | null | undefined = undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const expected = token === undefined ? configuredToken() : token;
  if (!expected) return true;
  const trustedProxies = trustedProxyList(env);
  const client = resolveClientAddress(request, trustedProxies);
  if (client && isLoopbackIp(client)) return true;
  const url = new URL(request.url ?? '/', 'http://workbench.invalid');
  if (isOpenRequest(url.pathname, request.method, env)) return true;
  const presented = bearerToken(request) ?? readCookie(request.headers.cookie as string | undefined, authCookieName);
  return Boolean(presented && tokensMatch(expected, presented));
}

/**
 * Connect-style shared-secret gate, used by both Express and the Vite dev server
 * so a tunnelled Workbench cannot be read or driven by whoever finds the URL.
 * Trust is decided from the verified TCP peer address (never the client-supplied
 * Host header): a direct loopback connection is exempt, and a forwarded chain is
 * only honored when the immediate peer is a configured trusted proxy. A trusted
 * proxy reporting a non-loopback client — e.g. a tunnel forwarding from an
 * external caller — stays gated like any other remote request.
 */
export function createAuthGate(token: string | null | undefined, env: NodeJS.ProcessEnv = process.env) {
  return function authGate(request: GateRequest, response: GateResponse, next: () => void): void {
    const expected = token === undefined ? configuredToken() : token;
    if (!expected) return next();
    const trustedProxies = trustedProxyList(env);
    const client = resolveClientAddress(request, trustedProxies);
    if (client && isLoopbackIp(client)) return next();
    const url = new URL(request.url ?? '/', 'http://workbench.invalid');
    if (isOpenRequest(url.pathname, request.method)) return next();

    const offered = url.searchParams.get('token');
    if (offered && tokensMatch(expected, offered)) {
      url.searchParams.delete('token');
      const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000'];
      if (isSecure(request, trustedProxies)) attributes.push('Secure');
      response.setHeader('set-cookie', `${authCookieName}=${encodeURIComponent(expected)}; ${attributes.join('; ')}`);
      response.statusCode = 302;
      response.setHeader('location', url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ''));
      response.end();
      return;
    }

    if (isRequestAuthorized(request, expected, env)) return next();

    response.statusCode = 401;
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Unauthorized. Open Workbench with ?token=… once to authorize this device.' }));
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workbench</title><body style="font:16px/1.5 system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem"><h1>Not authorized</h1><p>Open this Workbench once with <code>?token=…</code> appended to the URL to authorize this device.</p>');
  };
}
