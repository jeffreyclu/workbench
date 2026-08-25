import { describe, expect, it, vi } from 'vitest';
import {
  buildRunNotificationText,
  describeSlackConfig,
  escapeSlackText,
  notifyAgentRunFinished,
  resolveSlackConfig,
  sendSlackMessage,
} from './slack-notify.js';

const botEnv = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_NOTIFY_CHANNEL: '#workbench' } as NodeJS.ProcessEnv;
const webhookEnv = { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' } as NodeJS.ProcessEnv;
const noSleep = () => Promise.resolve();

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const item = { id: '4f2a1b3c-0000-0000-0000-000000000000', title: 'Connect Slack to Workbench' };
const run = { agent: 'claude' as const, kind: 'execute' as const };

describe('Slack configuration', () => {
  it('prefers a bot token with an explicit channel over a webhook', () => {
    const config = resolveSlackConfig({ ...botEnv, ...webhookEnv });
    expect(config).toMatchObject({ mode: 'bot', channel: '#workbench' });
  });

  it('falls back to the webhook when no bot channel is configured', () => {
    expect(resolveSlackConfig(webhookEnv)).toMatchObject({ mode: 'webhook', channel: null });
  });

  it('treats blank environment values as unset', () => {
    expect(resolveSlackConfig({ SLACK_BOT_TOKEN: '  ', SLACK_WEBHOOK_URL: '' })).toBeNull();
  });

  it('explains a half-configured bot token instead of silently disabling notifications', () => {
    expect(describeSlackConfig({ SLACK_BOT_TOKEN: 'xoxb-test' }).problem).toMatch(/SLACK_NOTIFY_CHANNEL is missing/);
    expect(describeSlackConfig({ SLACK_NOTIFY_CHANNEL: '#a' }).problem).toMatch(/SLACK_BOT_TOKEN is missing/);
    expect(describeSlackConfig({}).problem).toMatch(/Set SLACK_WORKFLOW_URL/);
  });

  it('reports a configured status', () => {
    expect(describeSlackConfig(botEnv)).toEqual({ configured: true, mode: 'bot', channel: '#workbench', problem: null });
  });
});

describe('message building', () => {
  it('escapes Slack control characters, ampersand first', () => {
    expect(escapeSlackText('a & b <c> "d"')).toBe('a &amp; b &lt;c&gt; "d"');
  });

  it('renders a completed run with agent, short task id, and app link', () => {
    const text = buildRunNotificationText(item, run, 'completed', 'All checks passed.', 'http://localhost:5180');
    expect(text).toContain(':white_check_mark:');
    expect(text).toContain('*execute complete*');
    expect(text).toContain('Connect Slack to Workbench');
    expect(text).toContain('claude · task `4f2a1b3c`');
    expect(text).toContain('<http://localhost:5180|open Workbench>');
    expect(text).toContain('All checks passed.');
  });

  it('renders a failed run as attention-needed', () => {
    const text = buildRunNotificationText(item, run, 'failed', 'boom', 'http://localhost:5180');
    expect(text).toContain(':rotating_light:');
    expect(text).toContain('needs attention');
  });

  it('escapes untrusted titles and detail so they cannot inject Slack markup', () => {
    const text = buildRunNotificationText(
      { id: item.id, title: '<script> & stuff' }, run, 'failed', '<@U123> & <!channel>', 'http://x',
    );
    expect(text).toContain('&lt;script&gt; &amp; stuff');
    expect(text).toContain('&lt;@U123&gt; &amp; &lt;!channel&gt;');
    expect(text).not.toContain('<!channel>');
  });

  it('truncates long detail without leaving a half-written entity', () => {
    const text = buildRunNotificationText(item, run, 'completed', '&'.repeat(5_000), 'http://x');
    expect(text).toContain('…');
    expect(text).not.toMatch(/&am(p)?…/);
    expect(text.split('\n\n')[1].length).toBeLessThan(9_000);
  });

  it('omits the body block when there is no detail', () => {
    expect(buildRunNotificationText(item, run, 'completed', '   ', 'http://x')).not.toContain('\n\n');
  });
});

describe('delivery', () => {
  it('posts to chat.postMessage with the bearer token and channel', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, channel: 'C1' }));
    const result = await sendSlackMessage('hello', { env: botEnv, fetchImpl, sleep: noSleep });
    expect(result).toMatchObject({ ok: true, mode: 'bot', channel: '#workbench', attempts: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ channel: '#workbench', text: 'hello', unfurl_links: false });
  });

  it('posts a JSON body to the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const result = await sendSlackMessage('hi', { env: webhookEnv, fetchImpl, sleep: noSleep });
    expect(result).toMatchObject({ ok: true, mode: 'webhook', channel: null });
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string)).toEqual({ text: 'hi' });
  });

  it('fails without retrying when Slack rejects the message on HTTP 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'channel_not_found' }));
    const result = await sendSlackMessage('x', { env: botEnv, fetchImpl, sleep: noSleep });
    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(result.ok === false && result.error).toMatch(/channel_not_found/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit and honours Retry-After', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await sendSlackMessage('x', { env: botEnv, fetchImpl, sleep });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('retries transient server errors and network faults', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await sendSlackMessage('x', { env: botEnv, fetchImpl, sleep: noSleep });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
  });

  it('gives up after the attempt budget and reports the last error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const result = await sendSlackMessage('x', { env: botEnv, fetchImpl, sleep: noSleep, maxAttempts: 2 });
    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not call Slack at all when nothing is configured', async () => {
    const fetchImpl = vi.fn();
    const result = await sendSlackMessage('x', { env: {}, fetchImpl, sleep: noSleep });
    expect(result).toMatchObject({ ok: false, mode: null, attempts: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('agent run notification', () => {
  const settle = () => new Promise((done) => { setTimeout(done, 10); });

  it('is a no-op when Slack is not configured', async () => {
    const fetchImpl = vi.fn();
    notifyAgentRunFinished(item, run, 'completed', 'done', { env: {}, fetchImpl, sleep: noSleep });
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delivers a completion notification when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    notifyAgentRunFinished(item, run, 'completed', 'done', { env: botEnv, fetchImpl, sleep: noSleep });
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string).text).toContain('execute complete');
  });

  it('never throws or rejects when Slack delivery fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('slack is down'));
    expect(() => notifyAgentRunFinished(item, run, 'failed', 'boom', { env: botEnv, fetchImpl, sleep: noSleep, maxAttempts: 1 })).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not delivered'));
    warn.mockRestore();
  });
});

describe('workflow trigger mode', () => {
  const workflowEnv = { SLACK_WORKFLOW_URL: 'https://hooks.slack.com/triggers/T1/222/abc' };

  it('recognises a Workflow Builder trigger URL and defaults the variable name to text', () => {
    expect(resolveSlackConfig(workflowEnv)).toMatchObject({ mode: 'workflow', variableName: 'text' });
    expect(describeSlackConfig(workflowEnv)).toMatchObject({ configured: true, mode: 'workflow' });
  });

  it('honours an explicit variable name', () => {
    expect(resolveSlackConfig({ ...workflowEnv, SLACK_WORKFLOW_TEXT_VARIABLE: 'message' }))
      .toMatchObject({ variableName: 'message' });
  });

  it('keeps a classic incoming webhook on webhook mode', () => {
    expect(resolveSlackConfig({ SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T1/B2/xyz' }))
      .toMatchObject({ mode: 'webhook', variableName: null });
  });

  it('posts the flat variable object a trigger expects, not Slack\'s text envelope', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url; void init;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const result = await sendSlackMessage('hello', { env: workflowEnv, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: true, mode: 'workflow', attempts: 1 });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ text: 'hello' });
  });

  it('treats ok:false as a failure even when the status is 200', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'trigger_not_found' }), { status: 200 }));
    const result = await sendSlackMessage('hello', {
      env: workflowEnv, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined,
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/trigger_not_found/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400, which means a malformed or unpublished trigger', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'missing_args' }), { status: 400 }));
    const result = await sendSlackMessage('hello', {
      env: workflowEnv, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('builds plain text without mrkdwn or link syntax', () => {
    const item = { id: 'abcdef1234567890', title: 'Ship <it> & test' };
    const run = { agent: 'claude', kind: 'execute' } as const;
    const text = buildRunNotificationText(item, run, 'completed', 'done', 'http://x', 'plain');
    expect(text).not.toContain('*');
    expect(text).not.toContain('|open Workbench>');
    expect(text).toContain('Ship <it> & test');
    expect(text).toContain('http://x');
  });
});
