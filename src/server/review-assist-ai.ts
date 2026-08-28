import { spawn } from 'node:child_process';

export type ReviewAssistAction = 'explain' | 'what_could_break' | 'compare_task_intent';

export type ReviewAssistDecision = {
  behavior: string;
  state: string;
  hunks: Array<{ filePath: string; location: string; lines: string[] }>;
};

export type ReviewAssistTaskIntent = { title: string; description: string } | null;

const SYSTEM_PROMPTS: Record<ReviewAssistAction, string> = {
  explain: 'You help a code reviewer understand one already-identified diff decision. Explain in plain English what this change does and why it plausibly exists. Be concise: at most six sentences. No preamble, no restating the diff back verbatim.',
  what_could_break: 'You help a code reviewer stress-test one already-identified diff decision. List the concrete, plausible ways this change could break something — edge cases, missed call sites, race conditions, silent behavior changes. Be concise: at most six bullet points, one line each. If nothing plausible comes to mind, say so directly instead of inventing risk.',
  compare_task_intent: 'You help a code reviewer judge whether one diff decision matches the task it was meant to accomplish. Compare the change against the stated task title and description, and say directly whether it looks aligned, partially aligned, or off-target, with a one-sentence reason. Be concise: at most six sentences.',
};

/** Runs entirely outside the shared diff-confidence worker pool: this is a
 * reviewer-initiated, single question fired on click, not an ambient batch
 * score, so it gets its own fresh subprocess per request rather than
 * competing with — or being throttled by — that pool's fixed worker count. */
export function requestReviewAssist(action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent): Promise<string> {
  const prompt = buildPrompt(action, decision, taskIntent);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
      '--no-session-persistence', '--no-chrome', '--system-prompt', SYSTEM_PROMPTS[action],
      '--output-format', 'json',
    ], { cwd: '/tmp', env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('AI review assist timed out after 30 seconds.'));
    }, 30_000);
    timeout.unref();

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`AI review assist failed: ${stderr.trim() || `exit code ${code}`}`)); return; }
      try {
        const envelope = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
        if (envelope.is_error || typeof envelope.result !== 'string' || !envelope.result.trim()) {
          reject(new Error('AI review assist returned no answer.'));
          return;
        }
        resolve(envelope.result.trim());
      } catch {
        reject(new Error('AI review assist returned an unreadable response.'));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildPrompt(action: ReviewAssistAction, decision: ReviewAssistDecision, taskIntent: ReviewAssistTaskIntent): string {
  const hunkText = decision.hunks.map((hunk) => `${hunk.filePath} (${hunk.location}):\n${hunk.lines.join('\n')}`).join('\n\n');
  const parts = [
    `Decision: ${decision.behavior}`,
    `Review state: ${decision.state}`,
    `Diff:\n${hunkText}`,
  ];
  if (action === 'compare_task_intent') {
    parts.push(taskIntent ? `Task title: ${taskIntent.title}\nTask description: ${taskIntent.description}` : 'No task is linked to this review; say so and note that alignment cannot be judged.');
  }
  return parts.join('\n\n');
}
