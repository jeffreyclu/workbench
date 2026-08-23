import { spawn } from 'node:child_process';

/**
 * Providers Workbench can authorize by driving Codex's own OAuth. Codex runs a
 * loopback callback on 127.0.0.1, so this path never needs a public tunnel —
 * the reason it survives the ngrok domain block that killed Workbench's own
 * remote-MCP broker.
 */
export type ManagedMcpProvider = 'figma' | 'atlassian';

export function startManagedMcpLogin(provider: ManagedMcpProvider): Promise<{ url: string; completion: Promise<void> }> {
  const command = process.env.CODEX_BIN?.trim() || 'codex';
  const child = spawn(command, ['mcp', 'login', provider], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  return new Promise((resolve, reject) => {
    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(/https:\/\/\S+/);
      if (match && !settled) { settled = true; resolve({ url: match[0], completion }); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => {
      rejectCompletion(error);
      if (!settled) { settled = true; reject(error); }
    });
    child.once('exit', (code) => {
      if (code === 0) resolveCompletion();
      else rejectCompletion(new Error(output.trim() || `Codex MCP login exited with code ${code}.`));
      if (!settled) { settled = true; reject(new Error(output.trim() || 'Codex MCP login did not provide an authorization URL.')); }
    });
    setTimeout(() => {
      if (!settled) { settled = true; child.kill('SIGTERM'); reject(new Error('Timed out starting Codex MCP authorization.')); }
    }, 15_000).unref();
  });
}
