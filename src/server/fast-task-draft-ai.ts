import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GeneratedTaskDraft } from '../shared/contracts.js';
import { fastTaskDraft } from '../shared/task-draft.js';
import { completeWithPalmyra } from './providers/palmyra.js';
import { resolveAiProvider } from './providers/provider-choice.js';
import type { AiProviderChoice } from '../shared/ai-providers.js';

const SYSTEM_PROMPT = `You convert a rough work request into one agent-executable task. Return only minified JSON: {"title":"...","description":"..."}. The title must start with a concrete imperative verb that identifies the work type (for example Fix, Implement, Review, Research, Write, or Investigate). Keep it under 120 characters. The description must be concise and self-contained while preserving every supplied link, constraint, and expected outcome. Do not invent scope, requirements, files, or acceptance criteria.`;

type Pending = { prompt: string; resolve: (draft: GeneratedTaskDraft) => void; reject: (error: Error) => void };
let worker: ChildProcessWithoutNullStreams | null = null;
let outputBuffer = '';
let active: Pending | null = null;
const queue: Pending[] = [];
let idleShutdown: ReturnType<typeof setTimeout> | null = null;
const IDLE_SHUTDOWN_MS = 30_000;

function scheduleIdleShutdown(): void {
  if (active || queue.length || !worker) return;
  if (idleShutdown) clearTimeout(idleShutdown);
  idleShutdown = setTimeout(() => stopWorker(new Error('Fast task-draft AI stopped after being idle.')), IDLE_SHUTDOWN_MS);
  idleShutdown.unref();
}

export function parseTaskDraftResponse(output: string, originalPrompt: string): GeneratedTaskDraft {
  const json = output.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('Fast task-draft AI returned no JSON.');
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (typeof parsed.title !== 'string' || typeof parsed.description !== 'string') throw new Error('Fast task-draft AI returned an incomplete draft.');
  const normalizedTitle = fastTaskDraft(parsed.title).title;
  return { title: normalizedTitle, description: parsed.description.trim() || originalPrompt, projectName: null, workspacePath: null };
}

function dispatchNext(): void {
  if (!worker || active || queue.length === 0) {
    scheduleIdleShutdown();
    return;
  }
  if (idleShutdown) clearTimeout(idleShutdown);
  idleShutdown = null;
  active = queue.shift()!;
  worker.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: active.prompt } })}\n`);
}

function stopWorker(error: Error): void {
  if (idleShutdown) clearTimeout(idleShutdown);
  idleShutdown = null;
  worker?.kill('SIGTERM');
  worker = null;
  outputBuffer = '';
  if (active) { active.reject(error); active = null; }
  while (queue.length) { const pending = queue.shift()!; pending.reject(error); }
}

function ensureWorker(): ChildProcessWithoutNullStreams {
  if (worker && !worker.killed) return worker;
  worker = spawn('claude', [
    '-p', '--verbose', '--model', 'haiku', '--effort', 'low', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPT,
    '--input-format', 'stream-json', '--output-format', 'stream-json',
  ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (chunk: string) => {
    outputBuffer += chunk;
    for (;;) {
      const newline = outputBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = outputBuffer.slice(0, newline); outputBuffer = outputBuffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
        if (event.type !== 'result' || !active) continue;
        const pending = active; active = null;
        if (event.is_error || typeof event.result !== 'string') pending.reject(new Error('Fast task-draft AI failed.'));
        else {
          try { pending.resolve(parseTaskDraftResponse(event.result, pending.prompt)); }
          catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
        }
        dispatchNext();
      } catch { /* Claude stream events that are not complete JSON lines are ignored. */ }
    }
  });
  worker.once('exit', () => stopWorker(new Error('Fast task-draft AI stopped unexpectedly.')));
  worker.once('error', (error) => stopWorker(error));
  return worker;
}

function draftWithWorker(prompt: string): Promise<GeneratedTaskDraft> {
  ensureWorker();
  return new Promise((resolve, reject) => {
    // Task drafting now happens in the background after the create-task modal
    // closes, so there is no UI waiting on this call and nothing to time out.
    queue.push({ prompt, resolve, reject });
    dispatchNext();
  });
}

async function draftWithPalmyra(prompt: string): Promise<GeneratedTaskDraft> {
  const content = await completeWithPalmyra({
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
    maxTokens: 600,
    timeoutMs: 15_000,
  });
  return parseTaskDraftResponse(content, prompt);
}

/** Palmyra is one HTTP round trip instead of a persistent agent-CLI subprocess
 * for a turn that only has to return two strings, so `auto` prefers it wherever
 * it is usable. The Claude worker stays as the fallback so an expired key, a
 * rate limit, or an unparseable reply still produces a draft. */
export function generateFastAiTaskDraft(prompt: string, provider: AiProviderChoice | null = null, accountProfile?: string): Promise<GeneratedTaskDraft> {
  if (resolveAiProvider(provider, accountProfile) !== 'palmyra') return draftWithWorker(prompt);
  return draftWithPalmyra(prompt).catch((error: unknown) => {
    console.warn(`[palmyra] task draft fell back to the Claude worker: ${error instanceof Error ? error.message : String(error)}`);
    return draftWithWorker(prompt);
  });
}

export function warmFastTaskDraftModel(): void {
  // The Palmyra path is stateless, so there is no subprocess worth spawning.
  if (resolveAiProvider('auto') === 'palmyra') return;
  void generateFastAiTaskDraft('Write a task to verify the fast task-draft formatter is ready.').catch(() => undefined);
}

export function shutdownFastTaskDraftModel(): void {
  stopWorker(new Error('Fast task-draft AI stopped during runtime shutdown.'));
}
