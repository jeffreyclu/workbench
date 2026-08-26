import { Router } from 'express';
import { z } from 'zod';
import { figmaScopeSchema, grafanaConnectionSchema, sourceProviderSchema } from '../../shared/contracts.js';
import type { RouteContext } from '../route-context.js';
import { finishRemoteMcpOAuth } from '../remote-mcp.js';
import { isActionFailure } from '../action-result.js';

export function createSourceConnectionRouter({ repository, admin }: RouteContext) {
  const router = Router();
  router.get('/api/source-connections', (_request, response) => {
    response.json(admin.listSourceConnections());
  });
  router.get('/api/source-connections/figma/scope', (_request, response) => {
    const settings = repository.getSourceSettings('figma');
    if (!settings) return response.status(404).json({ error: 'Figma is not connected.' });
    try { response.json({ roots: figmaScopeSchema.parse({ roots: JSON.parse(settings.figmaRoots ?? '[]') }).roots }); }
    catch { response.json({ roots: [] }); }
  });
  router.put('/api/source-connections/figma/scope', (request, response, next) => {
    try { admin.sendAction(response, admin.setFigmaScope(figmaScopeSchema.parse(request.body ?? {}).roots), 200); }
    catch (error) { next(error); }
  });
  router.put('/api/source-connections/grafana', async (request, response, next) => {
    try { response.json(await admin.configureGrafana(grafanaConnectionSchema.parse(request.body ?? {}))); }
    catch (error) { next(error); }
  });
  router.post('/api/source-connections/:provider/mcp/oauth/start', async (request, response, next) => {
    try {
      const provider = z.enum(['confluence', 'slack', 'figma', 'gmail']).parse(request.params.provider);
      const serverUrl = request.body?.serverUrl === undefined ? undefined : z.string().url().parse(request.body.serverUrl);
      admin.sendAction(response, await admin.authorizeSource({ provider, mode: 'remote', serverUrl }), 200);
    } catch (error) { next(error); }
  });
  router.post('/api/source-connections/:provider/managed/oauth/start', async (request, response, next) => {
    try {
      const provider = z.enum(['figma', 'atlassian']).parse(request.params.provider);
      admin.sendAction(response, await admin.authorizeSource({ provider: provider === 'atlassian' ? 'confluence' : provider, mode: 'managed' }), 200);
    } catch (error) { next(error); }
  });
  router.get('/api/source-connections/:provider/mcp/oauth/callback', async (request, response) => {
    try {
      const provider = z.enum(['confluence', 'slack', 'figma', 'gmail']).parse(request.params.provider);
      const code = z.string().min(1).parse(request.query.code);
      const state = z.string().min(1).parse(request.query.state);
      const settings = await finishRemoteMcpOAuth(provider, code, state);
      const label = provider === 'confluence' ? 'Atlassian MCP' : provider === 'figma' ? 'Figma MCP' : provider === 'slack' ? 'Slack MCP' : 'Google Workspace MCP';
      repository.setSourceConnection(provider, label, settings as unknown as Record<string, string>);
      response.type('html').send(`<!doctype html><title>MCP connected</title><script>window.opener?.postMessage({type:'workbench:mcp-connected'},'*');window.close()</script><p>MCP connected. You can close this window.</p>`);
    } catch (error) { response.status(400).type('html').send(`<p>MCP connection failed: ${(error instanceof Error ? error.message : 'Unknown error').replace(/[<>&]/g, '')}</p>`); }
  });
  router.delete('/api/source-connections/:provider', (request, response) => {
    const provider = sourceProviderSchema.parse(request.params.provider);
    const result = admin.disconnectSource(provider);
    if (isActionFailure(result)) return response.status(result.status).json(result.body);
    response.status(204).end();
  });
  return router;
}
