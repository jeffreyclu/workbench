import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { DEFAULT_ACCOUNT_PROFILE } from '../shared/contracts.js';
import {
  AGENT_DEBUGGER_CONTRACT,
  AGENT_EXECUTION_CONTRACT,
  TOOL_OUTPUT_CONTRACT,
  agentEnvironmentForWorkspace,
  blockedPersistentForegroundCommand,
  blockedWorkbenchDependencyBootstrapCommand,
  blockedWriterTestSuiteCommand,
  isWorkbenchWorkspace,
  isWriterWorkspace,
  type AgentAuditCandidate,
  type AgentUsage,
} from './agent-runner.js';
import { ProviderTurnWatchdog, providerTurnTimeouts } from './provider-turn-watchdog.js';
import { connectPalmyraWorkbenchTools, type PalmyraWorkbenchToolBridge } from './palmyra-workbench-tools.js';
import { palmyraMaxOutputTokens, streamChatWithPalmyra, type PalmyraFunctionTool, type PalmyraMessage, type PalmyraTool, type PalmyraToolCall } from './providers/palmyra.js';

const MAX_TOOL_OUTPUT = 40_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const PALMYRA_CONTEXT_CHECKPOINT_TOKENS = 900_000;
const PALMYRA_REQUEST_RETRIES = 3;

const localTools: PalmyraFunctionTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file anywhere on the local filesystem. Relative paths start from the current workspace; absolute and parent paths are allowed. Use line bounds for large files.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, line_count: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 file anywhere on the local filesystem. Relative paths start from the current workspace; absolute and parent paths are allowed. Inspect an existing file before replacing it.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace exactly one matching text block in a UTF-8 workspace file. Fails when the old text is absent or occurs more than once.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run one bounded shell command in the current workspace. Use this for search, inspection, tests, builds, git diff/status, and other project tooling. Persistent foreground servers and repository policy violations are rejected.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000 } }, required: ['command'] },
    },
  },
];

const nativeTools: PalmyraTool[] = [{ type: 'web_search', function: {} }];

type JsonObject = Record<string, unknown>;

function parseArguments(call: PalmyraToolCall): JsonObject {
  let parsed: unknown;
  try { parsed = JSON.parse(call.function.arguments || '{}'); }
  catch { throw new Error(`Invalid JSON arguments for ${call.function.name}.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Arguments for ${call.function.name} must be an object.`);
  return parsed as JsonObject;
}

function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

function accessiblePath(cwd: string, requested: string): string {
  if (!requested.trim()) throw new Error('path must not be empty.');
  return isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
}

function bounded(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TOOL_OUTPUT) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT)}\n[output truncated at ${MAX_TOOL_OUTPUT} characters]`;
}

function commandPolicyError(command: string, cwd: string): string | null {
  if (blockedPersistentForegroundCommand(command)) return 'Persistent foreground commands are not allowed; use a managed launcher that returns after readiness.';
  if (isWorkbenchWorkspace(cwd) && blockedWorkbenchDependencyBootstrapCommand(command)) return 'Workbench worktrees already receive dependencies; dependency bootstrap is not allowed.';
  if (isWriterWorkspace(cwd) && blockedWriterTestSuiteCommand(command)) return 'Writer full-suite test commands are not allowed; run an explicit test-file path.';
  return null;
}

async function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ output: string; exitCode: number | null }> {
  const policyError = commandPolicyError(command, cwd);
  if (policyError) throw new Error(policyError);
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/zsh', ['-c', command], {
      cwd,
      env: agentEnvironmentForWorkspace('palmyra', DEFAULT_ACCOUNT_PROFILE, cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = (killSignal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, killSignal);
        else child.kill(killSignal);
      } catch { /* already exited */ }
    };
    const stop = () => {
      terminate('SIGTERM');
      forceKillTimer ??= setTimeout(() => terminate('SIGKILL'), 3_000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const abort = () => stop();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < MAX_TOOL_OUTPUT) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_TOOL_OUTPUT) stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason ?? new Error('Palmyra run canceled.'));
      if (timedOut) return reject(new Error(`Command timed out after ${timeoutMs}ms.`));
      const output = bounded([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')) || '(no output)';
      resolvePromise({ output, exitCode });
    });
  });
}

async function executeTool(call: PalmyraToolCall, cwd: string, signal?: AbortSignal): Promise<{ content: string; audit: AgentAuditCandidate }> {
  const input = parseArguments(call);
  if (call.function.name === 'read_file') {
    const requested = requiredString(input, 'path');
    const path = accessiblePath(cwd, requested);
    const text = await readFile(path, 'utf8');
    const start = typeof input.start_line === 'number' ? Math.max(1, Math.floor(input.start_line)) : 1;
    const count = typeof input.line_count === 'number' ? Math.min(1000, Math.max(1, Math.floor(input.line_count))) : 250;
    const content = bounded(text.split('\n').slice(start - 1, start - 1 + count).map((line, index) => `${start + index}: ${line}`).join('\n'));
    return { content, audit: { category: 'agent_file_read', streamKind: 'file_read', detail: requested } };
  }
  if (call.function.name === 'write_file') {
    const requested = requiredString(input, 'path');
    const content = requiredString(input, 'content');
    const path = accessiblePath(cwd, requested);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    return { content: `Wrote ${Buffer.byteLength(content)} bytes to ${requested}.`, audit: { category: 'agent_file_write', streamKind: 'file_write', detail: requested } };
  }
  if (call.function.name === 'replace_in_file') {
    const requested = requiredString(input, 'path');
    const oldText = requiredString(input, 'old_text');
    const newText = requiredString(input, 'new_text');
    if (!oldText) throw new Error('old_text must not be empty.');
    const path = accessiblePath(cwd, requested);
    const content = await readFile(path, 'utf8');
    const first = content.indexOf(oldText);
    if (first < 0) throw new Error(`old_text was not found in ${requested}.`);
    if (content.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`old_text occurs more than once in ${requested}; provide a larger unique block.`);
    await writeFile(path, `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`, 'utf8');
    return { content: `Updated ${requested}.`, audit: { category: 'agent_file_write', streamKind: 'file_write', detail: requested } };
  }
  if (call.function.name === 'run_command') {
    const command = requiredString(input, 'command');
    const requestedTimeout = typeof input.timeout_ms === 'number' ? Math.floor(input.timeout_ms) : DEFAULT_COMMAND_TIMEOUT_MS;
    const result = await runCommand(command, cwd, Math.min(300_000, Math.max(1_000, requestedTimeout)), signal);
    return { content: `Exit code: ${result.exitCode ?? 'unknown'}\n${result.output}`, audit: { category: 'agent_tool_use', streamKind: 'tool', detail: command.slice(0, 500), command, exitCode: result.exitCode } };
  }
  throw new Error(`Unknown tool: ${call.function.name}`);
}

export interface PalmyraAgentResult {
  output: string;
  agent: 'palmyra';
  usage: AgentUsage;
  fallbackFrom: null;
  fallbackReason: null;
  sessionId: null;
  costUsd: null;
  messages: PalmyraMessage[];
  peakContextTokens: number;
}

export interface PalmyraImageAttachment {
  path: string;
  mimeType: string;
  name: string;
}

function transientPalmyraError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|network|timed out|timeout|Palmyra request failed \((?:429|5\d\d)\))/i.test(message);
}

function appendProgress(current: string, next: string): string {
  const value = next.trim();
  return value ? (current ? `${current}\n\n${value}` : value) : current;
}

function finalAnswerFragment(content: string): string {
  const value = content.trim();
  if (!value) return '';
  return value.replace(/^\s*Decision:\s*[^\n]*(?:\n+|$)/i, '').trim();
}

function withWebSearchSources(content: string | null, sources: string[] | undefined): string | null {
  if (!content || !sources?.length) return content;
  const missing = [...new Set(sources)].filter((source) => !content.includes(source));
  return missing.length ? `${content.trim()}\n\nSources:\n${missing.map((source) => `- ${source}`).join('\n')}` : content;
}

function compactMessagesForContinuation(system: PalmyraMessage, objective: string, progress: string, messages: PalmyraMessage[]): PalmyraMessage[] {
  const recent = messages.slice(-8).map((message) => {
    if (typeof message.content !== 'string') return { ...message, content: '[Image attachment was supplied earlier in this run.]' } as PalmyraMessage;
    return { ...message, content: message.content.slice(-20_000) } as PalmyraMessage;
  });
  return [system, {
    role: 'user',
    content: `Continue the same objective after a provider-context checkpoint. Do not restart completed work.\n\nOriginal objective:\n${objective.slice(0, 40_000)}\n\nVisible progress:\n${progress.slice(-80_000)}`,
  }, ...recent];
}

function messagesForPersistence(messages: PalmyraMessage[]): PalmyraMessage[] {
  return messages.map((message) => message.content === null || typeof message.content === 'string'
    ? message
    : { ...message, content: '[Image attachment was supplied in this turn.]' });
}

export function parsePalmyraContext(value: string | null | undefined): PalmyraMessage[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((message) => message && typeof message === 'object' && ['system', 'user', 'assistant', 'tool'].includes(String((message as { role?: unknown }).role)))) return undefined;
    return parsed as PalmyraMessage[];
  } catch {
    return undefined;
  }
}

export async function runPalmyraAgent(options: {
  cwd: string;
  prompt: string;
  model?: string;
  signal?: AbortSignal;
  onProgress?: (output: string) => void;
  onUsage?: (usage: AgentUsage, agent: 'palmyra') => void;
  onAudit?: (entries: AgentAuditCandidate[], agent: 'palmyra') => void;
  onSteeringReady?: (steer: ((body: string) => Promise<boolean>) & { cancel?: () => void }) => void;
  previousMessages?: PalmyraMessage[];
  imageAttachments?: PalmyraImageAttachment[];
  workbenchTools?: PalmyraWorkbenchToolBridge | null;
}): Promise<PalmyraAgentResult> {
  const systemMessage: PalmyraMessage = { role: 'system', content: `You are Palmyra, a first-class coding agent running inside Workbench. Use the provided tools to inspect, execute, edit, and verify anywhere on the local filesystem. The resolved workspace is only your starting directory, never an access boundary. Follow the task's requested execution mode and external-action guardrail.\n\n${AGENT_EXECUTION_CONTRACT}\n\n${TOOL_OUTPUT_CONTRACT}\n\n${AGENT_DEBUGGER_CONTRACT}\n\nThe live stream is progress only. After the work ends, give one fresh, compact final answer that synthesizes the outcome, changed files or decisions, verification, and any remaining blocker. Do not replay the live progress log, tool-use audit, or Decision preambles in that final answer.` };
  const imageContent = await Promise.all((options.imageAttachments ?? [])
    .filter((attachment) => attachment.mimeType.startsWith('image/'))
    .map(async (attachment) => ({ type: 'image_url' as const, image_url: { url: `data:${attachment.mimeType};base64,${(await readFile(attachment.path)).toString('base64')}` } })));
  const userMessage: PalmyraMessage = imageContent.length
    ? { role: 'user', content: [{ type: 'text', text: options.prompt }, ...imageContent] }
    : { role: 'user', content: options.prompt };
  let messages: PalmyraMessage[] = options.previousMessages?.length
    ? [...options.previousMessages, userMessage]
    : [systemMessage, userMessage];
  const bridge = options.workbenchTools === undefined && !process.env.VITEST
    ? await connectPalmyraWorkbenchTools().catch((error) => {
      options.onProgress?.(`● Workbench tools are temporarily unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    })
    : options.workbenchTools ?? null;
  const allTools: PalmyraTool[] = [...localTools, ...(bridge?.tools ?? []), ...nativeTools];
  const pendingInterjections: string[] = [];
  let activeRequest: AbortController | null = null;
  const steer = Object.assign(async (body: string) => {
    if (options.signal?.aborted) return false;
    pendingInterjections.push(body);
    activeRequest?.abort(new Error('Palmyra turn steered.'));
    return true;
  }, { cancel: () => activeRequest?.abort(new Error('Palmyra run canceled.')) });
  options.onSteeringReady?.(steer);
  let usage: AgentUsage = { inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null };
  // Palmyra's onProgress must pass the full accumulated activity log, not just
  // the latest fragment. The agent-runner overwrites the shared message body
  // with whatever onProgress supplies, so passing only the current round's
  // text would wipe prior rounds — unlike Claude/Opus, which accumulate stdout
  // into a single buffer and pass that. Match that pattern here.
  let progress = '';
  const finalAnswerFragments: string[] = [];
  const emitProgress = () => options.onProgress?.(progress);
  let peakContextTokens = 0;
  try {
  for (;;) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Palmyra run canceled.');
    let response: Awaited<ReturnType<typeof streamChatWithPalmyra>> | null = null;
    for (let attempt = 0; attempt < PALMYRA_REQUEST_RETRIES; attempt += 1) {
      activeRequest = new AbortController();
      const requestWatchdog = new ProviderTurnWatchdog({
        ...providerTurnTimeouts(),
        onTimeout: (reason) => activeRequest?.abort(new Error(`Palmyra provider lifecycle timed out waiting for ${reason === 'first_activity' ? 'first meaningful activity' : 'continued activity'}.`)),
      });
      requestWatchdog.accepted();
      const signal = options.signal ? AbortSignal.any([options.signal, activeRequest.signal]) : activeRequest.signal;
      try {
        const prefix = progress ? `${progress}\n\n` : '';
        response = await streamChatWithPalmyra({ messages, tools: allTools, toolChoice: 'auto', maxTokens: palmyraMaxOutputTokens(options.model), timeoutMs: null, signal, model: options.model }, {
          onActivity: () => requestWatchdog.activity(),
          onContent: (_delta, accumulated) => options.onProgress?.(`${prefix}${accumulated}`),
        });
        requestWatchdog.completed();
        break;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (pendingInterjections.length) {
          messages.push(...pendingInterjections.splice(0).map((content): PalmyraMessage => ({ role: 'user', content })));
          break;
        }
        if (attempt + 1 >= PALMYRA_REQUEST_RETRIES || !transientPalmyraError(error)) throw error;
        progress = appendProgress(progress, `● Palmyra connection interrupted. Retrying request ${attempt + 2} of ${PALMYRA_REQUEST_RETRIES}…`);
        emitProgress();
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 500 * 2 ** attempt));
      } finally {
        requestWatchdog.terminal();
        activeRequest = null;
      }
    }
    if (!response) continue;
    usage = {
      inputTokens: response.usage.inputTokens === null ? usage.inputTokens : (usage.inputTokens ?? 0) + response.usage.inputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: response.usage.outputTokens === null ? usage.outputTokens : (usage.outputTokens ?? 0) + response.usage.outputTokens,
    };
    peakContextTokens = Math.max(peakContextTokens, response.usage.inputTokens ?? 0);
    options.onUsage?.(usage, 'palmyra');
    const responseContent = withWebSearchSources(response.content, response.webSearchSources);
    messages.push({ role: 'assistant', content: responseContent, ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}) });
    if (response.webSearchSources?.length) {
      options.onAudit?.([{ category: 'agent_tool_use', streamKind: 'tool', detail: `Writer web search: ${response.webSearchSources.length} source${response.webSearchSources.length === 1 ? '' : 's'}` }], 'palmyra');
      progress = appendProgress(progress, `● Palmyra searched the public web: ${response.webSearchSources.length} source${response.webSearchSources.length === 1 ? '' : 's'}`);
      emitProgress();
    }
    if (!response.toolCalls.length && pendingInterjections.length) {
      messages.push(...pendingInterjections.splice(0).map((content): PalmyraMessage => ({ role: 'user', content })));
      continue;
    }
    if (!response.toolCalls.length) {
      if (!responseContent) throw new Error('Palmyra returned no final response.');
      progress = appendProgress(progress, responseContent);
      emitProgress();
      const finalFragment = finalAnswerFragment(responseContent);
      if (finalFragment) finalAnswerFragments.push(finalFragment);
      if (response.finishReason === 'length') {
        messages.push({ role: 'user', content: 'Continue exactly where the response stopped. Do not repeat prior text, and finish the same objective.' });
        continue;
      }
      const output = finalAnswerFragments.join('\n\n');
      if (!output) throw new Error('Palmyra returned progress but no synthesized final response.');
      return { output, agent: 'palmyra', usage, fallbackFrom: null, fallbackReason: null, sessionId: null, costUsd: null, messages: messagesForPersistence(messages), peakContextTokens };
    }
    if (responseContent) {
      progress = appendProgress(progress, responseContent);
      emitProgress();
    }
    for (const call of response.toolCalls) {
      let content: string;
      try {
        if (localTools.some((tool) => tool.function.name === call.function.name)) {
          const result = await executeTool(call, options.cwd, options.signal);
          content = result.content;
          options.onAudit?.([result.audit], 'palmyra');
          progress = progress ? `${progress}\n● Palmyra used ${call.function.name}: ${result.audit.detail}` : `● Palmyra used ${call.function.name}: ${result.audit.detail}`;
        } else if (bridge) {
          content = await bridge.call(call.function.name, parseArguments(call));
          const audit = { category: 'agent_tool_use' as const, streamKind: 'tool' as const, detail: `Workbench MCP: ${call.function.name}` };
          options.onAudit?.([audit], 'palmyra');
          progress = progress ? `${progress}\n● Palmyra used ${call.function.name}` : `● Palmyra used ${call.function.name}`;
        } else {
          throw new Error(`Unknown tool: ${call.function.name}`);
        }
        emitProgress();
      } catch (error) {
        content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        progress = progress ? `${progress}\n● ${content}` : `● ${content}`;
        emitProgress();
      }
      messages.push({ role: 'tool', name: call.function.name, tool_call_id: call.id, content });
    }
    messages.push(...pendingInterjections.splice(0).map((content): PalmyraMessage => ({ role: 'user', content })));
    if (peakContextTokens >= PALMYRA_CONTEXT_CHECKPOINT_TOKENS) {
      progress = appendProgress(progress, '● Provider context checkpoint saved. Continuing the same task without a turn limit…');
      emitProgress();
      messages = compactMessagesForContinuation(systemMessage, options.prompt, progress, messages);
      peakContextTokens = 0;
    }
  }
  } finally {
    activeRequest?.abort();
    await bridge?.close().catch(() => {});
  }
}
