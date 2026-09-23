import { socketTransport } from './socket-transport';

type ApplicationSocketResponse = {
  status: number;
  contentType: string;
  body: string;
  encoding: 'utf8' | 'base64';
};

type ApplicationRequestTestAdapter = (path: string, init?: RequestInit) => Promise<ApplicationSocketResponse>;
let testAdapter: ApplicationRequestTestAdapter | null = null;

/** Vitest compatibility only. Production code must never install an adapter. */
export function setApplicationRequestTestAdapter(adapter: ApplicationRequestTestAdapter | null): void {
  testAdapter = adapter;
}

/** Shared WebSocket transport for every Workbench client domain operation. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method?.toUpperCase() ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`Unsupported application method: ${method}`);
  if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('WebSocket application requests require a JSON string body.');
  const mode = method === 'GET' ? 'read' : 'command';
  const response = testAdapter
    ? await testAdapter(path, init)
    : await socketTransport.request<ApplicationSocketResponse>(
      mode === 'read' ? 'application.read' : 'application.command',
      { method, path, body: init?.body },
      { mode, signal: init?.signal ?? undefined },
    );
  if (response.status === 204) return undefined as T;
  if (!response.contentType.includes('application/json')) {
    const body = response.body.replace(/\s+/g, ' ').trim();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Request failed (${response.status}): ${body || 'The application operation is unavailable.'}`);
    }
    throw new Error('The API returned an invalid response. Refresh the preview and try again.');
  }
  let payload: T & { error?: string };
  try {
    payload = JSON.parse(response.body) as T & { error?: string };
  } catch {
    throw new Error('The application operation returned invalid JSON.');
  }
  if (response.status < 200 || response.status >= 300) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

export async function requestBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const response = await socketTransport.request<ApplicationSocketResponse>(
    'application.read',
    { method: 'GET', path },
    { mode: 'read', signal },
  );
  if (response.status < 200 || response.status >= 300) {
    let message = `Request failed (${response.status}).`;
    try { message = (JSON.parse(response.body) as { error?: string }).error ?? message; } catch { /* Keep status message. */ }
    throw new Error(message);
  }
  const bytes = response.encoding === 'base64'
    ? Uint8Array.from(atob(response.body), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(response.body);
  return new Blob([bytes], { type: response.contentType || 'application/octet-stream' });
}

export async function requestStream(path: string, init: RequestInit, onChunk: (chunk: string) => void): Promise<void> {
  const method = (init.method?.toUpperCase() ?? 'POST') as 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  let receivedProgress = false;
  const response = await socketTransport.request<ApplicationSocketResponse>(
    'application.command',
    { method, path, body: init.body, stream: true },
    { mode: 'command', signal: init.signal ?? undefined, onProgress: (data) => { if (typeof data === 'string') { receivedProgress = true; onChunk(data); } } },
  );
  if (response.status < 200 || response.status >= 300) throw new Error(`Request failed (${response.status}).`);
  if (!receivedProgress && response.body) onChunk(response.body);
}
