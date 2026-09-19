import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { createApp } from '../app.js';
import { e2eRuntimeCapabilities } from '../runtime-capabilities.js';
import { isAllowedMcpOrigin } from './mcp-router.js';

describe('MCP HTTP origin security', () => {
  let server: Server | undefined;
  let database: WorkbenchDatabase | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    database?.close();
    server = undefined;
    database = undefined;
  });

  it('allows native clients, loopback inspectors, and explicitly configured origins only', () => {
    const env = {
      APP_ORIGIN: 'https://workbench.example.com/path',
      WORKBENCH_MCP_ALLOWED_ORIGINS: 'https://mcp.example.com,not a url',
    } as NodeJS.ProcessEnv;

    expect(isAllowedMcpOrigin(undefined, env)).toBe(true);
    expect(isAllowedMcpOrigin('http://localhost:6274', env)).toBe(true);
    expect(isAllowedMcpOrigin('http://127.0.0.1:5180', env)).toBe(true);
    expect(isAllowedMcpOrigin('http://[::1]:5180', env)).toBe(true);
    expect(isAllowedMcpOrigin('https://workbench.example.com', env)).toBe(true);
    expect(isAllowedMcpOrigin('https://mcp.example.com', env)).toBe(true);
    expect(isAllowedMcpOrigin('https://evil.example', env)).toBe(false);
    expect(isAllowedMcpOrigin('null', env)).toBe(false);
  });

  it('rejects an MCP initialize request from an untrusted browser origin', async () => {
    database = openDatabase(':memory:');
    server = createApp(database, e2eRuntimeCapabilities).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a port.');

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'origin-security-test', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Forbidden MCP Origin.' },
      id: null,
    });
  });
});
