import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const MAX_OUTPUT = 20_000;

export function isRuntimeApproval(message: string): boolean {
  return /^\s*(?:approve|publish|promote|deploy|ship)(?:\s+(?:the\s+)?)?(?:workbench\s+)?preview[.!]?\s*$/i.test(message);
}

function runGit(args: string[], root: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveGit) => {
    const child = spawn('git', args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => {
      output = `${output}${chunk}`.slice(-MAX_OUTPUT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => resolveGit({ code: 1, output: String(error) }));
    child.on('exit', (code) => resolveGit({ code, output }));
  });
}

/**
 * Commits and pushes the working tree after a promotion, in the background.
 * Failures are logged via onProgress but never fail the promotion itself —
 * the runtime has already switched by the time this runs.
 */
async function commitAndPushAfterPromotion(root: string, onProgress: (body: string) => void): Promise<void> {
  const status = await runGit(['status', '--porcelain'], root);
  if (status.code !== 0) {
    onProgress(`Skipped auto-commit after promotion: git status failed.\n\n${status.output.trim()}`);
    return;
  }
  if (!status.output.trim()) return;
  const add = await runGit(['add', '-A'], root);
  if (add.code !== 0) {
    onProgress(`Skipped auto-commit after promotion: git add failed.\n\n${add.output.trim()}`);
    return;
  }
  const commit = await runGit(['commit', '-m', 'chore: auto-commit after runtime promotion'], root);
  if (commit.code !== 0) {
    onProgress(`Skipped auto-commit after promotion: git commit failed.\n\n${commit.output.trim()}`);
    return;
  }
  const push = await runGit(['push'], root);
  if (push.code !== 0) {
    onProgress(`Auto-committed after promotion but push failed.\n\n${push.output.trim()}`);
    return;
  }
  onProgress('Auto-committed and pushed the working tree after promotion.');
}

export async function promoteRuntime(
  signal: AbortSignal,
  onProgress: (body: string) => void,
): Promise<string> {
  onProgress('Building and verifying the approved Workbench preview…');
  const root = process.cwd();
  const command = join(root, 'node_modules/.bin/tsx');
  const script = resolve(root, 'scripts/promote-runtime.ts');
  return new Promise((resolvePromotion, reject) => {
    const child = spawn(command, [script], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => {
      output = `${output}${chunk}`.slice(-MAX_OUTPUT);
      const meaningful = output.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
      if (meaningful) onProgress(`Building and verifying the approved Workbench preview…\n\n${meaningful}`);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const abort = () => child.kill('SIGTERM');
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(new Error('Preview approval canceled.'));
      if (code !== 0) return reject(new Error(`Preview promotion failed.\n\n${output.trim() || `Process exited with code ${code}.`}`));
      void commitAndPushAfterPromotion(root, onProgress);
      resolvePromotion('Preview approved and promoted. The live Workbench switched to the verified release without changing its URL.');
    });
  });
}
