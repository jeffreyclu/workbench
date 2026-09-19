import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const mcpjam = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpjam.cmd' : 'mcpjam');
const suitePath = join(root, '.mcpjam', 'evals', 'workbench-agent-behavior.yaml');
const reportDirectory = join(root, 'data', 'mcpjam', 'evals');
const approvalFlag = '--approve-live-model-run';

export function buildEvalCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (!argv.includes(approvalFlag)) return ['cloud', 'eval', 'validate', '--file', suitePath];
  const project = env.MCPJAM_PROJECT?.trim();
  const model = env.MCPJAM_MODEL?.trim();
  if (!project) throw new Error('A live eval requires MCPJAM_PROJECT so Workbench data is never uploaded to an implicit project.');
  if (!model) throw new Error('A live eval requires MCPJAM_MODEL so the billed model is explicit for this run.');
  mkdirSync(reportDirectory, { recursive: true });
  return [
    'cloud', 'eval', 'run', '--file', suitePath, '--project', project,
    '--compose-model', model, '--iterations', '1', '--min-pass-rate', '100',
    '--wait', '--reporter', 'json-summary', '--out', join(reportDirectory, 'latest.json'),
    '--notes', 'Explicit one-run approval from Workbench operator.',
  ];
}

export function runMcpJamEvals(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(mcpjam)) throw new Error('MCPJam is not installed. Run npm install first.');
  if (!existsSync(suitePath)) throw new Error(`Missing behavioral eval suite: ${suitePath}`);
  const live = argv.includes(approvalFlag);
  const command = buildEvalCommand(argv, env);
  const result = spawnSync(mcpjam, ['--no-telemetry', ...command], {
    cwd: root,
    env: { ...env, MCPJAM_TELEMETRY_DISABLED: '1' },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`MCPJam ${live ? 'live eval' : 'eval validation'} failed with exit code ${result.status ?? 1}.`);
  if (!live) {
    console.log(`Behavioral eval suite is valid. No model was called. To run it once, set MCPJAM_PROJECT and MCPJAM_MODEL and add ${approvalFlag}.`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { runMcpJamEvals(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
