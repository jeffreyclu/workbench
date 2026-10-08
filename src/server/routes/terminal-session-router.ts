import { Router } from 'express';
import { z } from 'zod';
import { isDirectLoopbackRequest } from '../auth.js';
import { publishRealtimeEvent, publishRealtimeMessagesEvent } from '../realtime.js';
import type { RouteContext } from '../route-context.js';
import { applyTerminalHookEvent } from '../terminal-session-sync.js';

const hookEventSchema = z.object({
  provider: z.literal('claude'),
  hook_event_name: z.enum(['SessionStart', 'UserPromptSubmit', 'Stop']),
  session_id: z.string().min(1).max(200),
  cwd: z.string().max(4096).nullish(),
  prompt_id: z.string().min(1).max(200).optional(),
  prompt: z.string().optional(),
  last_assistant_message: z.string().optional(),
  entrypoint: z.string().max(100).optional(),
}).passthrough();

export function createTerminalSessionRouter({ database }: RouteContext) {
  const router = Router();
  // Hooks run on Jeffrey's machine, so only a direct loopback caller is
  // accepted; a tunnel's forwarded request is refused even with a valid token.
  router.post('/api/terminal-sessions/events', (request, response) => {
    if (!isDirectLoopbackRequest(request)) return response.status(403).json({ error: 'Terminal session events are accepted from loopback only.' });
    const parsed = hookEventSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: 'Invalid terminal session event.' });
    const result = applyTerminalHookEvent(database, parsed.data);
    if (result.status === 'applied' && result.changed) {
      publishRealtimeEvent('shared-metadata');
      publishRealtimeMessagesEvent(result.conversationId);
    }
    response.json(result);
  });
  return router;
}
