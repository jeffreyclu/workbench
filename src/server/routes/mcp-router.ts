import { Router, type RequestHandler } from 'express';
import type { RouteContext } from '../route-context.js';
import { createWorkbenchMcpHandler, rejectUnsupportedMcpMethod } from '../workbench-mcp.js';

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
}

function configuredMcpOrigins(env: NodeJS.ProcessEnv): Set<string> {
  const values = [
    env.APP_ORIGIN,
    env.WORKBENCH_PUBLIC_URL,
    ...(env.WORKBENCH_MCP_ALLOWED_ORIGINS ?? '').split(','),
  ];
  const origins = new Set<string>();
  for (const value of values) {
    if (!value?.trim()) continue;
    try { origins.add(new URL(value.trim()).origin); } catch { /* Invalid configuration grants nothing. */ }
  }
  return origins;
}

/**
 * Streamable HTTP MCP servers must reject browser requests from untrusted
 * origins. Authentication alone does not stop DNS rebinding when the browser
 * can reach a loopback service with attacker-controlled Host/Origin headers.
 * Non-browser MCP clients normally omit Origin and remain supported.
 */
export function isAllowedMcpOrigin(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isLoopbackHostname(parsed.hostname) || configuredMcpOrigins(env).has(parsed.origin);
  } catch {
    return false;
  }
}

export const requireAllowedMcpOrigin: RequestHandler = (request, response, next) => {
  if (isAllowedMcpOrigin(request.header('origin'))) return next();
  response.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Forbidden MCP Origin.' },
    id: null,
  });
};

export function createMcpRouter({ repository, admin }: RouteContext) {
  const router = Router();
  router.post('/mcp', requireAllowedMcpOrigin, createWorkbenchMcpHandler(repository, admin.mcpActions()));
  router.get('/mcp', rejectUnsupportedMcpMethod);
  router.delete('/mcp', rejectUnsupportedMcpMethod);
  return router;
}
