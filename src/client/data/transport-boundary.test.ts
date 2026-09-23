import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function productionClientFiles(): string[] {
  return execFileSync('rg', ['--files', 'src/client', '-g', '*.ts', '-g', '*.tsx', '-g', '!**/*.test.*', '-g', '!src/client/test/**'], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

describe('browser transport boundary', () => {
  it('keeps every production application operation on the WebSocket', () => {
    const violations: string[] = [];
    for (const file of productionClientFiles()) {
      const source = readFileSync(resolve(file), 'utf8');
      for (const pattern of [
        { name: 'fetch', regex: /\bfetch\s*\(/ },
        { name: 'XMLHttpRequest', regex: /\bXMLHttpRequest\b/ },
        { name: 'EventSource', regex: /\bEventSource\b/ },
        { name: 'sendBeacon', regex: /\bsendBeacon\s*\(/ },
        { name: 'direct API link/media URL', regex: /(?:href|src)\s*=\s*(?:\{|)[`'"][^\n]*\/api\// },
      ]) if (pattern.regex.test(source)) violations.push(`${file}: ${pattern.name}`);
    }
    expect(violations).toEqual([]);
  });

  it('allows the HTTP-shaped Vitest adapter only in test setup', () => {
    const references = execFileSync('rg', ['-l', 'setApplicationRequestTestAdapter', 'src/client'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((file) => Boolean(file) && !file.endsWith('.test.ts'))
      .sort();
    expect(references).toEqual([
      'src/client/data/request.ts',
      'src/client/test/socket-request-adapter.ts',
    ]);
  });
});
