import type { Request, Response } from 'express';

const applicationRequestSignal = Symbol('workbench.applicationRequestSignal');

type RequestWithApplicationSignal = Request & { [applicationRequestSignal]?: AbortSignal };

export function attachApplicationRequestSignal(request: Request, signal: AbortSignal): void {
  Object.defineProperty(request, applicationRequestSignal, { configurable: false, value: signal });
}

/**
 * Browser HTTP requests are canceled by their real request/response lifecycle.
 * WebSocket application calls already have an authoritative cancellation
 * signal; listening to the synthetic IncomingMessage's `aborted` event would
 * cancel every slow operation as soon as its in-memory body reaches EOF.
 */
export function abortSignalForRequest(request: Request, response: Response): AbortSignal {
  const applicationSignal = (request as RequestWithApplicationSignal)[applicationRequestSignal];
  if (applicationSignal) return applicationSignal;

  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  return controller.signal;
}
