import { createOutboundFetch } from '../outbound-policy.js';

/** Writer's hosted Palmyra inference API. Workbench owns the agent runtime and
 * sends tool results back through this endpoint until Palmyra finishes. */
const ENDPOINT = 'https://api.writer.com/v1/chat';
const DEFAULT_MODEL = 'palmyra-x5';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1_024;

export interface PalmyraToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface PalmyraTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface PalmyraMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: PalmyraToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface PalmyraCompletionRequest {
  messages: PalmyraMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  tools?: PalmyraTool[];
  toolChoice?: 'auto' | 'none';
}

interface PalmyraChatResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: PalmyraToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface PalmyraChatResult {
  content: string | null;
  toolCalls: PalmyraToolCall[];
  usage: { inputTokens: number | null; outputTokens: number | null };
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

export async function chatWithPalmyra(request: PalmyraCompletionRequest, fetchImpl: typeof fetch = palmyraFetch): Promise<PalmyraChatResult> {
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
      ...(request.tools?.length ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' } : {}),
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
  const message = payload.choices?.[0]?.message;
  const content = message?.content?.trim() || null;
  const toolCalls = message?.tool_calls?.filter((call) => call?.id && call.type === 'function' && call.function?.name) ?? [];
  if (!content && !toolCalls.length) throw new Error('Palmyra returned an empty completion.');
  return {
    content,
    toolCalls,
    usage: { inputTokens: payload.usage?.prompt_tokens ?? null, outputTokens: payload.usage?.completion_tokens ?? null },
  };
}

export async function completeWithPalmyra(request: PalmyraCompletionRequest, fetchImpl: typeof fetch = palmyraFetch): Promise<string> {
  const { content } = await chatWithPalmyra(request, fetchImpl);
  if (!content) throw new Error('Palmyra returned an empty completion.');
  return content;
}
