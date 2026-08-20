import { describe, expect, it } from 'vitest';
import { authCookieName, createAuthGate, generateToken, isOpenRequest, readCookie, tokensMatch } from './auth.js';

const token = 'test-secret-token';

function call(url: string, headers: Record<string, string | string[] | undefined> = {}, gateToken: string | null = token) {
  const sent: { status: number; headers: Record<string, string>; body?: string; nexted: boolean } = { status: 200, headers: {}, nexted: false };
  const response = {
    get statusCode() { return sent.status; },
    set statusCode(value: number) { sent.status = value; },
    setHeader(name: string, value: string) { sent.headers[name] = value; },
    end(body?: string) { sent.body = body; },
  };
  createAuthGate(gateToken)({ url, headers }, response, () => { sent.nexted = true; });
  return sent;
}

describe('workbench auth gate', () => {
  it('passes every request through when no token is configured', () => {
    expect(call('/api/work-items', {}, null).nexted).toBe(true);
  });

  it('never gates loopback hostnames', () => {
    expect(call('/', { host: 'localhost:5173' }).nexted).toBe(true);
    expect(call('/api/work-items', { host: '127.0.0.1:4317' }).nexted).toBe(true);
    expect(call('/', { host: '[::1]:5173' }).nexted).toBe(true);
  });

  it('still gates LAN and tunnel hostnames', () => {
    expect(call('/', { host: 'workbench.chicken-dojo.ts.net' }).status).toBe(401);
    expect(call('/', { host: '192.168.1.20:5173' }).status).toBe(401);
  });

  it('rejects an unauthenticated API request with JSON and no data', () => {
    const result = call('/api/work-items');
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(401);
    expect(result.headers['content-type']).toBe('application/json');
    expect(JSON.parse(result.body!).error).toContain('Unauthorized');
  });

  it('rejects an unauthenticated MCP request with JSON and no state', () => {
    const result = call('/mcp');
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(401);
    expect(result.headers['content-type']).toBe('application/json');
    expect(JSON.parse(result.body!).error).toContain('Unauthorized');
  });

  it('rejects an unauthenticated page request with a bare HTML notice', () => {
    const result = call('/');
    expect(result.status).toBe(401);
    expect(result.headers['content-type']).toContain('text/html');
    expect(result.body).toContain('Not authorized');
  });

  it('leaves the health check reachable so a tunnel can be probed', () => {
    expect(call('/api/health').nexted).toBe(true);
  });

  it('accepts a matching cookie', () => {
    expect(call('/api/work-items', { cookie: `other=1; ${authCookieName}=${token}` }).nexted).toBe(true);
  });

  it('accepts a matching bearer token', () => {
    expect(call('/api/work-items', { authorization: `Bearer ${token}` }).nexted).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(call('/api/work-items', { authorization: `Bearer ${'x'.repeat(token.length)}` }).nexted).toBe(false);
  });

  it('exchanges a query token for a cookie and redirects the token out of the URL', () => {
    const result = call(`/?token=${token}&view=archive`);
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('/?view=archive');
    expect(result.headers['set-cookie']).toContain(`${authCookieName}=${token}`);
    expect(result.headers['set-cookie']).toContain('HttpOnly');
    expect(result.headers['set-cookie']).not.toContain('Secure');
  });

  it('marks the cookie Secure when the request arrived over a proxied https tunnel', () => {
    expect(call(`/?token=${token}`, { 'x-forwarded-proto': 'https,http' }).headers['set-cookie']).toContain('Secure');
  });

  it('ignores a wrong query token instead of authorizing', () => {
    expect(call('/?token=nope').status).toBe(401);
  });

  it('reads only the named cookie', () => {
    expect(readCookie('a=1; workbench_token=abc; b=2', authCookieName)).toBe('abc');
    expect(readCookie(undefined, authCookieName)).toBeNull();
  });

  it('compares unequal-length tokens without throwing', () => {
    expect(tokensMatch('short', 'a-much-longer-candidate')).toBe(false);
    expect(tokensMatch(token, token)).toBe(true);
  });

  it('generates a URL-safe token with real entropy', () => {
    expect(generateToken()).toMatch(/^[\w-]{32,}$/);
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('artifact feedback exemption', () => {
  const configured = { WORKBENCH_PUBLIC_URL: 'https://jeffrey.ngrok-free.app', ARTIFACT_PUBLIC_BASE_URL: 'https://artifacts.example.com' } as NodeJS.ProcessEnv;

  it('lets a coworker post feedback without a token once feedback is configured', () => {
    expect(isOpenRequest('/api/artifacts/abc123/comments', 'POST', configured)).toBe(true);
    expect(isOpenRequest('/api/artifacts/abc123/comments', 'OPTIONS', configured)).toBe(true);
  });

  it('never exposes reading that feedback, or any other route', () => {
    expect(isOpenRequest('/api/artifacts/abc123/comments', 'GET', configured)).toBe(false);
    expect(isOpenRequest('/api/artifacts', 'POST', configured)).toBe(false);
    expect(isOpenRequest('/api/work-items', 'POST', configured)).toBe(false);
    expect(isOpenRequest('/api/artifacts/abc123/../../work-items/comments', 'POST', configured)).toBe(false);
  });

  it('keeps the endpoint gated when feedback is not configured', () => {
    expect(isOpenRequest('/api/artifacts/abc123/comments', 'POST', {})).toBe(false);
    expect(isOpenRequest('/api/health', 'GET', {})).toBe(true);
  });
});
