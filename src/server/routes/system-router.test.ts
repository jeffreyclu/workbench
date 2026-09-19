import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

const seams = vi.hoisted(() => ({
  sendMacDesktopNotification: vi.fn(),
  readMcpQualityHistory: vi.fn(() => ({ status: 'healthy', latest: { id: 'check-1', status: 'passed' }, runs: [] })),
}));

vi.mock('../desktop-notifications.js', () => ({
  sendMacDesktopNotification: seams.sendMacDesktopNotification,
}));

vi.mock('../mcp-quality-history.js', () => ({
  readMcpQualityHistory: seams.readMcpQualityHistory,
}));

import { createApp } from '../app.js';
import { openDatabase, type WorkbenchDatabase } from '../database.js';
import { e2eRuntimeCapabilities } from '../runtime-capabilities.js';
import { closeTestServer, listenTestServer } from '../test-http-harness.js';

describe('system router desktop notifications', () => {
  let database: WorkbenchDatabase;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    database = openDatabase(':memory:');
    ({ server, baseUrl } = await listenTestServer(createApp(database, e2eRuntimeCapabilities)));
  });

  afterEach(async () => {
    await closeTestServer(server);
    database.close();
  });

  it('delivers a validated toast through the native macOS notifier', async () => {
    const response = await fetch(`${baseUrl}/api/desktop-notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Success', body: 'Task saved.' }),
    });

    expect(response.status).toBe(204);
    expect(seams.sendMacDesktopNotification).toHaveBeenCalledWith('Success', 'Task saved.');
  });

  it('rejects malformed notification payloads', async () => {
    const response = await fetch(`${baseUrl}/api/desktop-notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });

    expect(response.status).toBe(400);
    expect(seams.sendMacDesktopNotification).not.toHaveBeenCalled();
  });

  it('exposes read-only memory graph diagnostics', async () => {
    const response = await fetch(`${baseUrl}/api/insights/memory`);
    const body = await response.json() as { status: string; graph: { triggerCount: number; requiredTriggerCount: number }; traversalCanary: { status: string } };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.graph.triggerCount).toBeGreaterThan(0);
    expect(body.graph.triggerCount).toBe(body.graph.requiredTriggerCount);
    expect(body.traversalCanary.status).toBe('no_data');
  });

  it('exposes read-only MCP regression history', async () => {
    const response = await fetch(`${baseUrl}/api/insights/mcp-quality`);
    const body = await response.json() as { status: string; latest: { status: string } };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'healthy', latest: { status: 'passed' } });
    expect(seams.readMcpQualityHistory).toHaveBeenCalledOnce();
  });
});
