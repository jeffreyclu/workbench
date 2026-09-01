import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const guard = resolve('scripts/agent-bin/curl-command-guard.mjs');

function guardedCurlArgs(args: string[]): string[] {
  return JSON.parse(execFileSync(process.execPath, [guard, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WORKBENCH_CURL_GUARD_CHECK_ONLY: '1' },
  })) as string[];
}

describe('agent curl command policy', () => {
  it('caps an encoded multi-minute retry loop to one minute total', () => {
    expect(guardedCurlArgs(['--retry', '25', '--retry-all-errors', '--max-time', '90', 'http://localhost:8000/health']))
      .toEqual(['--connect-timeout', '10', '--retry', '2', '--retry-all-errors', '--max-time', '20', 'http://localhost:8000/health']);
  });

  it('adds bounded timeouts to an otherwise unbounded probe', () => {
    expect(guardedCurlArgs(['-sS', 'http://localhost:8000/health']))
      .toEqual(['--connect-timeout', '10', '--max-time', '20', '-sS', 'http://localhost:8000/health']);
  });
});
