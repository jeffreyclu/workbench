import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertUsableRuntimeRelease, publishRuntimeRelease } from './runtime-release.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-runtime-release-'));
  roots.push(root);
  mkdirSync(join(root, 'dist/client/assets'), { recursive: true });
  mkdirSync(join(root, 'src/server'), { recursive: true });
  mkdirSync(join(root, 'src/shared'), { recursive: true });
  writeFileSync(join(root, 'dist/client/index.html'), '<html><script src="/assets/app.js"></script></html>');
  writeFileSync(join(root, 'dist/client/assets/app.js'), 'export {};');
  writeFileSync(join(root, 'src/server/index.ts'), 'export {};');
  return root;
}

describe('runtime release publishing', () => {
  it('validates the staged release before atomically changing current', () => {
    const root = fixture();
    const releasePath = publishRuntimeRelease(root, 'release-a', 'fingerprint');
    assertUsableRuntimeRelease(releasePath);
    expect(readlinkSync(join(root, '.workbench-runtime/current'))).toContain('release-a');
  });

  it('rejects a client whose HTML references a missing emitted asset', () => {
    const root = fixture();
    writeFileSync(join(root, 'dist/client/index.html'), '<html><script src="/assets/missing.js"></script></html>');
    expect(() => publishRuntimeRelease(root, 'broken', 'fingerprint')).toThrow(/assets are incomplete/);
  });
});
