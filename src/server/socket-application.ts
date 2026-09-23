import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Express, Request, Response } from 'express';
import type { RealtimeRequestHandler } from './realtime.js';
import { attachApplicationRequestSignal } from './request-abort.js';

type ApplicationRequestInput = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: string;
  stream?: boolean;
};

type ApplicationResponse = {
  status: number;
  contentType: string;
  body: string;
  encoding: 'utf8' | 'base64';
};

const ALLOWED_METHODS = new Set<ApplicationRequestInput['method']>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 150 * 1024 * 1024;

function parseInput(operation: string, value: unknown): ApplicationRequestInput {
  if (operation !== 'application.read' && operation !== 'application.command') throw new Error(`Unknown application operation: ${operation}`);
  if (!value || typeof value !== 'object') throw new Error('Application request input must be an object.');
  const input = value as Partial<ApplicationRequestInput>;
  if (!input.method || !ALLOWED_METHODS.has(input.method)) throw new Error('Application request method is invalid.');
  if (operation === 'application.read' && input.method !== 'GET') throw new Error('Read operations must use GET.');
  if (operation === 'application.command' && input.method === 'GET') throw new Error('Commands cannot use GET.');
  if (typeof input.path !== 'string' || !input.path.startsWith('/api/') || input.path.startsWith('/api/realtime')) throw new Error('Application request path is invalid.');
  if (input.path.length > 8_192 || /[\r\n]/.test(input.path)) throw new Error('Application request path is too long or malformed.');
  if (input.body !== undefined && typeof input.body !== 'string') throw new Error('Application request body must be JSON text.');
  if (input.stream !== undefined && typeof input.stream !== 'boolean') throw new Error('Application request stream flag must be a boolean.');
  if (input.body && Buffer.byteLength(input.body) > MAX_BODY_BYTES) throw new Error('Application request body is too large.');
  return input as ApplicationRequestInput;
}

/**
 * Executes the existing application controller stack without opening a second
 * network connection. This is the compatibility boundary while controllers
 * move from HTTP route wrappers to named application operations: browser data
 * still travels exclusively over the authenticated WebSocket.
 */
async function dispatchApplicationRequest(app: Express, input: ApplicationRequestInput, onProgress: (data: unknown) => void, signal: AbortSignal): Promise<ApplicationResponse> {
  const socket = new Socket();
  // The outer WebSocket upgrade already performed authentication. Mark this
  // synthetic, in-process request as loopback so auth middleware cannot reject
  // it for lacking a browser cookie copied into application payload data.
  Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: '127.0.0.1' });
  const request = new IncomingMessage(socket);
  attachApplicationRequestSignal(request as unknown as Request, signal);
  request.method = input.method;
  request.url = input.path;
  request.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(input.body ?? '')),
  };
  if (input.body) request.push(Buffer.from(input.body));
  request.push(null);

  const response = new ServerResponse(request);
  const chunks: Buffer[] = [];
  return new Promise<ApplicationResponse>((resolve, reject) => {
    let settled = false;
    const finish = (chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined));
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      if (settled) return response;
      settled = true;
      response.emit('finish');
      const contentTypeHeader = response.getHeader('content-type');
      const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(', ') : String(contentTypeHeader ?? '');
      const binary = !contentType.includes('application/json') && !contentType.startsWith('text/') && !contentType.includes('javascript') && !contentType.includes('xml');
      resolve({
        status: response.statusCode,
        contentType,
        body: Buffer.concat(chunks).toString(binary ? 'base64' : 'utf8'),
        encoding: binary ? 'base64' : 'utf8',
      });
      return response;
    };
    response.write = ((chunk: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk !== undefined && chunk !== null) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined);
        chunks.push(bytes);
        if (input.stream) onProgress(bytes.toString('utf8'));
      }
      const done = typeof encoding === 'function' ? encoding : callback;
      done?.();
      return true;
    }) as typeof response.write;
    response.end = finish as typeof response.end;
    response.flushHeaders = () => response;
    app(request as unknown as Request, response as unknown as Response, (error?: unknown) => {
      if (settled) return;
      if (error) {
        settled = true;
        reject(error);
        return;
      }
      response.statusCode = 404;
      finish(JSON.stringify({ error: 'Application operation not found.' }));
    });
  });
}

export function createApplicationSocketHandler(app: Express): RealtimeRequestHandler {
  return async (operation, rawInput, context) => {
    if (context.signal.aborted) throw new Error('The application request was cancelled.');
    const input = parseInput(operation, rawInput);
    const response = await dispatchApplicationRequest(app, input, context.emit, context.signal);
    if (context.signal.aborted) throw new Error('The application request was cancelled.');
    return response;
  };
}
