import { describe, expect, it } from 'vitest';
import { buildExternalSurfaceEvidence } from './external-surface.js';

const hunk = (lines: string[], filePath = 'src/a.ts') => ({ filePath, location: '@@ -1 +1 @@', lines });

describe('buildExternalSurfaceEvidence', () => {
  it('reports a newly imported package and the symbols taken from it', () => {
    const evidence = buildExternalSurfaceEvidence([hunk(["+import { retry, backoff } from 'resilient';"])]);
    expect(evidence.imports).toEqual([{ module: 'resilient', symbols: ['backoff', 'retry'] }]);
    expect(evidence.claims[0]).toBe('`backoff`, `retry` from `resilient`');
  });

  it('ignores relative imports, which resolve to reviewable files', () => {
    const evidence = buildExternalSurfaceEvidence([hunk(["+import { helper } from './helper.js';"])]);
    expect(evidence.imports).toEqual([]);
    expect(evidence.claims).toEqual([]);
  });

  it('does not report an import the patch only moved', () => {
    const evidence = buildExternalSurfaceEvidence([hunk([
      "-import { readFile } from 'fs-extra';",
      "+import { readFile } from 'fs-extra';",
    ])]);
    expect(evidence.imports).toEqual([]);
  });

  it('reports one new symbol widened onto an import that already existed', () => {
    const evidence = buildExternalSurfaceEvidence([hunk([
      "-import { readFile } from 'fs-extra';",
      "+import { readFile, writeJson } from 'fs-extra';",
    ])]);
    expect(evidence.imports).toEqual([{ module: 'fs-extra', symbols: ['writeJson'] }]);
  });

  it('resolves an alias to the name actually taken from the module', () => {
    const evidence = buildExternalSurfaceEvidence([hunk(["+import { readFile as read } from 'fs-extra';"])]);
    expect(evidence.imports[0].symbols).toEqual(['readFile']);
  });

  it('reports environment keys the patch starts reading', () => {
    const evidence = buildExternalSurfaceEvidence([hunk([
      '+const key = process.env.STRIPE_KEY;',
      "+const mode = import.meta.env['MODE'];",
    ])]);
    expect(evidence.envKeys).toEqual(['MODE', 'STRIPE_KEY']);
  });

  it('does not read package names out of non-code files', () => {
    const evidence = buildExternalSurfaceEvidence([hunk(['+  "resilient": "^1.0.0"'], 'package.json')]);
    expect(evidence.claims).toEqual([]);
  });

  it('reports a bare side-effect import of a package that is new', () => {
    const evidence = buildExternalSurfaceEvidence([hunk(["+import 'polyfill-lib';"])]);
    expect(evidence.imports).toEqual([{ module: 'polyfill-lib', symbols: [] }]);
  });
});
