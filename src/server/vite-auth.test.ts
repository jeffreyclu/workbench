import { describe, expect, it } from 'vitest';
import { authGatePlugin } from '../../vite.config.js';

describe('Vite auth gate', () => {
  it('uses the configured trusted proxies rather than Host when handling tunnel traffic', () => {
    let middleware: ((request: any, response: any, next: () => void) => void) | undefined;
    const plugin = authGatePlugin('test-token', {
      WORKBENCH_TRUSTED_PROXIES: '127.0.0.1/32,::1/128',
    });
    if (typeof plugin.configureServer !== 'function') throw new Error('Vite auth plugin must configure the dev server');
    plugin.configureServer.call({} as never, {
      middlewares: { use(handler: any) { middleware = handler; } },
    } as any);

    const response = {
      statusCode: 200,
      setHeader() { return undefined; },
      end() { return undefined; },
    };
    let nexted = false;
    middleware?.({
      url: '/',
      headers: { host: 'localhost:5173', 'x-forwarded-for': '203.0.113.8' },
      socket: { remoteAddress: '127.0.0.1' },
    }, response, () => { nexted = true; });

    expect(nexted).toBe(false);
    expect(response.statusCode).toBe(401);
  });
});
