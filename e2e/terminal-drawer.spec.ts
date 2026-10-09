import { expect, test, type Page } from '@playwright/test';

const at = '2026-10-09T12:00:00.000Z';
const codexDelta = (delta: string) => ({ at, source: 'provider', turnId: 't1', event: { method: 'item/agentMessage/delta', params: { delta } } });
const hostPrompt = { at, source: 'host', turnId: 't1', type: 'turn_started', prompt: 'List the open tasks' };
const hostCompleted = { at, source: 'host', turnId: 't1', type: 'turn_terminal', status: 'completed' };
const status = { state: 'idle', pid: null, providerSessionId: 'codex-thread-1', providerSessionEstablished: true };

async function createConversation(page: Page, title: string): Promise<string> {
  const created = await page.request.post('/api/shared/conversations', { data: { title } });
  return (await created.json()).conversation.id;
}

async function openTerminal(page: Page, conversationId: string) {
  await page.goto(`/conversations/${conversationId}`);
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  return page.locator('.terminal-drawer');
}

test('a hosted session shows its log lines and keeps tailing as the file grows', async ({ page }) => {
  const conversationId = await createConversation(page, 'Hosted terminal');
  await page.request.post('/api/e2e/session-events', { data: { conversationId, agent: 'codex', status, records: [hostPrompt, codexDelta('Two tasks '), codexDelta('are open.')] } });

  const drawer = await openTerminal(page, conversationId);
  await drawer.getByRole('button', { name: 'Codex' }).click();
  const log = drawer.getByLabel('codex session output');
  await expect(log).toContainText('> List the open tasks');
  await expect(log).toContainText('Two tasks are open.');
  await expect(drawer.getByRole('status')).toHaveText('Idle');
  await page.screenshot({ path: 'test-results/terminal-drawer/hosted.png' });

  await page.request.post('/api/e2e/session-events', { data: { conversationId, agent: 'codex', records: [codexDelta(' Nothing blocked.'), hostCompleted] } });
  await expect(log).toContainText('Two tasks are open. Nothing blocked.');
  await expect(log).toContainText('■ turn completed');
  await page.screenshot({ path: 'test-results/terminal-drawer/hosted-grown.png' });
});

test('a mirrored terminal conversation shows the mirror header and its prompt, tool, and reply lines', async ({ page }) => {
  const hook = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({ provider: 'claude', session_id: 'mirror-session-1', cwd: '/tmp/e2e-terminal', entrypoint: 'cli', hook_event_name, ...extra });
  const applied = await page.request.post('/api/e2e/terminal-hook-events', { data: { events: [
    hook('SessionStart'),
    hook('UserPromptSubmit', { prompt_id: 'p1', prompt: 'Why is the build red?' }),
    hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash', tool_input: { command: 'npm run typecheck' } }),
    hook('Stop', { prompt_id: 'p1', last_assistant_message: 'A stale generated file broke it.' }),
  ] } });
  const { results } = await applied.json();
  const conversationId = results.find((result: { conversationId?: string }) => result.conversationId).conversationId;

  const drawer = await openTerminal(page, conversationId);
  await expect(drawer.getByRole('status')).toContainText('Mirrored from your terminal (session mirror-session-1)');
  const log = drawer.getByLabel('claude session output');
  await expect(log).toContainText('> Why is the build red?');
  await expect(log).toContainText('● Bash: {"command":"npm run typecheck"}');
  await expect(log).toContainText('A stale generated file broke it.');
  await page.screenshot({ path: 'test-results/terminal-drawer/mirrored.png' });

  // A new prompt arrives through the realtime message event, with no reload.
  await page.request.post('/api/e2e/terminal-hook-events', { data: { events: [hook('UserPromptSubmit', { prompt_id: 'p2', prompt: 'And now?' })] } });
  await expect(log).toContainText('> And now?');
});

test('a conversation with neither session says so, and each agent tab re-fetches its own log', async ({ page }) => {
  const conversationId = await createConversation(page, 'Empty terminal');
  const drawer = await openTerminal(page, conversationId);
  const noSession = 'No live session for this conversation yet';
  await expect(drawer.getByLabel('claude session output')).toContainText(noSession);
  await expect(drawer.getByRole('status')).toHaveText('No live session');
  await page.screenshot({ path: 'test-results/terminal-drawer/empty.png' });

  await drawer.getByRole('button', { name: 'Codex' }).click();
  await expect(drawer.getByLabel('codex session output')).toContainText(noSession);

  // Sessions that appear while their tab is hidden must show up when it is selected again.
  await page.request.post('/api/e2e/session-events', { data: { conversationId, agent: 'claude', status: { ...status, providerSessionId: 'claude-session-1' }, records: [{ ...hostPrompt, prompt: 'Claude prompt' }] } });
  await drawer.getByRole('button', { name: 'Claude' }).click();
  await expect(drawer.getByLabel('claude session output')).toContainText('> Claude prompt');

  await page.request.post('/api/e2e/session-events', { data: { conversationId, agent: 'codex', status, records: [codexDelta('Codex reply')] } });
  await drawer.getByRole('button', { name: 'Codex' }).click();
  await expect(drawer.getByLabel('codex session output')).toContainText('Codex reply');
  await expect(drawer.getByLabel('codex session output')).not.toContainText('Claude prompt');
});
