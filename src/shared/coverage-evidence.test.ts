import { describe, expect, it } from 'vitest';
import { auditCitations, auditReferenceClaims, buildCoverageEvidence, buildReferenceEvidence, citationAuditNote, newDeclarations, parseCitations, referenceClaimNote, removedDeclarations, type EvidenceHunk, type ReferenceEvidence } from './coverage-evidence.js';

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

describe('removedDeclarations', () => {
  it('names what a decision deletes', () => {
    expect(removedDeclarations([hunk('src/retry.ts', 'Lines 10-12', [
      '-export function retry(times: number) {',
      '-  return times;',
      '-}',
    ])])).toEqual(['retry']);
  });

  it('does not report a signature edit as a removal', () => {
    expect(removedDeclarations([hunk('src/retry.ts', 'Lines 10-11', [
      '-export function retry(times: number) {',
      '+export function retry(times: number, delay: number) {',
    ])])).toEqual([]);
  });

  it('counts a deleted test helper, which another test may still call', () => {
    expect(removedDeclarations([hunk('src/retry.test.ts', 'Lines 1-1', [
      '-export function makeFixture() {}',
    ])])).toEqual(['makeFixture']);
  });
});

describe('buildReferenceEvidence', () => {
  const target = [hunk('src/retry.ts', 'Lines 10-13', [
    '-export function retry(times: number) {',
    '-  return times;',
    '-}',
  ])];

  it('reports a call site that survives the deletion as residual', () => {
    const evidence = buildReferenceEvidence(target, [
      hunk('src/worker.ts', 'Lines 40-41', ['+  return retry(3);']),
    ]);
    expect(evidence.residualSymbols).toEqual(['retry']);
    expect(evidence.clearedSymbols).toEqual([]);
    expect(evidence.hunks[0].kind).toBe('residual');
  });

  it('treats an untouched context line as a surviving reference', () => {
    const evidence = buildReferenceEvidence(target, [
      hunk('src/worker.ts', 'Lines 40-42', ['   return retry(3);', '+  const other = 1;']),
    ]);
    expect(evidence.residualSymbols).toEqual(['retry']);
  });

  it('reports a call site removed alongside it as updated, not residual', () => {
    const evidence = buildReferenceEvidence(target, [
      hunk('src/worker.ts', 'Lines 40-41', ['-  return retry(3);']),
    ]);
    expect(evidence.residualSymbols).toEqual([]);
    expect(evidence.clearedSymbols).toEqual(['retry']);
    expect(evidence.hunks[0].kind).toBe('updated');
  });

  it('reports a hunk that both keeps and drops a reference as residual', () => {
    const evidence = buildReferenceEvidence(target, [
      hunk('src/worker.ts', 'Lines 40-42', ['-  return retry(3);', '+  return retry(4);']),
    ]);
    expect(evidence.hunks[0].kind).toBe('residual');
    expect(evidence.residualSymbols).toEqual(['retry']);
  });

  it('clears a symbol only after scanning every sibling, not just the kept ones', () => {
    const filler = Array.from({ length: 5 }, (_, index) => hunk(`src/filler${index}.ts`, 'Lines 1-1', ['-  retry(1);']));
    const evidence = buildReferenceEvidence(target, [
      ...filler,
      hunk('src/zzz-late.ts', 'Lines 1-1', ['+  retry(9);']),
    ]);
    expect(evidence.residualSymbols).toEqual(['retry']);
    expect(evidence.hunks.length).toBeLessThanOrEqual(3);
    expect(evidence.hunks[0].kind).toBe('residual');
  });

  it('ignores the decision own hunks and returns nothing when it removes no declaration', () => {
    expect(buildReferenceEvidence(target, target).hunks).toEqual([]);
    expect(buildReferenceEvidence([hunk('src/retry.ts', 'Lines 1-1', ['+const local = 1;'])], []).symbols).toEqual([]);
  });
});

describe('auditReferenceClaims', () => {
  const cleared: ReferenceEvidence = { symbols: ['legacyParse'], hunks: [], residualSymbols: [], clearedSymbols: ['legacyParse'] };
  const residual: ReferenceEvidence = {
    symbols: ['legacyParse'],
    hunks: [{ filePath: 'src/importer.ts', location: 'Lines 20-21', lines: ['   return legacyParse(raw);'], symbols: ['legacyParse'], kind: 'residual' }],
    residualSymbols: ['legacyParse'],
    clearedSymbols: [],
  };

  it('catches an all-clear about callers when the review still holds a surviving reference', () => {
    const audit = auditReferenceClaims('All call sites are updated to the new helper.', residual);
    expect(audit.contradicted).toEqual(['All call sites are updated to the new helper.']);
    const note = referenceClaimNote(audit, residual);
    expect(note).toContain('still references legacyParse on a surviving line');
    expect(note).toContain('All call sites are updated');
  });

  it('marks an all-clear unverified when no supplied hunk could have established it', () => {
    const audit = auditReferenceClaims('The callers were updated in the same commit.', cleared);
    expect(audit.uncited).toHaveLength(1);
    expect(referenceClaimNote(audit, cleared)).toContain('cite no supplied hunk and remain unverified');
  });

  it('accepts an all-clear that points at the hunk proving it', () => {
    const updated: ReferenceEvidence = {
      symbols: ['legacyParse'],
      hunks: [{ filePath: 'src/importer.ts', location: 'Lines 20-21', lines: ['-  return legacyParse(raw);'], symbols: ['legacyParse'], kind: 'updated' }],
      residualSymbols: [],
      clearedSymbols: ['legacyParse'],
    };
    const audit = auditReferenceClaims('The call site is updated [src/importer.ts:20].', updated);
    expect(audit.uncited).toEqual([]);
    expect(referenceClaimNote(audit, updated)).toBeNull();
  });

  // The point of the whole layer is to make the honest answer the cheap one. If
  // a correctly hedged sentence still drew a warning, the note would be noise
  // and reviewers would learn to skip it.
  it('leaves a properly hedged sentence alone', () => {
    expect(auditReferenceClaims('Call sites outside this review are unverified and should be checked.', cleared).uncited).toEqual([]);
    expect(auditReferenceClaims('Callers may not be updated; that is not visible here.', cleared).uncited).toEqual([]);
  });

  it('does not gate a claim that something is still broken, which sends the reviewer to look anyway', () => {
    const audit = auditReferenceClaims('src/importer.ts still calls legacyParse and will fail to compile.', residual);
    expect(audit.contradicted).toEqual([]);
    expect(audit.uncited).toEqual([]);
  });

  it('audits each bullet on its own, so one hedge does not excuse an all-clear elsewhere', () => {
    const audit = auditReferenceClaims('- Callers outside the review are unverified.\n- All references were updated.', cleared);
    expect(audit.uncited).toEqual(['- All references were updated.']);
  });
});
