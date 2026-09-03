import { createOutboundFetch } from '../outbound-policy.js';

/** Writer's hosted Palmyra inference API. Tool execution remains owned by the
 * caller so Workbench can enforce workspace, command, and audit policies. */
const ENDPOINT = 'https://api.writer.com/v1/chat';
const DEFAULT_MODEL = 'palmyra-x5';
const DEFAULT_TIMEOUT_MS = 20_000;
const PALMYRA_X_MAX_OUTPUT_TOKENS = 8_192;

export function palmyraMaxOutputTokens(model = palmyraModel()): number {
  return model === 'palmyra-x5' || model === 'palmyra-x6' ? PALMYRA_X_MAX_OUTPUT_TOKENS : 4_096;
}

export interface PalmyraTextContent {
  type: 'text';
  text: string;
}

export interface PalmyraImageContent {
  type: 'image_url';
  image_url: { url: string };
}

interface PalmyraTextMessage {
  role: 'system' | 'user';
  content: string | Array<PalmyraTextContent | PalmyraImageContent>;
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

export interface PalmyraFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface PalmyraWebSearchTool {
  type: 'web_search';
  function: {
    include_domains?: string[];
    exclude_domains?: string[];
  };
}

export type PalmyraTool = PalmyraFunctionTool | PalmyraWebSearchTool;

export interface PalmyraCompletionRequest {
  messages: PalmyraMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export interface PalmyraChatRequest extends PalmyraCompletionRequest {
  tools?: PalmyraTool[];
  toolChoice?: 'auto' | 'none';
}

export interface PalmyraChatResult {
  content: string | null;
  toolCalls: PalmyraToolCall[];
  webSearchSources?: string[];
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
  };
  finishReason: string | null;
}

interface PalmyraChatResponse {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: PalmyraToolCall[]; web_search_data?: { sources?: Array<{ url?: string | null }> } | null };
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
      web_search_data?: { sources?: Array<{ url?: string | null }> } | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  accumulated_usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface PalmyraStreamCallbacks {
  onContent?: (delta: string, accumulated: string) => void;
  onToolCall?: (calls: PalmyraToolCall[]) => void;
  onActivity?: () => void;
}

const palmyraFetch = createOutboundFetch('palmyra-api');

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number | null | undefined): AbortSignal | undefined {
  if (timeoutMs === null) return signal;
  const timeout = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

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
      max_tokens: request.maxTokens ?? palmyraMaxOutputTokens(request.model),
      temperature: request.temperature ?? 0,
      stream: false,
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    }),
    signal: requestSignal(request.signal, request.timeoutMs),
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
    ...((message?.web_search_data?.sources ?? []).flatMap((source) => source.url ? [source.url] : []).length
      ? { webSearchSources: [...new Set((message?.web_search_data?.sources ?? []).flatMap((source) => source.url ? [source.url] : []))] }
      : {}),
    usage: {
      inputTokens: payload.usage?.prompt_tokens ?? null,
      outputTokens: payload.usage?.completion_tokens ?? null,
    },
    finishReason: payload.choices?.[0]?.finish_reason ?? null,
  };
}

/**
 * Writer exposes OpenAI-compatible SSE chat chunks. Keep this transport here,
 * beside the non-streaming client, so every Palmyra caller shares the same
 * authentication, model-limit, timeout, and response decoding rules.
 */
export async function streamChatWithPalmyra(
  request: PalmyraChatRequest,
  callbacks: PalmyraStreamCallbacks = {},
  fetchImpl: typeof fetch = palmyraFetch,
): Promise<PalmyraChatResult> {
  const key = palmyraApiKey();
  if (!key) throw new Error('Palmyra is not configured: set WRITER_API_KEY.');
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model: request.model ?? palmyraModel(),
      messages: request.messages,
      max_tokens: request.maxTokens ?? palmyraMaxOutputTokens(request.model),
      temperature: request.temperature ?? 0,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    }),
    signal: requestSignal(request.signal, request.timeoutMs),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Palmyra request failed (${response.status}).${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }
  if (!response.body) throw new Error('Palmyra streaming response had no body.');

  const calls = new Map<number, PalmyraToolCall>();
  let content = '';
  let finishReason: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  const webSearchSources = new Set<string>();
  let buffered = '';
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const chunk = JSON.parse(data) as PalmyraChatResponse;
    callbacks.onActivity?.();
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (choice?.delta?.content) {
      content += choice.delta.content;
      callbacks.onContent?.(choice.delta.content, content);
    }
    for (const fragment of choice?.delta?.tool_calls ?? []) {
      const index = fragment.index ?? calls.size;
      const existing = calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
      if (fragment.id) existing.id += fragment.id;
      if (fragment.function?.name) existing.function.name += fragment.function.name;
      if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments;
      calls.set(index, existing);
    }
    for (const source of choice?.delta?.web_search_data?.sources ?? choice?.message?.web_search_data?.sources ?? []) {
      if (source.url) webSearchSources.add(source.url);
    }
    const streamedUsage = chunk.accumulated_usage ?? chunk.usage;
    if (typeof streamedUsage?.prompt_tokens === 'number') inputTokens = streamedUsage.prompt_tokens;
    if (typeof streamedUsage?.completion_tokens === 'number') outputTokens = streamedUsage.completion_tokens;
  };
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    buffered += decoder.decode(bytes, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) consume(line);
  }
  buffered += decoder.decode();
  for (const line of buffered.split(/\r?\n/)) consume(line);
  const toolCalls = [...calls.entries()].sort(([left], [right]) => left - right).map(([, call]) => call);
  if (toolCalls.length) callbacks.onToolCall?.(toolCalls);
  return { content: content.trim() || null, toolCalls, ...(webSearchSources.size ? { webSearchSources: [...webSearchSources] } : {}), usage: { inputTokens, outputTokens }, finishReason };
}

export async function completeWithPalmyra(request: PalmyraCompletionRequest, fetchImpl: typeof fetch = palmyraFetch): Promise<string> {
  const { content } = await chatWithPalmyra(request, fetchImpl);
  if (!content) throw new Error('Palmyra returned an empty completion.');
  return content;
}
