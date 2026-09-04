import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const MAX_OUTPUT = 20_000;

export function promotionMustWaitForAgents(status: { ownedAgentWorkActive?: unknown; liveAgentProcessCount?: unknown }): boolean {
  return status.ownedAgentWorkActive === true
    || (typeof status.liveAgentProcessCount === 'number' && status.liveAgentProcessCount > 0);
}

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

/** A runtime may only be promoted from a committed, pushed `main`. This makes
 * the deployed release reproducible and prevents feature branches from
 * becoming an accidental deployment channel. */
async function commitAndPushMain(root: string, onProgress: (body: string) => void): Promise<void> {
  const branch = await runGit(['branch', '--show-current'], root);
  if (branch.code !== 0 || branch.output.trim() !== 'main') {
    throw new Error(`Promotion requires the main branch. Current branch: ${branch.output.trim() || 'unknown'}.`);
  }
  const status = await runGit(['status', '--porcelain'], root);
  if (status.code !== 0) {
    throw new Error(`Promotion requires a clean Git status check.\n\n${status.output.trim()}`);
  }
  if (status.output.trim()) {
    const add = await runGit(['add', '-A'], root);
    if (add.code !== 0) throw new Error(`Promotion could not stage main.\n\n${add.output.trim()}`);
    const commit = await runGit(['commit', '-m', 'chore: commit before runtime promotion'], root);
    if (commit.code !== 0) throw new Error(`Promotion could not commit main.\n\n${commit.output.trim()}`);
  }
  const push = await runGit(['push', 'origin', 'main'], root);
  if (push.code !== 0) {
    throw new Error(`Promotion requires main to be pushed successfully.\n\n${push.output.trim()}`);
  }
  onProgress('Committed and pushed main; building the verified release…');
}

export async function promoteRuntime(
  signal: AbortSignal,
  onProgress: (body: string) => void,
): Promise<string> {
  const root = process.cwd();
  await commitAndPushMain(root, onProgress);
  onProgress('Building and verifying the approved Workbench preview…');
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
      resolvePromotion('Preview approved and promoted. The live Workbench switched to the verified release without changing its URL.');
    });
  });
}
