import { describe, expect, it } from 'vitest';
import type { ViteDevServer } from 'vite';
import { authGatePlugin, previewReadOnlyPlugin } from '../../vite.config.js';

describe('Vite auth gate', () => {
  it('uses the configured trusted proxies rather than Host when handling tunnel traffic', () => {
    type Middleware = (request: { url: string; headers: Record<string, string>; socket: { remoteAddress: string } }, response: { statusCode: number; setHeader: (name: string, value: string) => void; end: () => void }, next: () => void) => void;
    let middleware: Middleware | undefined;
    const plugin = authGatePlugin('test-token', {
      WORKBENCH_TRUSTED_PROXIES: '127.0.0.1/32,::1/128',
    });
    if (typeof plugin.configureServer !== 'function') throw new Error('Vite auth plugin must configure the dev server');
    plugin.configureServer.call({} as never, {
      middlewares: { use(handler: Middleware) { middleware = handler; } },
    } as unknown as ViteDevServer);

    const response = {
      statusCode: 200,
      setHeader() { return undefined; },
      end() { return undefined; },
    };
    let nexted = false;
    middleware?.({
      url: '/',
      headers: { host: 'localhost:5180', 'x-forwarded-for': '203.0.113.8' },
      socket: { remoteAddress: '127.0.0.1' },
    }, response, () => { nexted = true; });

    expect(nexted).toBe(false);
    expect(response.statusCode).toBe(401);
  });
});

describe('Vite preview read-only gate', () => {
  it('blocks mutations but lets read requests reach the live API proxy', () => {
    type Middleware = (request: { url: string; method: string }, response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body?: string) => void }, next: () => void) => void;
    let middleware: Middleware | undefined;
    const plugin = previewReadOnlyPlugin(true);
    if (typeof plugin.configureServer !== 'function') throw new Error('Preview plugin must configure the dev server');
    plugin.configureServer.call({} as never, {
      middlewares: { use(handler: Middleware) { middleware = handler; } },
    } as unknown as ViteDevServer);

    const response = { statusCode: 200, setHeader() { return undefined; }, end() { return undefined; } };
    let nexted = false;
    middleware?.({ url: '/api/work-items', method: 'GET' }, response, () => { nexted = true; });
    expect(nexted).toBe(true);

    nexted = false;
    middleware?.({ url: '/api/work-items', method: 'POST' }, response, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(response.statusCode).toBe(403);
  });
});
