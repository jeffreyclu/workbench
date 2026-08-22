import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimePreviewStatus, runtimeSourceFingerprint } from './runtime-preview.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workbench-preview-'));
  roots.push(root);
  mkdirSync(join(root, 'src/client'), { recursive: true });
  writeFileSync(join(root, 'src/client/App.tsx'), 'export const App = 1;');
  writeFileSync(join(root, 'src/client/App.test.tsx'), 'test("ignored", () => {});');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'index.html'), '<main>preview</main>');
  return root;
}

describe('runtime preview status', () => {
  it('changes only when runtime source changes', () => {
    const root = fixture();
    const initial = runtimeSourceFingerprint(root);
    writeFileSync(join(root, 'src/client/App.test.tsx'), 'test("still ignored", () => {});');
    expect(runtimeSourceFingerprint(root)).toBe(initial);
    writeFileSync(join(root, 'src/client/App.tsx'), 'export const App = 2;');
    expect(runtimeSourceFingerprint(root)).not.toBe(initial);
  });

  it('compares source with the promoted release manifest', () => {
    const root = fixture();
    const manifestDirectory = join(root, '.workbench-runtime/current');
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(join(manifestDirectory, 'source-manifest.json'), JSON.stringify({ fingerprint: runtimeSourceFingerprint(root), createdAt: '2026-08-20T00:00:00.000Z' }));
    expect(runtimePreviewStatus(root)).toMatchObject({ pending: false, promotedAt: '2026-08-20T00:00:00.000Z' });
    writeFileSync(join(root, 'src/client/App.tsx'), `${readFileSync(join(root, 'src/client/App.tsx'), 'utf8')}\n// changed`);
    expect(runtimePreviewStatus(root).pending).toBe(true);
  });

  it('includes deployable root inputs such as index.html in the fingerprint', () => {
    const root = fixture();
    const initial = runtimeSourceFingerprint(root);
    writeFileSync(join(root, 'index.html'), '<main>changed deployment input</main>');
    expect(runtimeSourceFingerprint(root)).not.toBe(initial);
  });
});
