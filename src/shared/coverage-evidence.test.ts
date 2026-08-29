import { describe, expect, it } from 'vitest';
import { auditCitations, buildCoverageEvidence, citationAuditNote, newDeclarations, parseCitations, type EvidenceHunk } from './coverage-evidence.js';

function hunk(filePath: string, location: string, lines: string[]): EvidenceHunk {
  return { filePath, location, lines };
}

describe('newDeclarations', () => {
  it('names what a decision adds in production code', () => {
    expect(newDeclarations([hunk('src/retry.ts', 'Lines 1-3', [
      '+export function retry(times: number) {',
      '+  return times;',
      '+}',
    ])])).toEqual(['retry']);
  });

  it('ignores helpers declared inside a test file, which are never the subject under test', () => {
    expect(newDeclarations([hunk('src/retry.test.ts', 'Lines 1-2', [
      '+export function makeFixture() {}',
    ])])).toEqual([]);
  });
});

describe('buildCoverageEvidence', () => {
  const target = [hunk('src/retry.ts', 'Lines 10-14', [
    '+export function retry(times: number) {',
    '+  if (times < 1) throw new Error("bad");',
    '+  return times;',
    '+}',
  ])];

  it('pairs a new declaration with the test hunk that names it, even though it is a different decision', () => {
    const evidence = buildCoverageEvidence(target, [
      hunk('src/retry.test.ts', 'Lines 1-4', ['+it("throws", () => {', '+  expect(() => retry(0)).toThrow();', '+});']),
    ]);
    expect(evidence.symbols).toEqual(['retry']);
    expect(evidence.hunks).toHaveLength(1);
    expect(evidence.hunks[0]).toMatchObject({ filePath: 'src/retry.test.ts', symbols: ['retry'] });
    expect(evidence.uncitedSymbols).toEqual([]);
  });

  it('offers only test hunks: production code that calls the symbol is not coverage', () => {
    const evidence = buildCoverageEvidence(target, [
      hunk('src/caller.ts', 'Lines 1-2', ['+retry(3);']),
    ]);
    expect(evidence.hunks).toEqual([]);
    expect(evidence.uncitedSymbols).toEqual(['retry']);
  });

  it('does not match a symbol inside a longer identifier', () => {
    const evidence = buildCoverageEvidence(target, [
      hunk('src/other.test.ts', 'Lines 1-2', ['+expect(retryForever(1)).toBe(1);']),
    ]);
    expect(evidence.hunks).toEqual([]);
    expect(evidence.uncitedSymbols).toEqual(['retry']);
  });

  it('reports nothing to prove when the decision declares nothing new', () => {
    const evidence = buildCoverageEvidence([hunk('src/retry.ts', 'Lines 4-5', ['+  return times + 1;'])], [
      hunk('src/retry.test.ts', 'Lines 1-2', ['+expect(retry(1)).toBe(2);']),
    ]);
    expect(evidence).toEqual({ symbols: [], hunks: [], uncitedSymbols: [] });
  });

  it('excludes the decision’s own hunks from its evidence', () => {
    const own = hunk('src/retry.test.ts', 'Lines 1-2', ['+export function retryHarness() {}', '+expect(retry(1)).toBe(1);']);
    const evidence = buildCoverageEvidence([...target, own], [own]);
    expect(evidence.hunks).toEqual([]);
  });

  it('caps how many test hunks ride along, keeping the ones that prove the most', () => {
    const wide = [hunk('src/many.ts', 'Lines 1-5', [
      '+export function alpha() {}',
      '+export function beta() {}',
    ])];
    const siblings = [
      hunk('src/a.test.ts', 'Lines 1-2', ['+alpha();']),
      hunk('src/b.test.ts', 'Lines 1-2', ['+alpha();']),
      hunk('src/c.test.ts', 'Lines 1-2', ['+alpha();']),
      hunk('src/d.test.ts', 'Lines 1-2', ['+alpha();']),
      hunk('src/e.test.ts', 'Lines 1-3', ['+alpha();', '+beta();']),
    ];
    const evidence = buildCoverageEvidence(wide, siblings);
    expect(evidence.hunks).toHaveLength(4);
    expect(evidence.hunks[0].filePath).toBe('src/e.test.ts');
    // beta's only witness survived the cap here, but the guarantee under test is
    // that coverage is judged over every sibling scanned, not the kept subset.
    expect(evidence.uncitedSymbols).toEqual([]);
  });

  it('counts a symbol as covered even when its only witness lost the cap contest', () => {
    const wide = [hunk('src/many.ts', 'Lines 1-9', [
      '+export function alpha() {}',
      '+export function beta() {}',
      '+export function gamma() {}',
    ])];
    const siblings = [
      hunk('src/a.test.ts', 'Lines 1-2', ['+alpha(); beta(); gamma();']),
      hunk('src/b.test.ts', 'Lines 1-2', ['+alpha(); beta();']),
      hunk('src/c.test.ts', 'Lines 1-2', ['+alpha(); beta();']),
      hunk('src/d.test.ts', 'Lines 1-2', ['+alpha(); beta();']),
      hunk('src/e.test.ts', 'Lines 1-2', ['+gamma();']),
      hunk('src/f.test.ts', 'Lines 1-2', ['+gamma();']),
    ];
    const evidence = buildCoverageEvidence(wide, siblings);
    expect(evidence.hunks).toHaveLength(4);
    expect(evidence.uncitedSymbols).toEqual([]);
  });
});

describe('parseCitations', () => {
  it('reads single lines and ranges, and reports each distinct citation once', () => {
    const citations = parseCitations('see [src/a.ts:12] and [src/b.ts:4-9] and again [src/a.ts:12]');
    expect(citations).toEqual([
      { filePath: 'src/a.ts', startLine: 12, endLine: 12, raw: '[src/a.ts:12]' },
      { filePath: 'src/b.ts', startLine: 4, endLine: 9, raw: '[src/b.ts:4-9]' },
    ]);
  });
});

describe('auditCitations', () => {
  const supplied = [
    hunk('src/retry.ts', 'Lines 10–14', ['+export function retry() {}']),
    hunk('src/retry.test.ts', 'Line 3', ['+expect(retry()).toBe(1);']),
  ];

  it('accepts a citation that lands inside a supplied hunk', () => {
    expect(auditCitations('logic [src/retry.ts:11] <- test [src/retry.test.ts:3]', supplied).unresolved).toEqual([]);
  });

  it('flags a real file cited at a line nobody was shown', () => {
    const audit = auditCitations('see [src/retry.ts:400]', supplied);
    expect(audit.unresolved.map((citation) => citation.raw)).toEqual(['[src/retry.ts:400]']);
  });

  it('flags a file that was never supplied at all', () => {
    expect(auditCitations('see [src/ghost.ts:11]', supplied).unresolved).toHaveLength(1);
  });

  it('accepts a shortened path only when it names exactly one supplied file', () => {
    expect(auditCitations('see [retry.test.ts:3]', supplied).unresolved).toEqual([]);
    const ambiguous = [...supplied, hunk('src/nested/retry.test.ts', 'Line 3', ['+ok();'])];
    expect(auditCitations('see [retry.test.ts:3]', ambiguous).unresolved).toHaveLength(1);
  });

  it('resolves against a raw hunk header when the location was never rendered', () => {
    const raw = [hunk('src/retry.ts', '@@ -1,2 +40,6 @@', ['+ok();'])];
    expect(auditCitations('see [src/retry.ts:43]', raw).unresolved).toEqual([]);
    expect(auditCitations('see [src/retry.ts:60]', raw).unresolved).toHaveLength(1);
  });
});

describe('citationAuditNote', () => {
  it('says nothing when the answer cited nothing', () => {
    expect(citationAuditNote({ citations: [], unresolved: [] })).toBeNull();
  });

  it('confirms a clean answer and names the fabricated citations otherwise', () => {
    const supplied = [hunk('src/a.ts', 'Lines 1–5', ['+ok();'])];
    expect(citationAuditNote(auditCitations('[src/a.ts:2]', supplied))).toBe('Citation check: 1 citation resolved to supplied hunks.');
    expect(citationAuditNote(auditCitations('[src/a.ts:2] [src/a.ts:900]', supplied)))
      .toBe('Citation check: 1 of 2 citations do not match any supplied hunk and are unverified — [src/a.ts:900].');
  });
});
