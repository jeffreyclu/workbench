import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GeneratedTaskDraft } from '../shared/contracts.js';
import { fastTaskDraft } from '../shared/task-draft.js';

const SYSTEM_PROMPT = `You convert a rough work request into one agent-executable task. Return only minified JSON: {"title":"...","description":"..."}. The title must start with a concrete imperative verb that identifies the work type (for example Fix, Implement, Review, Research, Write, or Investigate). Keep it under 120 characters. The description must be concise and self-contained while preserving every supplied link, constraint, and expected outcome. Do not invent scope, requirements, files, or acceptance criteria.`;

type Pending = { prompt: string; resolve: (draft: GeneratedTaskDraft) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };
let worker: ChildProcessWithoutNullStreams | null = null;
let outputBuffer = '';
let active: Pending | null = null;
const queue: Pending[] = [];

function parseDraft(output: string, originalPrompt: string): GeneratedTaskDraft {
  const json = output.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error('Fast task-draft AI returned no JSON.');
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (typeof parsed.title !== 'string' || typeof parsed.description !== 'string') throw new Error('Fast task-draft AI returned an incomplete draft.');
  const normalizedTitle = fastTaskDraft(parsed.title).title;
  return { title: normalizedTitle, description: parsed.description.trim() || originalPrompt, projectName: null, workspacePath: null };
}

function dispatchNext(): void {
  if (!worker || active || queue.length === 0) return;
  active = queue.shift()!;
  worker.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: active.prompt }] } })}\n`);
}

function stopWorker(error: Error): void {
  worker?.kill('SIGTERM');
  worker = null;
  outputBuffer = '';
  if (active) { clearTimeout(active.timeout); active.reject(error); active = null; }
  while (queue.length) { const pending = queue.shift()!; clearTimeout(pending.timeout); pending.reject(error); }
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
        const pending = active; active = null; clearTimeout(pending.timeout);
        if (event.is_error || typeof event.result !== 'string') pending.reject(new Error('Fast task-draft AI failed.'));
        else {
          try { pending.resolve(parseDraft(event.result, pending.prompt)); }
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

export function generateFastAiTaskDraft(prompt: string): Promise<GeneratedTaskDraft> {
  ensureWorker();
  return new Promise((resolve, reject) => {
    const pending: Pending = {
      prompt, resolve, reject,
      timeout: setTimeout(() => {
        const error = new Error('Fast task-draft AI timed out.');
        if (active === pending) stopWorker(error);
        else { const index = queue.indexOf(pending); if (index >= 0) queue.splice(index, 1); reject(error); }
      }, 10_000),
    };
    pending.timeout.unref();
    queue.push(pending);
    dispatchNext();
  });
}

export function warmFastTaskDraftModel(): void {
  void generateFastAiTaskDraft('Write a task to verify the fast task-draft formatter is ready.').catch(() => undefined);
}
