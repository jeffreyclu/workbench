import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const authCookieName = 'workbench_token';
const openPaths = new Set(['/api/health']);

interface GateRequest { url?: string; headers: Record<string, string | string[] | undefined> }
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

function isSecure(request: GateRequest): boolean {
  const proto = request.headers['x-forwarded-proto'];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim() === 'https';
}

function isLoopbackRequest(request: GateRequest): boolean {
  const header = request.headers.host;
  const host = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  if (!host) return false;
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Connect-style shared-secret gate, used by both Express and the Vite dev server
 * so a tunnelled Workbench cannot be read or driven by whoever finds the URL.
 * Disabled entirely for loopback Host headers. Tunnel and LAN hosts remain gated.
 */
export function createAuthGate(token: string | null | undefined) {
  return function authGate(request: GateRequest, response: GateResponse, next: () => void): void {
    const expected = token === undefined ? configuredToken() : token;
    if (!expected) return next();
    if (isLoopbackRequest(request)) return next();
    const url = new URL(request.url ?? '/', 'http://workbench.invalid');
    if (openPaths.has(url.pathname)) return next();

    const offered = url.searchParams.get('token');
    if (offered && tokensMatch(expected, offered)) {
      url.searchParams.delete('token');
      const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000'];
      if (isSecure(request)) attributes.push('Secure');
      response.setHeader('set-cookie', `${authCookieName}=${encodeURIComponent(expected)}; ${attributes.join('; ')}`);
      response.statusCode = 302;
      response.setHeader('location', url.pathname + (url.searchParams.size ? `?${url.searchParams}` : ''));
      response.end();
      return;
    }

    const presented = bearerToken(request) ?? readCookie(request.headers.cookie as string | undefined, authCookieName);
    if (presented && tokensMatch(expected, presented)) return next();

    response.statusCode = 401;
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Unauthorized. Open Workbench with ?token=… once to authorize this device.' }));
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workbench</title><body style="font:16px/1.5 system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem"><h1>Not authorized</h1><p>Open this Workbench once with <code>?token=…</code> appended to the URL to authorize this device.</p>');
  };
}
