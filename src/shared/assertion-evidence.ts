import { splitChangedLines } from './change-type.js';
import type { CoverageEvidence } from './coverage-evidence.js';

/** Whether the tests that cite a symbol actually constrain it.
 *
 * The coverage check answers "does any test in this review name this
 * declaration?", and that question has a known cheat. A test that imports the
 * new function, calls it and asserts `toBeDefined()` passes the name search
 * completely while proving nothing: it would still pass if the body were
 * replaced with `return {}`. Generated tests reach for exactly that shape,
 * because a test that cannot fail is the fastest way to satisfy a request for
 * tests.
 *
 * So this reads one level deeper, on the only question that separates a test
 * from a decoration: if the change under test were reverted, would this fail?
 * That is undecidable in general and cheap to approximate — an assertion whose
 * matcher accepts almost every value cannot distinguish the two versions, and
 * a test case with no assertion at all certainly cannot.
 *
 * It reports a weakness only when *every* assertion attached to a symbol is
 * weak. One vacuous line beside a real `toEqual` is ordinary test writing, and
 * flagging it would make the check noise. The finding is the symbol whose
 * entire evidence is vacuous, which is indistinguishable from having no test
 * while looking, in the queue, like it has one. */
export type WeakTestReason = 'no-assertion' | 'vacuous';

export interface WeakTestHunk {
  filePath: string;
  location: string;
  reason: WeakTestReason;
  /** The cited declarations this hunk was counted as evidence for. */
  symbols: string[];
}

export interface AssertionEvidence {
  /** Declarations whose every citing test hunk is weak. These read as covered
   * in the coverage check and are not. */
  unconstrainedSymbols: string[];
  hunks: WeakTestHunk[];
  /** The matchers that produced the verdict, so the finding names its own
   * evidence instead of asking for trust. */
  matchers: string[];
}

export const EMPTY_ASSERTION_EVIDENCE: AssertionEvidence = { unconstrainedSymbols: [], hunks: [], matchers: [] };

/** Matchers that accept nearly any value the code under test could return, so
 * passing one says the call did not throw and nothing more. `toHaveBeenCalled`
 * is here for the same reason: it proves a call happened, never with what. */
const VACUOUS_MATCHERS = new Set([
  'toBeDefined', 'toBeTruthy', 'toBeFalsy', 'toBeNull', 'toBeUndefined',
  'toBeInstanceOf', 'toHaveBeenCalled', 'toBeNaN', 'toBeTypeOf',
]);

/** Any matcher that pins a value, a shape, a count or a thrown error. Listed
 * as a pattern rather than a set because matcher vocabularies grow, and the
 * safe default when a matcher is unrecognised is to treat it as real — this
 * check may under-report, never accuse a good test. */
const MATCHER_PATTERN = /(?:^|[^\w$])\.?(to[A-Z][\w$]*|toBe|rejects|resolves)\s*\(/g;
const ASSERTION_PATTERN = /(?:^|[^\w$])(expect|assert)\s*(?:\.\w+)?\s*\(/;
const TEST_CASE_PATTERN = /(?:^|[^\w$])(?:it|test)(?:\.\w+)?\s*\(/;

/** Matchers named on a line, normalised off their leading dot. A negated
 * matcher — `not.toBeNull()` — is still the same weak assertion, so `not` is
 * transparent here. */
function matchersOn(lines: string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(MATCHER_PATTERN)) found.push(match[1]);
  }
  return found;
}

/** Judges one test hunk's added lines. Returns null when the hunk carries at
 * least one assertion that could fail on a wrong value, which is the passing
 * case and by far the common one. */
function weaknessOf(lines: string[]): { reason: WeakTestReason; matchers: string[] } | null {
  const added = splitChangedLines(lines).added;
  const matchers = matchersOn(added);
  const hasAssertion = added.some((line) => ASSERTION_PATTERN.test(line));
  if (!hasAssertion && matchers.length === 0) {
    // A hunk of pure setup inside a larger passing test file is normal; only
    // a hunk that introduces test cases is expected to assert something.
    return added.some((line) => TEST_CASE_PATTERN.test(line)) ? { reason: 'no-assertion', matchers: [] } : null;
  }
  if (matchers.length === 0) return null;
  const substantive = matchers.filter((matcher) => !VACUOUS_MATCHERS.has(matcher));
  if (substantive.length > 0) return null;
  return { reason: 'vacuous', matchers: [...new Set(matchers)].sort() };
}

/** Reads the coverage pack a second time, asking what the tests prove rather
 * than whether they exist.
 *
 * A symbol is reported only when every hunk citing it came back weak. Symbols
 * with no citing hunk at all are already the coverage check's finding and are
 * deliberately not repeated here. */
export function buildAssertionEvidence(coverage: CoverageEvidence): AssertionEvidence {
  if (coverage.hunks.length === 0) return EMPTY_ASSERTION_EVIDENCE;

  const weakHunks: WeakTestHunk[] = [];
  const matchers = new Set<string>();
  const citedBySymbol = new Map<string, { total: number; weak: number }>();

  for (const hunk of coverage.hunks) {
    const weakness = weaknessOf(hunk.lines);
    for (const symbol of hunk.symbols) {
      const tally = citedBySymbol.get(symbol) ?? { total: 0, weak: 0 };
      tally.total += 1;
      if (weakness) tally.weak += 1;
      citedBySymbol.set(symbol, tally);
    }
    if (!weakness) continue;
    for (const matcher of weakness.matchers) matchers.add(matcher);
    weakHunks.push({ filePath: hunk.filePath, location: hunk.location, reason: weakness.reason, symbols: hunk.symbols });
  }

  const unconstrainedSymbols = [...citedBySymbol]
    .filter(([, tally]) => tally.total > 0 && tally.total === tally.weak)
    .map(([symbol]) => symbol)
    .sort();

  return { unconstrainedSymbols, hunks: weakHunks, matchers: [...matchers].sort() };
}
