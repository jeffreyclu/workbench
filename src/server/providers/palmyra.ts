import { createOutboundFetch } from '../outbound-policy.js';

/** Writer's hosted Palmyra inference API. Palmyra X4+ supports custom function
 * calling, but this adapter intentionally exposes no tools: it has no isolated
 * worktree, scoped file capability, or agent audit stream. Model access (including
 * X6) therefore never becomes implicit permission to change Workbench files. */
const ENDPOINT = 'https://api.writer.com/v1/chat';
const DEFAULT_MODEL = 'palmyra-x5';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1_024;

export interface PalmyraMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PalmyraCompletionRequest {
  messages: PalmyraMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PalmyraChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

const palmyraFetch = createOutboundFetch('palmyra-api');

/** The key is read per call, not captured at import time, so a key added to
 * the environment of a restarted process takes effect without touching this
 * module, and tests can set and clear it around a single assertion. */
export function palmyraApiKey(): string | null {
  return process.env.WRITER_API_KEY?.trim() || null;
}

export function palmyraModel(): string {
  return process.env.WORKBENCH_PALMYRA_MODEL?.trim() || DEFAULT_MODEL;
}

export function isPalmyraConfigured(): boolean {
  return palmyraApiKey() !== null;
}

export async function completeWithPalmyra(request: PalmyraCompletionRequest, fetchImpl: typeof fetch = palmyraFetch): Promise<string> {
  const key = palmyraApiKey();
  if (!key) throw new Error('Palmyra is not configured: set WRITER_API_KEY.');
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: request.model ?? palmyraModel(),
      messages: request.messages,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: request.temperature ?? 0,
      stream: false,
    }),
    signal: request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
      : AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Palmyra request failed (${response.status}).${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }
  const payload = await response.json() as PalmyraChatResponse;
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Palmyra returned an empty completion.');
  return content;
}
