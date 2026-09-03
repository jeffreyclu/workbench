import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { DEFAULT_ACCOUNT_PROFILE } from '../shared/contracts.js';
import {
  AGENT_DEBUGGER_CONTRACT,
  AGENT_EXECUTION_CONTRACT,
  TOOL_OUTPUT_CONTRACT,
  agentEnvironmentForWorkspace,
  blockedPersistentForegroundCommand,
  blockedWorkbenchBranchCommand,
  blockedWorkbenchDependencyBootstrapCommand,
  blockedWriterTestSuiteCommand,
  isWorkbenchWorkspace,
  isWriterWorkspace,
  type AgentAuditCandidate,
  type AgentUsage,
} from './agent-runner.js';
import { chatWithPalmyra, type PalmyraMessage, type PalmyraTool, type PalmyraToolCall } from './providers/palmyra.js';

const MAX_ROUNDS = 48;
const MAX_TOOL_OUTPUT = 40_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

const tools: PalmyraTool[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file in the current workspace. Use line bounds for large files.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, line_count: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a UTF-8 file in the current workspace. Inspect an existing file before replacing it.',
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

function workspacePath(cwd: string, requested: string): string {
  if (!requested.trim()) throw new Error('path must not be empty.');
  const target = resolve(cwd, requested);
  const rel = relative(resolve(cwd), target);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`Path is outside the resolved workspace: ${requested}`);
  }
  return target;
}

function bounded(value: string): string {
  if (Buffer.byteLength(value) <= MAX_TOOL_OUTPUT) return value;
  return `${value.slice(0, MAX_TOOL_OUTPUT)}\n[output truncated at ${MAX_TOOL_OUTPUT} characters]`;
}

function commandPolicyError(command: string, cwd: string): string | null {
  if (blockedPersistentForegroundCommand(command)) return 'Persistent foreground commands are not allowed; use a managed launcher that returns after readiness.';
  if (isWorkbenchWorkspace(cwd) && blockedWorkbenchBranchCommand(command)) return 'Workbench branch and worktree state is runtime-owned; this Git mutation is not allowed.';
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
    const path = workspacePath(cwd, requested);
    const text = await readFile(path, 'utf8');
    const start = typeof input.start_line === 'number' ? Math.max(1, Math.floor(input.start_line)) : 1;
    const count = typeof input.line_count === 'number' ? Math.min(1000, Math.max(1, Math.floor(input.line_count))) : 250;
    const content = bounded(text.split('\n').slice(start - 1, start - 1 + count).map((line, index) => `${start + index}: ${line}`).join('\n'));
    return { content, audit: { category: 'agent_file_read', streamKind: 'file_read', detail: requested } };
  }
  if (call.function.name === 'write_file') {
    const requested = requiredString(input, 'path');
    const content = requiredString(input, 'content');
    const path = workspacePath(cwd, requested);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
    return { content: `Wrote ${Buffer.byteLength(content)} bytes to ${requested}.`, audit: { category: 'agent_file_write', streamKind: 'file_write', detail: requested } };
  }
  if (call.function.name === 'replace_in_file') {
    const requested = requiredString(input, 'path');
    const oldText = requiredString(input, 'old_text');
    const newText = requiredString(input, 'new_text');
    if (!oldText) throw new Error('old_text must not be empty.');
    const path = workspacePath(cwd, requested);
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
}): Promise<PalmyraAgentResult> {
  const messages: PalmyraMessage[] = [
    { role: 'system', content: `You are Palmyra, a first-class coding agent running inside Workbench. Use the provided tools to inspect, execute, edit, and verify directly in the resolved workspace. Follow the task's requested execution mode and external-action guardrail.\n\n${AGENT_EXECUTION_CONTRACT}\n\n${TOOL_OUTPUT_CONTRACT}\n\n${AGENT_DEBUGGER_CONTRACT}` },
    { role: 'user', content: options.prompt },
  ];
  const pendingInterjections: string[] = [];
  const steer = Object.assign(async (body: string) => {
    if (options.signal?.aborted) return false;
    pendingInterjections.push(body);
    return true;
  }, { cancel: () => { /* The shared AbortController owns cancellation. */ } });
  options.onSteeringReady?.(steer);
  let usage: AgentUsage = { inputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null, outputTokens: null };
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Palmyra run canceled.');
    const response = await chatWithPalmyra({ messages, tools, toolChoice: 'auto', maxTokens: 4_096, timeoutMs: 120_000, signal: options.signal, model: options.model });
    usage = {
      inputTokens: response.usage.inputTokens === null ? usage.inputTokens : (usage.inputTokens ?? 0) + response.usage.inputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      outputTokens: response.usage.outputTokens === null ? usage.outputTokens : (usage.outputTokens ?? 0) + response.usage.outputTokens,
    };
    options.onUsage?.(usage, 'palmyra');
    messages.push({ role: 'assistant', content: response.content, ...(response.toolCalls.length ? { tool_calls: response.toolCalls } : {}) });
    if (!response.toolCalls.length && pendingInterjections.length) {
      messages.push(...pendingInterjections.splice(0).map((content): PalmyraMessage => ({ role: 'user', content })));
      continue;
    }
    if (!response.toolCalls.length) {
      if (!response.content) throw new Error('Palmyra returned no final response.');
      options.onProgress?.(response.content);
      return { output: response.content, agent: 'palmyra', usage, fallbackFrom: null, fallbackReason: null, sessionId: null, costUsd: null };
    }
    if (response.content) options.onProgress?.(response.content);
    for (const call of response.toolCalls) {
      let content: string;
      try {
        const result = await executeTool(call, options.cwd, options.signal);
        content = result.content;
        options.onAudit?.([result.audit], 'palmyra');
        options.onProgress?.(`● Palmyra used ${call.function.name}: ${result.audit.detail}`);
      } catch (error) {
        content = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        options.onProgress?.(`● ${content}`);
      }
      messages.push({ role: 'tool', name: call.function.name, tool_call_id: call.id, content });
    }
    messages.push(...pendingInterjections.splice(0).map((content): PalmyraMessage => ({ role: 'user', content })));
  }
  throw new Error(`Palmyra exceeded the ${MAX_ROUNDS}-round tool limit.`);
}
