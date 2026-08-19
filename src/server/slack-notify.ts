import type { AgentRun, WorkItem } from '../shared/contracts.js';

const chatPostMessageUrl = 'https://slack.com/api/chat.postMessage';
const requestTimeoutMs = 10_000;
const defaultMaxAttempts = 3;
const maxRetryDelayMs = 10_000;
const maxDetailLength = 1_500;

export type SlackDeliveryMode = 'bot' | 'webhook' | 'workflow';
export type SlackMarkup = 'mrkdwn' | 'plain';
export type AgentRunOutcome = 'completed' | 'failed';

export interface SlackConfig {
  mode: SlackDeliveryMode;
  botToken: string | null;
  webhookUrl: string | null;
  channel: string | null;
  /** Workflow Builder triggers accept a flat object of declared variables, not Slack's { text } envelope. */
  variableName: string | null;
}

export interface SlackConfigStatus {
  configured: boolean;
  mode: SlackDeliveryMode | null;
  channel: string | null;
  problem: string | null;
}

export type SlackDeliveryResult =
  | { ok: true; mode: SlackDeliveryMode; channel: string | null; attempts: number }
  | { ok: false; mode: SlackDeliveryMode | null; error: string; attempts: number };

export interface SlackDeliveryOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  env?: NodeJS.ProcessEnv;
}

type SlackEnv = NodeJS.ProcessEnv;

function trimmed(value: string | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

/**
 * A bot token plus an explicit channel wins over an incoming webhook, because it is the only
 * mode that can choose a destination at send time. A webhook is bound to one channel by Slack.
 */
export function isWorkflowTriggerUrl(url: string): boolean {
  return /^https:\/\/hooks\.slack\.com\/triggers\//.test(url);
}

export function resolveSlackConfig(env: SlackEnv = process.env): SlackConfig | null {
  const botToken = trimmed(env.SLACK_BOT_TOKEN);
  const channel = trimmed(env.SLACK_NOTIFY_CHANNEL);
  const webhookUrl = trimmed(env.SLACK_WEBHOOK_URL) ?? trimmed(env.SLACK_WORKFLOW_URL);
  if (botToken && channel) return { mode: 'bot', botToken, webhookUrl: null, channel, variableName: null };
  if (webhookUrl && isWorkflowTriggerUrl(webhookUrl)) {
    return {
      mode: 'workflow',
      botToken: null,
      webhookUrl,
      channel: null,
      variableName: trimmed(env.SLACK_WORKFLOW_TEXT_VARIABLE) ?? 'text',
    };
  }
  if (webhookUrl) return { mode: 'webhook', botToken: null, webhookUrl, channel: null, variableName: null };
  return null;
}

export function describeSlackConfig(env: SlackEnv = process.env): SlackConfigStatus {
  const config = resolveSlackConfig(env);
  if (config) return { configured: true, mode: config.mode, channel: config.channel, problem: null };
  const botToken = trimmed(env.SLACK_BOT_TOKEN);
  const channel = trimmed(env.SLACK_NOTIFY_CHANNEL);
  if (botToken && !channel) return { configured: false, mode: null, channel: null, problem: 'SLACK_BOT_TOKEN is set but SLACK_NOTIFY_CHANNEL is missing.' };
  if (channel && !botToken) return { configured: false, mode: null, channel: null, problem: 'SLACK_NOTIFY_CHANNEL is set but SLACK_BOT_TOKEN is missing.' };
  return { configured: false, mode: null, channel: null, problem: 'Set SLACK_WORKFLOW_URL to a Workflow Builder trigger URL, or SLACK_BOT_TOKEN plus SLACK_NOTIFY_CHANNEL.' };
}

/** Slack reserves &, < and > for its own markup, so they must be entity-escaped in message text. */
export function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value: string, max: number): string {
  const collapsed = value.trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

/** Truncate before escaping so an entity such as &amp; can never be cut in half. */
function safeDetail(value: string): string {
  return escapeSlackText(truncate(value, maxDetailLength));
}

/**
 * Workflow Builder inserts a variable's value into a message as literal text, so mrkdwn
 * markup and link syntax would render as visible punctuation rather than formatting.
 * Plain mode therefore drops the markup instead of escaping it.
 */
export function buildRunNotificationText(
  item: Pick<WorkItem, 'id' | 'title'>,
  run: Pick<AgentRun, 'agent' | 'kind'>,
  outcome: AgentRunOutcome,
  detail: string,
  appOrigin = process.env.APP_ORIGIN ?? 'http://localhost:5173',
  markup: SlackMarkup = 'mrkdwn',
): string {
  const plain = markup === 'plain';
  const title = plain ? truncate(item.title, 200) : escapeSlackText(truncate(item.title, 200));
  const label = outcome === 'completed' ? `${run.kind} complete` : `${run.kind} failed — needs attention`;
  const icon = outcome === 'completed' ? ':white_check_mark:' : ':rotating_light:';
  const heading = plain ? `${icon} ${label} — ${title}` : `${icon} *${label}* — ${title}`;
  const taskRef = plain ? `task ${item.id.slice(0, 8)}` : `task \`${item.id.slice(0, 8)}\``;
  const link = plain ? appOrigin : `<${appOrigin}|open Workbench>`;
  const meta = `${run.agent} · ${taskRef} · ${link}`;
  const body = plain ? truncate(detail, maxDetailLength) : safeDetail(detail);
  return body ? `${heading}\n${meta}\n\n${body}` : `${heading}\n${meta}`;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, maxRetryDelayMs) : null;
}

const defaultSleep = (ms: number) => new Promise<void>((done) => { setTimeout(done, ms); });

interface AttemptOutcome { ok: boolean; error?: string; retryable: boolean; retryAfterMs?: number | null }

async function attemptDelivery(text: string, config: SlackConfig, fetchImpl: typeof fetch): Promise<AttemptOutcome> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  if (config.mode === 'workflow') {
    const response = await fetchImpl(config.webhookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [config.variableName!]: text }),
      signal,
    });
    // A trigger answers with a JSON body even on 2xx, and reports an unpublished workflow or
    // an undeclared variable as ok:false — so the status alone cannot be trusted.
    const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (response.ok && payload?.ok !== false) return { ok: true, retryable: false };
    const reason = payload?.error ?? response.statusText ?? 'unknown_error';
    const retryable = response.status === 429 || response.status >= 500 || reason === 'ratelimited';
    return {
      ok: false,
      error: `Slack workflow trigger returned ${response.status}: ${reason}`,
      retryable,
      retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    };
  }
  if (config.mode === 'webhook') {
    const response = await fetchImpl(config.webhookUrl!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    if (response.ok) return { ok: true, retryable: false };
    const reason = (await response.text().catch(() => '')).trim() || response.statusText;
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, error: `Slack webhook returned ${response.status}: ${reason}`, retryable, retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) };
  }
  const response = await fetchImpl(chatPostMessageUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${config.botToken!}` },
    body: JSON.stringify({ channel: config.channel, text, unfurl_links: false }),
    signal,
  });
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, error: `Slack chat.postMessage returned ${response.status} ${response.statusText}`, retryable, retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) };
  }
  // Slack signals application errors with HTTP 200 and ok:false, so the body must be inspected.
  const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string; channel?: string } | null;
  if (payload?.ok) return { ok: true, retryable: false };
  const error = payload?.error ?? 'unknown_error';
  return { ok: false, error: `Slack rejected the message: ${error}`, retryable: error === 'ratelimited', retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')) };
}

export async function sendSlackMessage(text: string, options: SlackDeliveryOptions = {}): Promise<SlackDeliveryResult> {
  const env = options.env ?? process.env;
  const config = resolveSlackConfig(env);
  if (!config) return { ok: false, mode: null, error: describeSlackConfig(env).problem!, attempts: 0 };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, options.maxAttempts ?? defaultMaxAttempts);

  let lastError = 'Slack delivery failed.';
  let usedAttempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    usedAttempts = attempt;
    let outcome: AttemptOutcome;
    try {
      outcome = await attemptDelivery(text, config, fetchImpl);
    } catch (error) {
      // Network faults and the per-attempt timeout are both transient by nature.
      outcome = { ok: false, error: error instanceof Error ? error.message : 'Slack request failed.', retryable: true };
    }
    if (outcome.ok) return { ok: true, mode: config.mode, channel: config.channel, attempts: attempt };
    lastError = outcome.error ?? lastError;
    if (!outcome.retryable || attempt === maxAttempts) break;
    await sleep(outcome.retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), maxRetryDelayMs));
  }
  return { ok: false, mode: config.mode, error: lastError, attempts: usedAttempts };
}

/**
 * Notifications are advisory: a Slack outage must never fail or delay the agent run that
 * triggered it, so this never throws and never blocks the caller.
 */
export function notifyAgentRunFinished(
  item: Pick<WorkItem, 'id' | 'title'>,
  run: Pick<AgentRun, 'agent' | 'kind'>,
  outcome: AgentRunOutcome,
  detail: string,
  options: SlackDeliveryOptions = {},
): void {
  const env = options.env ?? process.env;
  const config = resolveSlackConfig(env);
  if (!config) return;
  const markup: SlackMarkup = config.mode === 'workflow' ? 'plain' : 'mrkdwn';
  const appOrigin = env.APP_ORIGIN ?? 'http://localhost:5173';
  void sendSlackMessage(buildRunNotificationText(item, run, outcome, detail, appOrigin, markup), options)
    .then((result) => {
      if (!result.ok) console.warn(`[slack] notification not delivered for task ${item.id}: ${result.error}`);
    })
    .catch((error: unknown) => {
      console.warn(`[slack] notification threw for task ${item.id}: ${error instanceof Error ? error.message : 'unknown error'}`);
    });
}
