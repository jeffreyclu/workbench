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

/** A hunk elsewhere in the review that mentions a declaration this decision
 * removes. `kind` is the whole point: a mention on a surviving line means the
 * reference outlived the removal, while a mention only on removed lines means
 * the call site was cleaned up in the same review. */
export interface ReferenceEvidenceHunk extends EvidenceHunk {
  symbols: string[];
  kind: 'residual' | 'updated';
}

export interface ReferenceEvidence {
  /** Declarations this decision removes, which are what a "still referenced?"
   * question has to be about. Empty when the change removes nothing. */
  symbols: string[];
  hunks: ReferenceEvidenceHunk[];
  /** Removed declarations something in the review still references on a
   * surviving line. Deterministic, and the finding worth blocking on. */
  residualSymbols: string[];
  /** Removed declarations no surviving line in the review mentions. Note the
   * deliberately weak claim: the review is not the repo, so this is "nothing
   * *here* still uses it", never "safe to delete". */
  clearedSymbols: string[];
}

export const EMPTY_REFERENCE_EVIDENCE: ReferenceEvidence = { symbols: [], hunks: [], residualSymbols: [], clearedSymbols: [] };

/** Tighter than the coverage caps. Both packs can ride in the same prompt, and
 * reference evidence is corroboration for a question the diff already raises,
 * so it yields context budget to the change under review. */
const MAX_REFERENCE_HUNKS = 3;
const MAX_REFERENCE_LINES = 180;

/** Classifies how a single hunk mentions one symbol.
 *
 * Context lines count as surviving, not as absent: an untouched call site
 * inside a neighbouring hunk is exactly the reference a deletion breaks, and
 * reading only `+`/`-` lines would silently miss it. */
function referenceKind(lines: string[], symbol: string): 'residual' | 'updated' | null {
  let updated = false;
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const isRemoved = line.startsWith('-');
    const body = isRemoved || line.startsWith('+') ? line.slice(1) : line;
    if (!referencesSymbol([body], symbol)) continue;
    if (!isRemoved) return 'residual';
    updated = true;
  }
  return updated ? 'updated' : null;
}

/** Declarations a decision removes without putting back.
 *
 * The subtraction matters: editing a function's signature emits the same name
 * on both a `-` and a `+` line, and counting that as a removal would send the
 * reviewer hunting for callers of a function that never left.
 *
 * Test paths are *not* excluded here, unlike `newDeclarations`. That exclusion
 * exists so a test helper is never demanded to have tests of its own; it does
 * not transfer, because a shared fixture deleted while another test still calls
 * it is a real break. */
export function removedDeclarations(hunks: EvidenceHunk[]): string[] {
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const hunk of hunks) {
    const changed = splitChangedLines(hunk.lines);
    for (const name of declaredNames(changed.removed)) removed.add(name);
    for (const name of declaredNames(changed.added)) added.add(name);
  }
  return [...removed].filter((name) => !added.has(name)).sort().slice(0, MAX_SYMBOLS);
}

/** Pairs the declarations a decision removes with the hunks elsewhere in the
 * same review that still mention them.
 *
 * This is the mirror of `buildCoverageEvidence`, and it exists for the same
 * reason: the assist worker sees one decision and has no repo access, so four
 * change types — deletion, replacement, move/rename, and refactor — could only
 * ever answer "callers are not visible here". Surviving references *are*
 * visible when they happen to fall in the same review, and a surviving
 * reference is the single fact that turns a routine deletion into a break. */
export function buildReferenceEvidence(target: EvidenceHunk[], siblings: EvidenceHunk[]): ReferenceEvidence {
  const symbols = removedDeclarations(target);
  if (symbols.length === 0) return EMPTY_REFERENCE_EVIDENCE;

  const own = new Set(target.map(hunkKey));
  const scored: ReferenceEvidenceHunk[] = [];
  const residual = new Set<string>();
  for (const hunk of siblings) {
    if (own.has(hunkKey(hunk))) continue;
    const survives: string[] = [];
    const cleaned: string[] = [];
    for (const symbol of symbols) {
      const kind = referenceKind(hunk.lines, symbol);
      if (kind === 'residual') survives.push(symbol);
      else if (kind === 'updated') cleaned.push(symbol);
    }
    if (survives.length === 0 && cleaned.length === 0) continue;
    for (const symbol of survives) residual.add(symbol);
    // A hunk that both keeps and drops references is reported as residual and
    // carries only the surviving names: the part that still breaks is the part
    // the reviewer has to act on.
    const kind = survives.length > 0 ? 'residual' : 'updated';
    scored.push({
      filePath: hunk.filePath,
      location: hunk.location,
      lines: hunk.lines,
      symbols: kind === 'residual' ? survives : cleaned,
      kind,
    });
  }

  // Residual before updated, because when the cap bites the reviewer must keep
  // the evidence of breakage and can afford to lose the reassurance.
  scored.sort((a, b) => Number(b.kind === 'residual') - Number(a.kind === 'residual')
    || b.symbols.length - a.symbols.length
    || a.lines.length - b.lines.length
    || a.filePath.localeCompare(b.filePath));

  const kept: ReferenceEvidenceHunk[] = [];
  let lineBudget = MAX_REFERENCE_LINES;
  for (const hunk of scored) {
    if (kept.length >= MAX_REFERENCE_HUNKS || hunk.lines.length > lineBudget) continue;
    lineBudget -= hunk.lines.length;
    kept.push(hunk);
  }

  // Computed over every sibling scanned rather than the kept set, for the same
  // reason as `uncitedSymbols`: a symbol must never read as cleared because the
  // hunk proving otherwise lost a budget contest.
  return {
    symbols,
    hunks: kept,
    residualSymbols: symbols.filter((symbol) => residual.has(symbol)),
    clearedSymbols: symbols.filter((symbol) => !residual.has(symbol)),
  };
}

/** Nouns that make a sentence a claim about code the model was never shown.
 * These are the structural questions the assist worker cannot answer from one
 * decision's hunks, which is exactly why an all-clear about them is dangerous. */
const REFERENCE_NOUN = /\b(call ?sites?|callers?|references?|referenced|usages?|imports?|consumers?)\b/i;

/** All-clear predicates: the sentence asserts the reference question is settled.
 * A claim that something is still broken needs no citation gate — it sends the
 * reviewer to look, which is the safe direction to be wrong in. */
const ALL_CLEAR = /\b(updated|migrated|adjusted|already handled|cleaned up|removed everywhere|no (?:remaining|other)|none remain|all (?:call ?sites|callers|references|usages)|nothing (?:else )?(?:still )?(?:references|uses))\b/i;

/** Hedges that make a sentence honest rather than a claim. Checked first and
 * deliberately broad: this audit is tuned for precision, because a false alarm
 * on a correctly hedged sentence teaches reviewers to skip the whole note,
 * while a missed claim leaves them exactly where they were before. */
const HEDGED = /\b(unverified|not visible|cannot|can't|unknown|outside (?:this|the) (?:review|diff)|may|might|could|would need|should be checked|re-?check|assume|unclear|if any)\b/i;

export interface ReferenceClaimAudit {
  /** All-clear sentences emitted while the review still holds a surviving
   * reference. This is a flat contradiction of supplied evidence, not a
   * missing citation, and it is the one worth naming loudest. */
  contradicted: string[];
  /** All-clear sentences with no citation into a supplied reference hunk. The
   * claim may be true, but nothing in the message could have established it. */
  uncited: string[];
}

function citesSuppliedHunk(sentence: string, hunks: EvidenceHunk[]): boolean {
  if (hunks.length === 0) return false;
  const paths = new Set(hunks.map((hunk) => hunk.filePath));
  return parseCitations(sentence).some((citation) => paths.has(citation.filePath)
    || [...paths].some((path) => path.endsWith(`/${citation.filePath}`)));
}

/** Splits on sentence and line boundaries so a bulleted answer is audited per
 * bullet. A whole-answer check would let one hedge anywhere excuse an all-clear
 * three bullets away. */
function sentences(answer: string): string[] {
  return answer.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Gates "the call sites are updated" behind the surviving-reference evidence.
 *
 * The coverage side of this system already works this way: a coverage claim has
 * to cite a companion test hunk. Reference claims were the asymmetry — the
 * evidence pack now exists, so an unbacked all-clear about callers is no longer
 * the model's only option and should stop being treated as one. */
export function auditReferenceClaims(answer: string, evidence: ReferenceEvidence | null | undefined): ReferenceClaimAudit {
  const audit: ReferenceClaimAudit = { contradicted: [], uncited: [] };
  const hunks = evidence?.hunks ?? [];
  const residual = evidence?.residualSymbols ?? [];
  for (const sentence of sentences(answer)) {
    if (HEDGED.test(sentence) || !REFERENCE_NOUN.test(sentence) || !ALL_CLEAR.test(sentence)) continue;
    if (residual.length > 0) audit.contradicted.push(sentence);
    else if (!citesSuppliedHunk(sentence, hunks)) audit.uncited.push(sentence);
  }
  return audit;
}

const MAX_QUOTED = 2;
const QUOTE_LENGTH = 120;

function quote(sentence: string): string {
  return `"${sentence.length > QUOTE_LENGTH ? `${sentence.slice(0, QUOTE_LENGTH - 1)}…` : sentence}"`;
}

function quoteAll(claims: string[]): string {
  const shown = claims.slice(0, MAX_QUOTED).map(quote).join('; ');
  return claims.length > MAX_QUOTED ? `${shown}; and ${claims.length - MAX_QUOTED} more` : shown;
}

/** The deterministic counterpart to `citationAuditNote`, appended for the same
 * reason: a reviewer should be able to see that a reassuring sentence was
 * checked, without having to re-derive the check from the prose. */
export function referenceClaimNote(audit: ReferenceClaimAudit, evidence: ReferenceEvidence | null | undefined): string | null {
  if (audit.contradicted.length > 0) {
    const residual = (evidence?.residualSymbols ?? []).join(', ');
    return `Reference check: this review still references ${residual} on a surviving line, which contradicts ${quoteAll(audit.contradicted)}.`;
  }
  if (audit.uncited.length > 0) {
    const count = audit.uncited.length;
    return `Reference check: ${count} reference claim${count === 1 ? '' : 's'} cite no supplied hunk and remain unverified — ${quoteAll(audit.uncited)}.`;
  }
  return null;
}
