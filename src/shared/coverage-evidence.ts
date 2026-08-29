import { declaredNames, isTestPath, splitChangedLines } from './change-type.js';

/** The only shape this module needs from a decision. Deliberately structural
 * rather than an import of `ReviewDecision`: `review-decisions.ts` calls into
 * here to build the pack, so importing its types back would close a cycle. */
export interface EvidenceHunk {
  filePath: string;
  location: string;
  lines: string[];
}

export interface CoverageEvidenceHunk extends EvidenceHunk {
  /** Which of the decision's new declarations this test hunk actually names.
   * Carried into the prompt so the model is told what a hunk is evidence *of*,
   * instead of being handed extra diff and left to guess the connection. */
  symbols: string[];
}

export interface CoverageEvidence {
  /** Declarations the decision introduces, which are what a coverage claim has
   * to be about. Empty when the change declares nothing new. */
  symbols: string[];
  /** Test hunks from elsewhere in the same review that name those symbols. */
  hunks: CoverageEvidenceHunk[];
  /** Declarations no test hunk anywhere in the review mentions. This is a
   * deterministic finding, not a model judgement: the reviewer is told the
   * whole diff was searched and the name never appeared. */
  uncitedSymbols: string[];
}

export const EMPTY_COVERAGE_EVIDENCE: CoverageEvidence = { symbols: [], hunks: [], uncitedSymbols: [] };

/** Bounds on what gets attached. The pack rides in the assist prompt and in the
 * cache key, so an unbounded pack would both blow the context and fragment the
 * cache every time an unrelated test elsewhere in the review moved a line. */
const MAX_EVIDENCE_HUNKS = 4;
const MAX_EVIDENCE_LINES = 240;
const MAX_SYMBOLS = 12;

/** Identifier-aware match. `\b` is wrong here because `$` is a word character
 * in JS identifiers but not in the regex word class, so `\bfoo\b` would happily
 * match inside `foo$bar`. */
function referencesSymbol(lines: string[], symbol: string): boolean {
  const escaped = symbol.replace(/[$]/g, '\\$');
  const pattern = new RegExp(`(?:^|[^\\w$])${escaped}(?![\\w$])`);
  return lines.some((line) => pattern.test(line));
}

function hunkKey(hunk: EvidenceHunk): string {
  return `${hunk.filePath}::${hunk.location}`;
}

/** Declarations a decision adds, in its production hunks only. A declaration
 * added inside a test file is the test's own helper, never the subject under
 * test, and treating it as one made every test-only decision demand coverage
 * of itself. */
export function newDeclarations(hunks: EvidenceHunk[]): string[] {
  const names = new Set<string>();
  for (const hunk of hunks) {
    if (isTestPath(hunk.filePath)) continue;
    for (const name of declaredNames(splitChangedLines(hunk.lines).added)) names.add(name);
  }
  return [...names].sort().slice(0, MAX_SYMBOLS);
}

/** Pairs a decision's new declarations with the test hunks elsewhere in the
 * same review that exercise them.
 *
 * This exists because the assist worker sees exactly one decision's hunks and
 * has no repo access. Asked "is this new function tested?", it could only ever
 * answer "not visible here" — the tests are real and in the same review, just
 * split into a different decision. Carrying the matching test hunks alongside
 * the change is what makes a grounded coverage answer possible at all. */
export function buildCoverageEvidence(target: EvidenceHunk[], siblings: EvidenceHunk[]): CoverageEvidence {
  const symbols = newDeclarations(target);
  if (symbols.length === 0) return EMPTY_COVERAGE_EVIDENCE;

  const own = new Set(target.map(hunkKey));
  const scored: CoverageEvidenceHunk[] = [];
  const covered = new Set<string>();
  for (const hunk of siblings) {
    if (own.has(hunkKey(hunk)) || !isTestPath(hunk.filePath)) continue;
    const matched = symbols.filter((symbol) => referencesSymbol(hunk.lines, symbol));
    if (matched.length === 0) continue;
    for (const symbol of matched) covered.add(symbol);
    scored.push({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines, symbols: matched });
  }

  // Most symbols proved first, then the tighter hunk: when the cap bites, the
  // reviewer should lose the least informative evidence rather than whatever
  // happened to sort last by path.
  scored.sort((a, b) => b.symbols.length - a.symbols.length
    || a.lines.length - b.lines.length
    || a.filePath.localeCompare(b.filePath));

  const kept: CoverageEvidenceHunk[] = [];
  let lineBudget = MAX_EVIDENCE_LINES;
  for (const hunk of scored) {
    if (kept.length >= MAX_EVIDENCE_HUNKS || hunk.lines.length > lineBudget) continue;
    lineBudget -= hunk.lines.length;
    kept.push(hunk);
  }

  // `uncitedSymbols` is computed against every sibling scanned, not just the
  // hunks that survived the cap. Narrowing it to the kept set would report a
  // symbol as untested purely because its evidence lost a budget contest.
  return { symbols, hunks: kept, uncitedSymbols: symbols.filter((symbol) => !covered.has(symbol)) };
}

/** A citation the model emitted, e.g. `[src/shared/foo.test.ts:42]`. */
export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
  raw: string;
}

const CITATION = /\[([^\][\s:]+):(\d+)(?:\s*[-–]\s*(\d+))?\]/g;

export function parseCitations(answer: string): Citation[] {
  const found: Citation[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(CITATION)) {
    if (seen.has(match[0])) continue;
    seen.add(match[0]);
    const startLine = Number(match[2]);
    const endLine = match[3] ? Number(match[3]) : startLine;
    found.push({ filePath: match[1], startLine, endLine: Math.max(startLine, endLine), raw: match[0] });
  }
  return found;
}

/** Reads back the line span a hunk actually covers. Handles both the rendered
 * form (`Lines 12–30`) and the raw `@@` header the renderer falls through to
 * when it cannot parse a range. */
function hunkSpan(location: string): { start: number; end: number } | null {
  const rendered = location.match(/Lines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/);
  if (rendered) {
    const start = Number(rendered[1]);
    return { start, end: rendered[2] ? Number(rendered[2]) : start };
  }
  const raw = location.match(/\+(\d+)(?:,(\d+))?/);
  if (raw) {
    const start = Number(raw[1]);
    return { start, end: start + Math.max(Number(raw[2] ?? 1), 1) - 1 };
  }
  return null;
}

export interface CitationAudit {
  citations: Citation[];
  /** Citations naming a file or line that was never shown to the model. These
   * are the fabricated ones — the failure mode this whole layer exists to
   * catch, since a confident citation to code nobody supplied reads as proof. */
  unresolved: Citation[];
}

/** Checks every citation in an answer against the hunks the prompt actually
 * carried. A citation is only sound if the file was supplied and the cited line
 * falls inside a supplied hunk of that file: a real path with an invented line
 * number is still a fabricated reference. */
export function auditCitations(answer: string, supplied: EvidenceHunk[]): CitationAudit {
  const spansByPath = new Map<string, Array<{ start: number; end: number }>>();
  for (const hunk of supplied) {
    const span = hunkSpan(hunk.location);
    if (!span) continue;
    const spans = spansByPath.get(hunk.filePath) ?? [];
    spans.push(span);
    spansByPath.set(hunk.filePath, spans);
  }

  const resolvePath = (filePath: string): Array<{ start: number; end: number }> | null => {
    const exact = spansByPath.get(filePath);
    if (exact) return exact;
    // The model routinely shortens a path to its tail. Accept that only when it
    // is unambiguous; two candidates means we cannot tell which file it meant,
    // and guessing would launder a vague citation into a verified one.
    const matches = [...spansByPath.keys()].filter((path) => path.endsWith(`/${filePath}`));
    return matches.length === 1 ? spansByPath.get(matches[0]) ?? null : null;
  };

  const citations = parseCitations(answer);
  const unresolved = citations.filter((citation) => {
    const spans = resolvePath(citation.filePath);
    if (!spans) return true;
    return !spans.some((span) => citation.startLine <= span.end && citation.endLine >= span.start);
  });
  return { citations, unresolved };
}

/** One deterministic line appended to an answer so the reviewer sees the
 * citation check without having to trust the prose above it. Returns null when
 * there is nothing to say, so a clean answer is not padded. */
export function citationAuditNote(audit: CitationAudit): string | null {
  if (audit.citations.length === 0) return null;
  if (audit.unresolved.length === 0) {
    return `Citation check: ${audit.citations.length} citation${audit.citations.length === 1 ? '' : 's'} resolved to supplied hunks.`;
  }
  return `Citation check: ${audit.unresolved.length} of ${audit.citations.length} citations do not match any supplied hunk and are unverified — ${audit.unresolved.map((citation) => citation.raw).join(', ')}.`;
}
