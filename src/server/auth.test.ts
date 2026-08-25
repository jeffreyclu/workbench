import { describe, expect, it } from 'vitest';
import { authCookieName, createAuthGate, generateToken, isOpenRequest, readCookie, tokensMatch } from './auth.js';

const token = 'test-secret-token';

function call(
  url: string,
  headers: Record<string, string | string[] | undefined> = {},
  options: { gate?: ReturnType<typeof createAuthGate>; gateToken?: string | null; remoteAddress?: string | null; env?: NodeJS.ProcessEnv } = {},
) {
  const { gate, gateToken = token, remoteAddress = '127.0.0.1', env = {} } = options;
  const sent: { status: number; headers: Record<string, string>; body?: string; nexted: boolean } = { status: 200, headers: {}, nexted: false };
  const response = {
    get statusCode() { return sent.status; },
    set statusCode(value: number) { sent.status = value; },
    setHeader(name: string, value: string) { sent.headers[name] = value; },
    end(body?: string) { sent.body = body; },
  };
  (gate ?? createAuthGate(gateToken, env))({ url, headers, socket: { remoteAddress } }, response, () => { sent.nexted = true; });
  return sent;
}

describe('workbench auth gate', () => {
  it('passes every request through when no token is configured', () => {
    expect(call('/api/work-items', {}, { gateToken: null }).nexted).toBe(true);
  });

  it('exempts a direct loopback connection regardless of a forged Host header', () => {
    expect(call('/', { host: 'workbench.chicken-dojo.ts.net' }, { remoteAddress: '127.0.0.1' }).nexted).toBe(true);
    expect(call('/api/work-items', { host: 'attacker.example.com' }, { remoteAddress: '::1' }).nexted).toBe(true);
  });

  it('exempts numeric and encoded loopback socket addresses', () => {
    expect(call('/', {}, { remoteAddress: '127.0.0.2' }).nexted).toBe(true);
    expect(call('/', {}, { remoteAddress: '::ffff:127.0.0.1' }).nexted).toBe(true);
    expect(call('/', {}, { remoteAddress: '[::1]' }).nexted).toBe(true);
  });

  it('gates a remote IPv4 socket even with a spoofed loopback Host header', () => {
    const result = call('/', { host: 'localhost:5180' }, { remoteAddress: '203.0.113.7' });
    expect(result.status).toBe(401);
  });

  it('gates a remote IPv6 socket', () => {
    expect(call('/', {}, { remoteAddress: '2001:db8::1' }).status).toBe(401);
  });

  it('still gates LAN and tunnel-facing sockets', () => {
    expect(call('/', {}, { remoteAddress: '192.168.1.20' }).status).toBe(401);
  });

  it('rejects an unauthenticated API request with JSON and no data', () => {
    const result = call('/api/work-items', {}, { remoteAddress: '203.0.113.7' });
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(401);
    expect(result.headers['content-type']).toBe('application/json');
    expect(JSON.parse(result.body!).error).toContain('Unauthorized');
  });

  it('rejects an unauthenticated MCP request with JSON and no state', () => {
    const result = call('/mcp', {}, { remoteAddress: '203.0.113.7' });
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(401);
    expect(result.headers['content-type']).toBe('application/json');
    expect(JSON.parse(result.body!).error).toContain('Unauthorized');
  });

  it('rejects an unauthenticated page request with a bare HTML notice', () => {
    const result = call('/', {}, { remoteAddress: '203.0.113.7' });
    expect(result.status).toBe(401);
    expect(result.headers['content-type']).toContain('text/html');
    expect(result.body).toContain('Not authorized');
  });

  it('leaves the health check reachable so a tunnel can be probed', () => {
    expect(call('/api/health', {}, { remoteAddress: '203.0.113.7' }).nexted).toBe(true);
  });

  it('accepts a matching cookie', () => {
    expect(call('/api/work-items', { cookie: `other=1; ${authCookieName}=${token}` }, { remoteAddress: '203.0.113.7' }).nexted).toBe(true);
  });

  it('accepts a matching bearer token', () => {
    expect(call('/api/work-items', { authorization: `Bearer ${token}` }, { remoteAddress: '203.0.113.7' }).nexted).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(call('/api/work-items', { authorization: `Bearer ${'x'.repeat(token.length)}` }, { remoteAddress: '203.0.113.7' }).nexted).toBe(false);
  });

  it('backs off a client after five failed attempts', () => {
    const gate = createAuthGate(token, {});
    const options = { gate, remoteAddress: '203.0.113.7' };
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(call('/api/work-items', { authorization: 'Bearer wrong' }, options).status).toBe(401);
    }

    const limited = call('/api/work-items', { authorization: 'Bearer wrong' }, options);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect(JSON.parse(limited.body!).error).toContain('Too many failed authentication attempts');
    expect(call('/api/work-items', { authorization: 'Bearer wrong' }, options).status).toBe(429);
  });

  it('increases the backoff after another failed attempt', () => {
    let timestamp = 0;
    const gate = createAuthGate(token, {}, () => timestamp);
    const options = { gate, remoteAddress: '203.0.113.7' };
    for (let attempt = 0; attempt < 5; attempt++) call('/api/work-items', { authorization: 'Bearer wrong' }, options);

    timestamp += 1_000;
    const limited = call('/api/work-items', { authorization: 'Bearer wrong' }, options);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('2');
  });

  it('isolates failed-attempt backoff by verified client address', () => {
    const gate = createAuthGate(token, {});
    const blockedClient = { gate, remoteAddress: '203.0.113.7' };
    for (let attempt = 0; attempt < 5; attempt++) call('/api/work-items', { authorization: 'Bearer wrong' }, blockedClient);

    expect(call('/api/work-items', { authorization: 'Bearer wrong' }, { gate, remoteAddress: '203.0.113.8' }).status).toBe(401);
  });

  it('does not treat requests without a token as failed attempts', () => {
    const gate = createAuthGate(token, {});
    const options = { gate, remoteAddress: '203.0.113.7' };
    for (let attempt = 0; attempt < 5; attempt++) call('/api/work-items', { authorization: 'Bearer wrong' }, options);

    expect(call('/api/work-items', {}, options).status).toBe(401);
  });

  it('clears a client failure count after successful authentication', () => {
    const gate = createAuthGate(token, {});
    const options = { gate, remoteAddress: '203.0.113.7' };
    for (let attempt = 0; attempt < 4; attempt++) call('/api/work-items', { authorization: 'Bearer wrong' }, options);
    expect(call('/api/work-items', { authorization: `Bearer ${token}` }, options).nexted).toBe(true);
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(call('/api/work-items', { authorization: 'Bearer wrong' }, options).status).toBe(401);
    }
    expect(call('/api/work-items', { authorization: 'Bearer wrong' }, options).status).toBe(429);
  });

  it('allows valid authentication to clear an active backoff', () => {
    const gate = createAuthGate(token, {});
    const options = { gate, remoteAddress: '203.0.113.7' };
    for (let attempt = 0; attempt < 5; attempt++) call('/api/work-items', { authorization: 'Bearer wrong' }, options);

    expect(call('/api/work-items', { authorization: `Bearer ${token}` }, options).nexted).toBe(true);
    expect(call('/api/work-items', { authorization: 'Bearer wrong' }, options).status).toBe(401);
  });

  it('exchanges a query token for a cookie and redirects the token out of the URL', () => {
    const result = call(`/?token=${token}&view=archive`, {}, { remoteAddress: '203.0.113.7' });
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('/?view=archive');
    expect(result.headers['set-cookie']).toContain(`${authCookieName}=${token}`);
    expect(result.headers['set-cookie']).toContain('HttpOnly');
    expect(result.headers['set-cookie']).not.toContain('Secure');
  });

  it('ignores a wrong query token instead of authorizing', () => {
    expect(call('/?token=nope', {}, { remoteAddress: '203.0.113.7' }).status).toBe(401);
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

describe('trusted proxy forwarding', () => {
  const trustedEnv = { WORKBENCH_TRUSTED_PROXIES: '127.0.0.1/32,::1/128' } as NodeJS.ProcessEnv;

  it('resolves the client through X-Forwarded-For when the peer is a trusted proxy', () => {
    const result = call('/api/work-items', { 'x-forwarded-for': '203.0.113.7' }, { remoteAddress: '127.0.0.1', env: trustedEnv });
    expect(result.status).toBe(401);
  });

  it('walks a multi-hop forwarded chain right-to-left through trusted hops', () => {
    const chainedEnv = { WORKBENCH_TRUSTED_PROXIES: '127.0.0.1/32,10.0.0.5/32' } as NodeJS.ProcessEnv;
    const result = call('/api/work-items', { 'x-forwarded-for': '203.0.113.7, 10.0.0.5' }, { remoteAddress: '127.0.0.1', env: chainedEnv });
    expect(result.status).toBe(401);
  });

  it('gates a trusted loopback tunnel that reports an external client', () => {
    const result = call('/', { 'x-forwarded-for': '203.0.113.7' }, { remoteAddress: '::1', env: trustedEnv });
    expect(result.status).toBe(401);
  });

  it('stays exempt for a trusted loopback tunnel with no forwarded chain', () => {
    expect(call('/', {}, { remoteAddress: '127.0.0.1', env: trustedEnv }).nexted).toBe(true);
  });

  it('ignores spoofed forwarded headers from an untrusted peer', () => {
    const result = call('/api/work-items', { 'x-forwarded-for': '127.0.0.1' }, { remoteAddress: '203.0.113.7', env: {} });
    expect(result.status).toBe(401);
  });

  it('marks the cookie Secure only when a trusted proxy reports https', () => {
    const trusted = call(
      `/?token=${token}`,
      { 'x-forwarded-proto': 'https,http', 'x-forwarded-for': '203.0.113.7' },
      { remoteAddress: '127.0.0.1', env: trustedEnv },
    );
    expect(trusted.headers['set-cookie']).toContain('Secure');

    const untrusted = call(`/?token=${token}`, { 'x-forwarded-proto': 'https' }, { remoteAddress: '203.0.113.7', env: {} });
    expect(untrusted.headers['set-cookie']).not.toContain('Secure');
  });
});

describe('artifact feedback exemption', () => {
  const configured = { APP_API_ORIGIN: 'https://workbench.example.com', ARTIFACT_PUBLIC_BASE_URL: 'https://artifacts.example.com' } as NodeJS.ProcessEnv;

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
