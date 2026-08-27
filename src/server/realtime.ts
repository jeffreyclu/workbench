import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { isRequestAuthorized } from './auth.js';

export const realtimeTopics = ['work-items', 'shared', 'discovery', 'runtime', 'insights', 'artifacts'] as const;
export type RealtimeTopic = typeof realtimeTopics[number];
export type RealtimeNotification = {
  type: 'notification';
  tone: 'success' | 'error' | 'info';
  message: string;
  description?: string;
  duration?: number;
  action?: { label: string; route: string };
};
export type RealtimeDiffConfidence = { type: 'diff-confidence'; assessments: Record<string, { risk: number | null; reasoning: string }> };
export type RealtimeMessage = { type: 'ready' } | { type: 'invalidate'; topics: RealtimeTopic[] } | RealtimeNotification | RealtimeDiffConfidence;

type RealtimeSink = (message: Exclude<RealtimeMessage, { type: 'ready' }>) => void;
let sink: RealtimeSink | null = null;

/** Safe no-op before a runtime has attached a socket server (including unit tests). */
export function publishRealtimeEvent(...topics: RealtimeTopic[]): void {
  sink?.({ type: 'invalidate', topics });
}

/** Sends a user-facing event. Records still come from REST after any invalidation frame. */
export function publishRealtimeNotification(notification: Omit<RealtimeNotification, 'type'>): void {
  sink?.({ type: 'notification', ...notification });
}

/** Small ephemeral score payloads are delivered as their scorer chunk settles;
 * unlike durable application state, they do not need a REST refetch first. */
export function publishRealtimeDiffConfidence(assessments: RealtimeDiffConfidence['assessments']): void {
  sink?.({ type: 'diff-confidence', assessments });
}

function rejectUpgrade(socket: Socket): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

function isRealtimePath(request: IncomingMessage): boolean {
  return new URL(request.url ?? '/', 'http://workbench.invalid').pathname === '/api/realtime';
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/** Attach one authenticated, server-to-client invalidation socket to an existing HTTP server. */
export function attachRealtimeServer(server: Server): () => void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1_024 });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }
  }, 25_000);
  heartbeat.unref();

  const broadcast: RealtimeSink = (message) => {
    const payload = JSON.stringify(message.type === 'invalidate'
      ? { ...message, topics: [...new Set(message.topics)] }
      : message satisfies RealtimeMessage);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };
  sink = broadcast;

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!isRealtimePath(request)) return;
    if (!isSameOrigin(request)) return rejectUpgrade(socket);
    if (!isRequestAuthorized(request)) return rejectUpgrade(socket);
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  };
  server.on('upgrade', onUpgrade);
  wss.on('connection', (client) => {
    client.on('error', () => undefined);
    client.send(JSON.stringify({ type: 'ready' } satisfies RealtimeMessage));
  });

  return () => {
    if (sink === broadcast) sink = null;
    clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
