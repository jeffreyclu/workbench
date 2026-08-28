#!/usr/bin/env node
/** Runtime boundary for Writer agent test commands. */
import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

const guardDirectory = resolve(dirname(process.argv[1]));
const invokedAs = basename(process.argv[2] || '');
const args = process.argv.slice(3);
const filePattern = /(?:^|\/)[^\s/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function hasExplicitTestFile(values) { return values.some((value) => filePattern.test(value)); }
function packageRunsTests(command, values) {
  if (!['npm', 'pnpm', 'yarn'].includes(command)) return false;
  return values.some((value) => value === 'test' || value.startsWith('test:'));
}
function npxRunsTests(values) {
  return values.some((value) => value === 'vitest' || value === 'jest');
}
function isTestInvocation(command, values) {
  return command === 'vitest' || command === 'jest' || packageRunsTests(command, values) || (command === 'npx' && npxRunsTests(values));
}
function isInformational(values) { return values.includes('--help') || values.includes('-h') || values.includes('--version') || values.includes('-v'); }
function denied(command, values) { return isTestInvocation(command, values) && !isInformational(values) && !hasExplicitTestFile(values); }

if (process.env.WORKBENCH_WRITER_TEST_GUARD_CHECK_ONLY === '1') {
  process.stdout.write(denied(invokedAs, args) ? 'denied\n' : 'allowed\n');
  process.exit(denied(invokedAs, args) ? 126 : 0);
}
if (denied(invokedAs, args)) {
  process.stderr.write(`Workbench blocked a full Writer test-suite command: ${invokedAs} ${args.join(' ')}\nRun one directly relevant test file (for example: vitest run src/path/feature.test.ts).\n`);
  process.exit(126);
}

const inheritedPath = (process.env.PATH || '').split(':').filter((entry) => resolve(entry || '.') !== guardDirectory).join(':');
const child = spawn(invokedAs, args, { stdio: 'inherit', env: { ...process.env, PATH: inheritedPath } });
child.on('error', (error) => { process.stderr.write(`${error.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
