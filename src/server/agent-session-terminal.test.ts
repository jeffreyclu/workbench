import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { closeTestServer } from './test-http-harness.js';
import { e2eRuntimeCapabilities } from './runtime-capabilities.js';
import type { TerminalSnapshot } from './agent-session-terminal.js';

describe('session terminal tail route', () => {
  let database: WorkbenchDatabase;
  let server: Server;
  let baseUrl: string;
  let root: string;
  let conversationId: string;
  let eventsPath: string;
  const previousDir = process.env.WORKBENCH_AGENT_SESSIONS_DIR;

  const record = (value: Record<string, unknown>) => `${JSON.stringify({ at: '2026-10-08T00:00:00.000Z', ...value })}\n`;
  const tail = async (offset?: number): Promise<TerminalSnapshot> => {
    const response = await fetch(`${baseUrl}/api/shared/conversations/${conversationId}/agent-sessions/claude/terminal${offset === undefined ? '' : `?offset=${offset}`}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<TerminalSnapshot>;
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'terminal-route-'));
    process.env.WORKBENCH_AGENT_SESSIONS_DIR = root;
    database = openDatabase(':memory:');
    server = createApp(database, e2eRuntimeCapabilities).listen(0);
    await new Promise<void>((listening) => server.once('listening', listening));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const created = await fetch(`${baseUrl}/api/shared/conversations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Terminal' }) });
    conversationId = ((await created.json()) as { conversation: { id: string } }).conversation.id;
    const directory = join(root, conversationId, 'claude');
    mkdirSync(directory, { recursive: true });
    eventsPath = join(directory, 'events.jsonl');
  });

  afterEach(async () => {
    await closeTestServer(server);
    database.close();
    rmSync(root, { recursive: true, force: true });
    if (previousDir === undefined) delete process.env.WORKBENCH_AGENT_SESSIONS_DIR;
    else process.env.WORKBENCH_AGENT_SESSIONS_DIR = previousDir;
  });

  it('reports no session and no lines before anything is logged', async () => {
    const snapshot = await tail();
    expect(snapshot).toMatchObject({ lines: [], nextOffset: 0, session: { state: 'none', pid: null } });
  });

  it('returns rendered lines and resumes from the returned offset without replaying', async () => {
    writeFileSync(eventsPath, record({ source: 'host', type: 'turn_started', turnId: 't1', prompt: 'hello' })
      + record({ source: 'provider', turnId: 't1', event: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } } }));
    const first = await tail(0);
    expect(first.lines.map((line) => [line.kind, line.text])).toEqual([['host', '> hello'], ['delta', 'Hi']]);
    expect(first.nextOffset).toBeGreaterThan(0);

    appendFileSync(eventsPath, record({ source: 'host', type: 'turn_terminal', turnId: 't1', status: 'completed' }));
    const second = await tail(first.nextOffset);
    expect(second.lines.map((line) => line.text)).toEqual(['■ turn completed']);
    expect((await tail(second.nextOffset)).lines).toEqual([]);
  });

  it('holds back a torn trailing line until it is complete', async () => {
    const whole = record({ source: 'host', type: 'turn_started', turnId: 't1', prompt: 'a' });
    writeFileSync(eventsPath, whole + '{"source":"host","ty');
    const partial = await tail(0);
    expect(partial.lines).toHaveLength(1);
    expect(partial.nextOffset).toBe(Buffer.byteLength(whole));
  });

  it('clamps an offset past the end of the log', async () => {
    writeFileSync(eventsPath, record({ source: 'host', type: 'stopped', reason: 'idle' }));
    const snapshot = await tail(1_000_000);
    expect(snapshot.lines).toEqual([]);
    expect(snapshot.nextOffset).toBeLessThan(1_000_000);
  });

  it('rejects a bad offset, unknown agent, and unknown conversation', async () => {
    const base = `${baseUrl}/api/shared/conversations/${conversationId}/agent-sessions`;
    expect((await fetch(`${base}/claude/terminal?offset=-1`)).status).toBe(400);
    expect((await fetch(`${base}/claude/terminal?offset=abc`)).status).toBe(400);
    expect((await fetch(`${base}/gemini/terminal`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/shared/conversations/missing/agent-sessions/claude/terminal`)).status).toBe(404);
  });
});
