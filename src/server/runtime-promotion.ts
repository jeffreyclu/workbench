import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const MAX_OUTPUT = 20_000;

export function isRuntimeApproval(message: string): boolean {
  return /^\s*(?:approve|publish|promote|deploy|ship)(?:\s+(?:the\s+)?)?(?:workbench\s+)?preview[.!]?\s*$/i.test(message);
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
      resolvePromotion('Preview approved and promoted. The live Workbench switched to the verified release without changing its URL.');
    });
  });
}
