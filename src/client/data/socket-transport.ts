import {
  REALTIME_PROTOCOL_VERSION,
  parseRealtimeServerFrame,
  type RealtimeClientFrame,
  type RealtimeEvent,
  type RealtimeServerFrame,
} from '../../shared/realtime-protocol';

export type SocketConnectionState = 'connecting' | 'connected' | 'reconnecting';
export type SocketTransportEvent = RealtimeEvent | { kind: 'resync-required' };

type PendingRequest = {
  id: string;
  operation: string;
  input: unknown;
  mode: 'read' | 'command';
  sent: boolean;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
  onProgress?: (data: unknown) => void;
};

type SocketLike = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'addEventListener'>;
type SocketFactory = (url: string) => SocketLike;

const CLIENT_ID_KEY = 'workbench-realtime-client-id';
const SEQUENCE_KEY = 'workbench-realtime-sequence';
const MAX_PENDING_REQUESTS = 500;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readSessionValue(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Private browsing and hardened browsers may reject storage. The live
    // session still works; only cross-reload resume is unavailable.
  }
}

export function realtimeUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/realtime`;
}

export class SocketTransport {
  private socket: SocketLike | null = null;
  private state: SocketConnectionState = 'connecting';
  private disposed = false;
  private ready = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly clientId: string;
  private lastSequence: number | null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly outgoing: string[] = [];
  private readonly stateListeners = new Set<(state: SocketConnectionState) => void>();
  private readonly eventListeners = new Set<(event: SocketTransportEvent) => void>();

  constructor(
    private readonly getUrl: () => string = () => realtimeUrl(),
    private readonly createSocket: SocketFactory = (url) => new WebSocket(url),
  ) {
    this.clientId = readSessionValue(CLIENT_ID_KEY) ?? randomId();
    writeSessionValue(CLIENT_ID_KEY, this.clientId);
    const storedSequenceValue = readSessionValue(SEQUENCE_KEY);
    const storedSequence = storedSequenceValue === null ? null : Number(storedSequenceValue);
    this.lastSequence = storedSequence !== null && Number.isSafeInteger(storedSequence) && storedSequence >= 0 ? storedSequence : null;
  }

  get connectionState(): SocketConnectionState {
    return this.state;
  }

  connect(): void {
    if (this.disposed || this.socket) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.getUrl());
    } catch {
      this.setState('reconnecting');
      const delay = Math.min(30_000, 1_000 * 2 ** this.attempts++);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.disposed) return;
      const hello: RealtimeClientFrame = {
        type: 'hello',
        protocol: REALTIME_PROTOCOL_VERSION,
        clientId: this.clientId,
        resumeFrom: this.lastSequence,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || this.disposed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      const frame = parseRealtimeServerFrame(parsed);
      if (frame) this.handleFrame(frame);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      // Frames buffered for this physical socket cannot survive it. Reads are
      // rebuilt below with their original request IDs; commands are rejected
      // rather than leaking from this stale queue onto a later connection.
      this.outgoing.length = 0;
      if (this.disposed) return;
      for (const request of [...this.pending.values()]) {
        if (!request.sent) continue;
        if (request.mode === 'read') request.sent = false;
        else this.rejectPending(request.id, new Error('The connection closed before the command result was confirmed. The command was not retried.'));
      }
      this.setState('reconnecting');
      const delay = Math.min(30_000, 1_000 * 2 ** this.attempts++);
      const jitter = Math.round(delay * 0.2 * Math.random());
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay + jitter);
    });
  }

  subscribeState(listener: (state: SocketConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    this.connect();
    return () => this.stateListeners.delete(listener);
  }

  subscribeEvents(listener: (event: SocketTransportEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.connect();
    return () => this.eventListeners.delete(listener);
  }

  request<T>(operation: string, input: unknown, options: { mode: 'read' | 'command'; signal?: AbortSignal; onProgress?: (data: unknown) => void }): Promise<T> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('Too many WebSocket requests are waiting.'));
    if (options.signal?.aborted) return Promise.reject(new DOMException('The request was aborted.', 'AbortError'));
    const id = randomId();
    const promise = new Promise<T>((resolve, reject) => {
      const handleAbort = () => {
        if (this.pending.get(id)?.sent) this.sendFrame({ type: 'cancel', protocol: REALTIME_PROTOCOL_VERSION, id });
        this.rejectPending(id, new DOMException('The request was aborted.', 'AbortError'));
      };
      options.signal?.addEventListener('abort', handleAbort, { once: true });
      this.pending.set(id, {
        id,
        operation,
        input,
        mode: options.mode,
        sent: false,
        resolve: (data) => resolve(data as T),
        reject,
        removeAbortListener: () => options.signal?.removeEventListener('abort', handleAbort),
        onProgress: options.onProgress,
      });
    });
    this.connect();
    this.flushPending();
    return promise;
  }

  retryNow(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempts = 0;
    if (this.socket) this.socket.close();
    else this.connect();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.socket?.close();
    this.socket = null;
    for (const request of [...this.pending.values()]) this.rejectPending(request.id, new Error('The WebSocket transport was disposed.'));
    this.stateListeners.clear();
    this.eventListeners.clear();
  }

  private handleFrame(frame: RealtimeServerFrame): void {
    if (frame.type === 'ready') {
      this.attempts = 0;
      this.ready = true;
      if (!frame.resumed) {
        this.emitEvent({ kind: 'resync-required' });
      }
      this.lastSequence = frame.sequence;
      writeSessionValue(SEQUENCE_KEY, String(frame.sequence));
      this.setState('connected');
      this.flushPending();
      return;
    }
    if (frame.type === 'event') {
      if (this.lastSequence !== null && frame.sequence <= this.lastSequence) return;
      if (this.lastSequence !== null && frame.sequence !== this.lastSequence + 1) this.emitEvent({ kind: 'resync-required' });
      this.lastSequence = frame.sequence;
      writeSessionValue(SEQUENCE_KEY, String(frame.sequence));
      this.emitEvent(frame.event);
      return;
    }
    if (frame.type === 'progress') {
      this.pending.get(frame.id)?.onProgress?.(frame.data);
      return;
    }
    if (frame.type === 'response') {
      const request = this.pending.get(frame.id);
      if (!request) return;
      this.pending.delete(frame.id);
      request.removeAbortListener();
      request.resolve(frame.data);
      return;
    }
    if (frame.id) this.rejectPending(frame.id, new Error(frame.message));
  }

  private flushPending(): void {
    if (!this.ready) return;
    for (const request of this.pending.values()) {
      if (request.sent) continue;
      request.sent = true;
      this.sendFrame({
        type: 'request',
        protocol: REALTIME_PROTOCOL_VERSION,
        id: request.id,
        operation: request.operation,
        input: request.input,
        mode: request.mode,
      });
    }
  }

  private sendFrame(frame: RealtimeClientFrame): void {
    const payload = JSON.stringify(frame);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_BUFFERED_BYTES || this.outgoing.length > 0) {
      this.outgoing.push(payload);
      this.scheduleDrain();
      return;
    }
    this.socket.send(payload);
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      while (this.outgoing.length > 0 && this.socket.bufferedAmount <= MAX_BUFFERED_BYTES) this.socket.send(this.outgoing.shift()!);
      if (this.outgoing.length > 0) this.scheduleDrain();
    }, 10);
  }

  private rejectPending(id: string, error: Error): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    request.removeAbortListener();
    request.reject(error);
  }

  private setState(state: SocketConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private emitEvent(event: SocketTransportEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

export let socketTransport = new SocketTransport();

export function resetSocketTransportForTests(): void {
  socketTransport.dispose();
  socketTransport = new SocketTransport();
}
