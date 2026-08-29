import { describe, expect, it } from 'vitest';
import { buildAssertionEvidence } from './assertion-evidence.js';
import type { CoverageEvidence } from './coverage-evidence.js';

const coverage = (lines: string[], symbols = ['loadConfig']): CoverageEvidence => ({
  symbols,
  uncitedSymbols: [],
  hunks: [{ filePath: 'src/a.test.ts', location: '@@ -1 +1 @@', lines, symbols }],
});

describe('buildAssertionEvidence', () => {
  it('flags a symbol whose only test asserts existence', () => {
    const evidence = buildAssertionEvidence(coverage([
      "+it('loads config', () => {",
      '+  expect(loadConfig()).toBeDefined();',
      '+});',
    ]));
    expect(evidence.unconstrainedSymbols).toEqual(['loadConfig']);
    expect(evidence.matchers).toEqual(['toBeDefined']);
    expect(evidence.hunks[0].reason).toBe('vacuous');
  });

  it('accepts a test that pins a value', () => {
    const evidence = buildAssertionEvidence(coverage([
      "+it('loads config', () => {",
      "+  expect(loadConfig()).toEqual({ port: 80 });",
      '+});',
    ]));
    expect(evidence.unconstrainedSymbols).toEqual([]);
  });

  it('accepts a vacuous assertion sitting beside a real one', () => {
    const evidence = buildAssertionEvidence(coverage([
      '+  expect(loadConfig()).toBeDefined();',
      "+  expect(loadConfig().port).toBe(80);",
    ]));
    expect(evidence.unconstrainedSymbols).toEqual([]);
  });

  it('flags a new test case that asserts nothing at all', () => {
    const evidence = buildAssertionEvidence(coverage([
      "+it('loads config', () => {",
      '+  loadConfig();',
      '+});',
    ]));
    expect(evidence.hunks[0].reason).toBe('no-assertion');
    expect(evidence.unconstrainedSymbols).toEqual(['loadConfig']);
  });

  it('ignores a setup-only hunk that introduces no test case', () => {
    const evidence = buildAssertionEvidence(coverage(['+  const fixture = loadConfig;']));
    expect(evidence.hunks).toEqual([]);
    expect(evidence.unconstrainedSymbols).toEqual([]);
  });

  it('treats a negated existence matcher as vacuous', () => {
    const evidence = buildAssertionEvidence(coverage([
      "+it('loads', () => { expect(loadConfig()).not.toBeNull(); });",
    ]));
    expect(evidence.unconstrainedSymbols).toEqual(['loadConfig']);
  });

  it('clears a symbol when one of its two citing hunks asserts properly', () => {
    const evidence = buildAssertionEvidence({
      symbols: ['loadConfig'],
      uncitedSymbols: [],
      hunks: [
        { filePath: 'a.test.ts', location: '1', lines: ['+expect(loadConfig()).toBeDefined();'], symbols: ['loadConfig'] },
        { filePath: 'b.test.ts', location: '2', lines: ['+expect(loadConfig().port).toBe(80);'], symbols: ['loadConfig'] },
      ],
    });
    expect(evidence.unconstrainedSymbols).toEqual([]);
  });

  it('returns nothing when no test cites the change', () => {
    const evidence = buildAssertionEvidence({ symbols: ['loadConfig'], uncitedSymbols: ['loadConfig'], hunks: [] });
    expect(evidence.unconstrainedSymbols).toEqual([]);
  });
});
