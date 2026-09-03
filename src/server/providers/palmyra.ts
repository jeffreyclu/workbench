import { createOutboundFetch } from '../outbound-policy.js';

/** Writer's hosted Palmyra inference API. Tool execution remains owned by the
 * caller so Workbench can enforce workspace, command, and audit policies. */
const ENDPOINT = 'https://api.writer.com/v1/chat';
const DEFAULT_MODEL = 'palmyra-x5';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 1_024;

interface PalmyraTextMessage {
  role: 'system' | 'user';
  content: string;
}

interface PalmyraAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: PalmyraToolCall[];
}

interface PalmyraToolMessage {
  role: 'tool';
  content: string;
  name: string;
  tool_call_id: string;
}

export type PalmyraMessage = PalmyraTextMessage | PalmyraAssistantMessage | PalmyraToolMessage;

export interface PalmyraToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface PalmyraTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface PalmyraCompletionRequest {
  messages: PalmyraMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PalmyraChatRequest extends PalmyraCompletionRequest {
  tools?: PalmyraTool[];
  toolChoice?: 'auto' | 'none';
}

export interface PalmyraChatResult {
  content: string | null;
  toolCalls: PalmyraToolCall[];
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
}

interface PalmyraChatResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: PalmyraToolCall[] } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
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

export async function chatWithPalmyra(request: PalmyraChatRequest, fetchImpl: typeof fetch = palmyraFetch): Promise<PalmyraChatResult> {
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
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
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
  return {
    content: message?.content?.trim() || null,
    toolCalls: message?.tool_calls ?? [],
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
    },
  };
}

export async function completeWithPalmyra(request: PalmyraCompletionRequest, fetchImpl: typeof fetch = palmyraFetch): Promise<string> {
  const { content } = await chatWithPalmyra(request, fetchImpl);
  if (!content) throw new Error('Palmyra returned an empty completion.');
  return content;
}
