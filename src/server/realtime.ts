import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { isRequestAuthorized } from './auth.js';
import {
  REALTIME_PROTOCOL_VERSION,
  parseRealtimeClientFrame,
  type RealtimeClientFrame,
  type RealtimeEvent,
  type RealtimeNotification,
  type RealtimeServerFrame,
  type RealtimeTopic,
} from '../shared/realtime-protocol.js';

export type { RealtimeTopic } from '../shared/realtime-protocol.js';
export type RealtimeDiffConfidence = Extract<RealtimeEvent, { kind: 'diff-confidence' }>;
export type RealtimeReviewScore = Extract<RealtimeEvent, { kind: 'review-score' }>;

export type RealtimeRequestContext = {
  clientId: string;
  requestId: string;
  headers: IncomingHttpHeaders;
  signal: AbortSignal;
  emit: (data: unknown) => void;
};

export type RealtimeRequestHandler = (
  operation: string,
  input: unknown,
  context: RealtimeRequestContext,
) => Promise<unknown>;

export type RealtimeServerOptions = {
  handleRequest?: RealtimeRequestHandler;
  replayLimit?: number;
  maxInFlightPerClient?: number;
};

type SequencedEvent = Extract<RealtimeServerFrame, { type: 'event' }>;
type ClientState = {
  client: WebSocket;
  headers: IncomingHttpHeaders;
  clientId: string | null;
  ready: boolean;
  alive: boolean;
  inFlight: Map<string, AbortController>;
  sendQueue: string[];
  queuedBytes: number;
  drainTimer: NodeJS.Timeout | null;
};

const MAX_PAYLOAD_BYTES = 160 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const COMPLETED_REQUEST_TTL_MS = 5 * 60_000;
const HEARTBEAT_MS = 25_000;

let eventSequence = 0;
let replayLimit = 2_000;
const replayBuffer: SequencedEvent[] = [];
const completedRequests = new Map<string, { frame: RealtimeServerFrame; expiresAt: number }>();
const activeRequests = new Map<string, Promise<RealtimeServerFrame>>();
let liveSocketServer: WebSocketServer | null = null;
let liveClients = new Set<ClientState>();

function encode(frame: RealtimeServerFrame): string {
  return JSON.stringify(frame);
}

function scheduleDrain(state: ClientState): void {
  if (state.drainTimer || state.client.readyState !== WebSocket.OPEN) return;
  state.drainTimer = setTimeout(() => {
    state.drainTimer = null;
    while (state.sendQueue.length > 0 && state.client.readyState === WebSocket.OPEN && state.client.bufferedAmount <= MAX_BUFFERED_BYTES) {
      const payload = state.sendQueue.shift()!;
      state.queuedBytes -= Buffer.byteLength(payload);
      state.client.send(payload);
    }
    if (state.sendQueue.length > 0) scheduleDrain(state);
  }, 10);
  state.drainTimer.unref();
}

function sendFrame(state: ClientState, frame: RealtimeServerFrame): void {
  if (state.client.readyState !== WebSocket.OPEN) return;
  const payload = encode(frame);
  const bytes = Buffer.byteLength(payload);
  if (state.client.bufferedAmount <= MAX_BUFFERED_BYTES && state.sendQueue.length === 0) {
    state.client.send(payload);
    return;
  }
  if (state.queuedBytes + bytes > MAX_QUEUED_BYTES) {
    state.client.close(1013, 'Realtime client is not consuming data');
    return;
  }
  state.sendQueue.push(payload);
  state.queuedBytes += bytes;
  scheduleDrain(state);
}

function publishEvent(event: RealtimeEvent): void {
  const frame: SequencedEvent = {
    type: 'event',
    protocol: REALTIME_PROTOCOL_VERSION,
    sequence: ++eventSequence,
    event,
  };
  replayBuffer.push(frame);
  if (replayBuffer.length > replayLimit) replayBuffer.splice(0, replayBuffer.length - replayLimit);
  for (const state of liveClients) if (state.ready) sendFrame(state, frame);
}

export function publishRealtimeEvent(...topics: RealtimeTopic[]): void {
  publishEvent({ kind: 'invalidate', topics: [...new Set(topics)] });
}

export function publishRealtimeWorkItemEvent(workItemId: string, ...topics: RealtimeTopic[]): void {
  publishEvent({ kind: 'invalidate', topics: [...new Set(['work-items' as const, ...topics])], workItemId });
}

export function publishRealtimeMessagesEvent(conversationId: string): void {
  publishEvent({ kind: 'invalidate', topics: ['shared-messages'], conversationId });
}

export function publishRealtimeNotification(notification: Omit<RealtimeNotification, 'kind'>): void {
  publishEvent({ kind: 'notification', ...notification });
}

export function publishRealtimeDiffConfidence(assessments: RealtimeDiffConfidence['assessments']): void {
  publishEvent({ kind: 'diff-confidence', assessments });
}

export function publishRealtimeReviewScore(score: Omit<RealtimeReviewScore, 'kind'>): void {
  publishEvent({ kind: 'review-score', ...score });
}

export function retireRealtimeClients(): void {
  for (const state of liveClients) {
    if (state.client.readyState === WebSocket.OPEN) state.client.close(1012, 'Workbench runtime switched');
  }
}

function rejectUpgrade(socket: Socket, status = '401 Unauthorized'): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
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

function protocolError(state: ClientState, code: string, message: string, id: string | null = null): void {
  sendFrame(state, { type: 'error', protocol: REALTIME_PROTOCOL_VERSION, id, code, message, retryable: false });
}

function resumeClient(state: ClientState, frame: Extract<RealtimeClientFrame, { type: 'hello' }>): void {
  if (state.ready) {
    protocolError(state, 'duplicate_hello', 'The realtime session is already initialized.');
    return;
  }
  state.clientId = frame.clientId;
  const oldestAvailable = replayBuffer[0]?.sequence ?? eventSequence + 1;
  const canResume = frame.resumeFrom === null || frame.resumeFrom >= oldestAvailable - 1 && frame.resumeFrom <= eventSequence;
  if (canResume && frame.resumeFrom !== null) {
    for (const event of replayBuffer) if (event.sequence > frame.resumeFrom) sendFrame(state, event);
  }
  state.ready = true;
  sendFrame(state, {
    type: 'ready',
    protocol: REALTIME_PROTOCOL_VERSION,
    sessionId: randomUUID(),
    sequence: eventSequence,
    resumed: canResume,
  });
}

function requestKey(clientId: string, requestId: string): string {
  return `${clientId}:${requestId}`;
}

function pruneCompletedRequests(now = Date.now()): void {
  for (const [key, entry] of completedRequests) if (entry.expiresAt <= now) completedRequests.delete(key);
}

async function executeRequest(
  state: ClientState,
  frame: Extract<RealtimeClientFrame, { type: 'request' }>,
  handler: RealtimeRequestHandler | undefined,
  maxInFlight: number,
): Promise<void> {
  if (!state.ready || !state.clientId) {
    protocolError(state, 'hello_required', 'Initialize the realtime session before sending requests.', frame.id);
    return;
  }
  if (!handler) {
    protocolError(state, 'operation_unavailable', 'Realtime application requests are not enabled yet.', frame.id);
    return;
  }
  if (state.inFlight.size >= maxInFlight) {
    sendFrame(state, { type: 'error', protocol: REALTIME_PROTOCOL_VERSION, id: frame.id, code: 'too_many_requests', message: 'Too many realtime requests are already running.', retryable: true });
    return;
  }

  pruneCompletedRequests();
  const key = requestKey(state.clientId, frame.id);
  const completed = completedRequests.get(key);
  if (completed) {
    sendFrame(state, completed.frame);
    return;
  }
  const existing = activeRequests.get(key);
  if (existing) {
    sendFrame(state, await existing);
    return;
  }

  const controller = new AbortController();
  state.inFlight.set(frame.id, controller);
  const result = (async (): Promise<RealtimeServerFrame> => {
    try {
      const data = await handler(frame.operation, frame.input, {
        clientId: state.clientId!,
        requestId: frame.id,
        headers: state.headers,
        signal: controller.signal,
        emit: (progress) => sendFrame(state, { type: 'progress', protocol: REALTIME_PROTOCOL_VERSION, id: frame.id, data: progress }),
      });
      return { type: 'response', protocol: REALTIME_PROTOCOL_VERSION, id: frame.id, data };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return {
        type: 'error',
        protocol: REALTIME_PROTOCOL_VERSION,
        id: frame.id,
        code: aborted ? 'cancelled' : 'operation_failed',
        message: aborted ? 'The realtime request was cancelled.' : error instanceof Error ? error.message : 'The realtime operation failed.',
        retryable: !aborted && frame.mode === 'read',
      };
    }
  })();
  activeRequests.set(key, result);
  const response = await result;
  activeRequests.delete(key);
  state.inFlight.delete(frame.id);
  // Commands need a short duplicate-delivery window. Reads are safe to run
  // again and may contain multi-megabyte files, so retaining them would turn
  // ordinary previews into an avoidable server memory leak.
  if (frame.mode === 'command') completedRequests.set(key, { frame: response, expiresAt: Date.now() + COMPLETED_REQUEST_TTL_MS });
  sendFrame(state, response);
}

function cancelRequest(state: ClientState, frame: Extract<RealtimeClientFrame, { type: 'cancel' }>): void {
  state.inFlight.get(frame.id)?.abort();
}

/** Attach one authenticated, resumable, bidirectional application socket. */
export function attachRealtimeServer(server: Server, options: RealtimeServerOptions = {}): () => void {
  replayLimit = options.replayLimit ?? replayLimit;
  const maxInFlight = options.maxInFlightPerClient ?? 64;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PAYLOAD_BYTES });
  liveSocketServer = wss;
  liveClients = new Set();

  const heartbeat = setInterval(() => {
    for (const state of liveClients) {
      if (!state.alive) {
        state.client.terminate();
        continue;
      }
      state.alive = false;
      state.client.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!isRealtimePath(request)) return;
    if (!isSameOrigin(request)) return rejectUpgrade(socket);
    if (!isRequestAuthorized(request)) return rejectUpgrade(socket);
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (client, request) => {
    const state: ClientState = {
      client,
      headers: request.headers,
      clientId: null,
      ready: false,
      alive: true,
      inFlight: new Map(),
      sendQueue: [],
      queuedBytes: 0,
      drainTimer: null,
    };
    liveClients.add(state);
    const helloTimeout = setTimeout(() => client.close(1008, 'Realtime hello timed out'), 10_000);
    helloTimeout.unref();

    client.on('pong', () => { state.alive = true; });
    client.on('error', () => undefined);
    client.on('message', (raw, isBinary) => {
      if (isBinary) {
        protocolError(state, 'invalid_frame', 'Binary client frames are not supported.');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        protocolError(state, 'invalid_json', 'Realtime frames must contain valid JSON.');
        return;
      }
      const frame = parseRealtimeClientFrame(parsed);
      if (!frame) {
        protocolError(state, 'invalid_frame', 'Realtime frame did not match protocol version 1.');
        return;
      }
      if (frame.type === 'hello') {
        clearTimeout(helloTimeout);
        resumeClient(state, frame);
      } else if (frame.type === 'cancel') cancelRequest(state, frame);
      else void executeRequest(state, frame, options.handleRequest, maxInFlight);
    });
    client.on('close', () => {
      clearTimeout(helloTimeout);
      if (state.drainTimer) clearTimeout(state.drainTimer);
      // A network drop is not a user cancellation. Let application operations
      // finish so a reconnect using the same client/request IDs can receive the
      // original result instead of repeating a write or failing a read race.
      state.inFlight.clear();
      liveClients.delete(state);
    });
  });

  return () => {
    clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
    for (const state of liveClients) {
      if (state.drainTimer) clearTimeout(state.drainTimer);
      for (const controller of state.inFlight.values()) controller.abort();
      state.client.terminate();
    }
    liveClients.clear();
    wss.close();
    if (liveSocketServer === wss) liveSocketServer = null;
  };
}
