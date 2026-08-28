import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const guard = fileURLToPath(new URL('../../scripts/writer-agent-bin/test-command-guard.mjs', import.meta.url));
const bin = (name: string) => fileURLToPath(new URL(`../../scripts/writer-agent-bin/${name}`, import.meta.url));
function check(name: string, ...args: string[]) {
  return spawnSync(process.execPath, [guard, bin(name), ...args], { encoding: 'utf8', env: { ...process.env, WORKBENCH_WRITER_TEST_GUARD_CHECK_ONLY: '1' } });
}

describe('Writer agent test command guard', () => {
  it.each([
    ['npm', ['test']], ['npm', ['run', 'test']], ['npm', ['--prefix', 'frontend', 'test']], ['pnpm', ['--filter', 'frontend', 'test:unit']], ['pnpm', ['test', '--', 'use-manage-connectors-view-model']], ['yarn', ['test']],
    ['vitest', ['run']], ['vitest', ['run', '--', 'use-manage-connectors-view-model']], ['jest', ['--runInBand']], ['npx', ['vitest', 'run', '--', 'use-manage-connectors-view-model']],
  ])('rejects full-suite invocation %s %j', (name, args) => {
    const result = check(name, ...args); expect(result.status).toBe(126); expect(result.stdout).toBe('denied\n');
  });
  it.each([
    ['vitest', ['run', 'src/components/feature.test.ts']], ['npm', ['test', '--', 'src/components/feature.test.ts']],
    ['pnpm', ['test', '--', 'src/components/feature.spec.tsx']], ['npx', ['vitest', 'run', 'src/components/feature.test.ts']], ['npx', ['vitest', '--version']], ['npm', ['run', 'build']],
  ])('allows a focused or non-test invocation %s %j', (name, args) => {
    const result = check(name, ...args); expect(result.status).toBe(0); expect(result.stdout).toBe('allowed\n');
  });
});
