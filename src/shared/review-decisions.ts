import type { DiffHunkReview, DiffHunkReviewState, WorkspaceDiffFile } from './contracts.js';

/** Decision derivation is shared, not client-only: the server's background
 * scorer must produce byte-identical decision payloads, because the AI answer
 * cache is keyed by a hash of that payload. Any drift between the two would
 * silently turn every pre-computed score into a cache miss the reviewer pays
 * for again. */
export const REVIEW_RISK_SIGNALS = ['public_api', 'persistence', 'auth', 'cross_file', 'error_path'] as const;
export type ReviewRiskSignal = typeof REVIEW_RISK_SIGNALS[number];

export interface ReviewDecisionHunk {
  id: string;
  /** Content identity of this hunk, stable across diff revisions. */
  fingerprint: string;
  filePath: string;
  editorUrl: string | null;
  hunkRange: string;
  location: string;
  lines: string[];
  additions: number;
  deletions: number;
  state: DiffHunkReviewState | null;
  note: string | null;
}

export interface ReviewDecision {
  id: string;
  /** Stable label for this decision, assigned once in source order. It is not
   * the queue position: a reviewed decision keeps its number when priority
   * order moves it, so "decision 3" means the same change all session. */
  ordinal: number;
  subject: string | null;
  behavior: string;
  hunks: ReviewDecisionHunk[];
  filePaths: string[];
  additions: number;
  deletions: number;
  riskSignals: ReviewRiskSignal[];
  state: DiffHunkReviewState | null;
  note: string | null;
}

export interface PatchHunk { range: string; lines: string[] }
interface DecisionCandidate {
  subject: string | null;
  fileStatus: WorkspaceDiffFile['status'];
  hunk: ReviewDecisionHunk;
  riskSignals: ReviewRiskSignal[];
  /** Changed nothing but import statements. Such a hunk is never a decision of
   * its own — it exists because some other hunk started using the symbol. */
  importOnly: boolean;
}
const NON_SUBJECTS = new Set([
  'async', 'await', 'catch', 'class', 'const', 'describe', 'else', 'export', 'false', 'function', 'if',
  'import', 'interface', 'it', 'let', 'null', 'return', 'test', 'throw', 'true', 'type', 'undefined', 'var',
  // CSS pseudo-classes (e.g. `button:not(.foo)`) match the generic `word(` scan but are not code identifiers.
  'not', 'is', 'has', 'where', 'matches', 'dir', 'lang',
]);

export function splitPatchHunks(file: Pick<WorkspaceDiffFile, 'patch' | 'isBinary'>): PatchHunk[] {
  if (!file.patch) return [{ range: file.isBinary ? 'Binary file' : 'Whole-file change', lines: [] }];
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('@@')) {
      current = { range: line, lines: [] };
      hunks.push(current);
    } else if (current) current.lines.push(line);
  }
  return hunks.length > 0 ? hunks : [{ range: 'Whole-file change', lines: file.patch.split('\n') }];
}

export function countChangedLines(lines: string[]) {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

/** Content identity of a hunk, independent of where it sits in the file.
 * A diff revision is a hash of the entire patch, so while an agent is still
 * writing, every keystroke anywhere in the repository produced a new revision
 * and orphaned every review the reviewer had already recorded. Only the file
 * and the changed lines are hashed: line numbers and surrounding context move
 * without changing what was decided. Trailing whitespace is normalised for the
 * same reason. */
export function hunkFingerprint(filePath: string, lines: string[]): string {
  const changed = changedCodeSignature(lines);
  const text = `${filePath}\u0000${changed.length > 0 ? changed.join('\n') : lines.join('\n')}`;
  // FNV-1a rather than node:crypto: the client records the fingerprint and the
  // server matches on it, so both runtimes must produce the same string.
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(index))) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function changedCodeSignature(lines: string[]): string[] {
  return lines
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
    .map((line) => `${line[0]}${line.slice(1).trimEnd()}`);
}

export function hunkLocation(range: string): string {
  const match = range.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return range;
  const newStart = Number(match[3]);
  const newCount = Number(match[4] ?? 1);
  const oldStart = Number(match[1]);
  const oldCount = Number(match[2] ?? 1);
  const start = newCount > 0 ? newStart : oldStart;
  const count = newCount > 0 ? newCount : oldCount;
  return count <= 1 ? `Line ${start}` : `Lines ${start}\u2013${start + count - 1}`;
}

function hunkContext(range: string): string | null {
  const context = range.match(/^@@[^@]*@@\s*(.+)$/)?.[1]?.trim();
  return context ? context.slice(0, 160) : null;
}

function identifierFromCode(value: string): string | null {
  const declaration = value.match(/\b(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (declaration) return declaration[1];
  const namedTest = value.match(/\b(?:describe|test|it)\s*\(\s*['"`]([A-Za-z_$][\w$]*)/);
  if (namedTest) return namedTest[1];
  const functionLike = value.match(/\b([A-Za-z_$][\w$]*)\s*\(/);
  if (functionLike && !NON_SUBJECTS.has(functionLike[1])) return functionLike[1];
  return null;
}

function hunkSubject(hunk: PatchHunk): string | null {
  const context = hunkContext(hunk.range);
  const contextSubject = context ? identifierFromCode(context) : null;
  if (contextSubject) return contextSubject;
  for (const line of hunk.lines) {
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    const subject = identifierFromCode(line.slice(1));
    if (subject) return subject;
  }
  return null;
}

function humanizeIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
}

function staticRiskSignals(file: Pick<WorkspaceDiffFile, 'path'>, hunk: PatchHunk): ReviewRiskSignal[] {
  const changedLines = hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-')).join('\n');
  const evidence = `${file.path}\n${changedLines}`;
  const signals: ReviewRiskSignal[] = [];
  if (/(?:^|\/)(?:api|routes?|contracts?|public)(?:\/|\.|-)|\b(?:export\s+(?:async\s+)?(?:function|class|const|interface|type)|router\.(?:get|post|put|patch|delete)|app\.(?:get|post|put|patch|delete))\b/i.test(evidence)) signals.push('public_api');
  if (/(?:database|migration|repository|schema|sqlite|sql|prisma|drizzle|\b(?:select|insert|update|delete)\s+(?:from|into|[a-z_]+\s+set)\b)/i.test(evidence)) signals.push('persistence');
  if (/(?:auth|oauth|permission|authorize|session|credential|secret|access[_ -]?token|bearer)/i.test(evidence)) signals.push('auth');
  if (/(?:\bthrow\b|\bcatch\b|\berror\b|\bfail(?:ed|ure)?\b|\bretr(?:y|ies)\b|\btimeout\b|\babort\b)/i.test(evidence)) signals.push('error_path');
  return signals;
}

const IMPORT_KEYWORDS = new Set(['import', 'export', 'from', 'as', 'type', 'typeof', 'const', 'let', 'var', 'require', 'default', 'await', 'new', 'use', 'strict']);

function changedCodeLines(lines: string[]): string[] {
  return lines
    .filter((line) => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
    .map((line) => line.slice(1).trim());
}

/** Import statements, including the continuation lines of a multi-line named
 * import and the CSS/SCSS `@use`/`@import` forms. Kept deliberately narrow: a
 * hunk misread as import-only would be folded into an unrelated decision. */
const IMPORT_LINE = /^(?:import\b|export\s+(?:\*|\{)[^;]*\bfrom\b|(?:const|let|var)\s+[\w${},:\s*]+=\s*require\(|from\s+['"]|@(?:use|import|forward)\b|[{}]\s*,?$|[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?\s*,?$|type\s+[A-Za-z_$][\w$]*\s*,?$|['"][^'"]*['"]\s*;?$)/;

function isImportOnlyChange(lines: string[]): boolean {
  const changed = changedCodeLines(lines).filter((line) => line.length > 0);
  if (changed.length === 0) return false;
  if (!changed.some((line) => /^(?:import\b|export\s+(?:\*|\{)[^;]*\bfrom\b|@(?:use|import|forward)\b)/.test(line) || /\brequire\(/.test(line) || /^from\s+['"]/.test(line))) return false;
  return changed.every((line) => IMPORT_LINE.test(line));
}

/** The symbols an import hunk brings into the file, so the hunk that starts
 * using one of them can be found. Module paths are stripped first: a path
 * segment that happens to match an identifier elsewhere is not a binding. */
function importedSymbols(lines: string[]): string[] {
  const names = new Set<string>();
  for (const line of changedCodeLines(lines)) {
    const withoutPaths = line.replace(/['"][^'"]*['"]/g, ' ');
    for (const match of withoutPaths.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!IMPORT_KEYWORDS.has(match[0])) names.add(match[0]);
    }
  }
  return [...names];
}

function usesSymbol(lines: string[], symbols: string[]): boolean {
  const body = changedCodeLines(lines).join('\n');
  return symbols.some((symbol) => new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`).test(body));
}

function aggregateState(hunks: ReviewDecisionHunk[]): DiffHunkReviewState | null {
  const states = hunks.map((hunk) => hunk.state);
  if (states.includes(null)) return null;
  if (states.includes('needs_changes')) return 'needs_changes';
  if (states.includes('commented')) return 'commented';
  return 'reviewed';
}

function aggregateNote(hunks: ReviewDecisionHunk[]): string | null {
  const notes = [...new Set(hunks.map((hunk) => hunk.note?.trim()).filter((note): note is string => Boolean(note)))];
  if (notes.length === 0) return null;
  if (notes.length === 1) return notes[0];
  return hunks.filter((hunk) => hunk.note).map((hunk) => `${hunk.filePath} (${hunk.location}): ${hunk.note}`).join('\n\n');
}

function behaviorSummary(subject: string | null, hunks: ReviewDecisionHunk[], statuses: WorkspaceDiffFile['status'][], signals: ReviewRiskSignal[]): string {
  const subjectLabel = subject ? humanizeIdentifier(subject) : null;
  const additions = hunks.reduce((total, hunk) => total + hunk.additions, 0);
  const deletions = hunks.reduce((total, hunk) => total + hunk.deletions, 0);
  const verb = statuses.every((status) => status === 'added') || deletions === 0 ? 'Adds'
    : statuses.every((status) => status === 'removed') || additions === 0 ? 'Removes'
      : 'Changes';
  if (!subjectLabel) {
    if (hunks.length === 1) return `${verb} behavior in ${hunks[0].filePath}.`;
    return `${verb} related behavior across ${new Set(hunks.map((hunk) => hunk.filePath)).size} files.`;
  }
  const effect = signals.includes('auth') ? `${subjectLabel} access checks`
    : signals.includes('persistence') ? `how ${subjectLabel} stores or retrieves data`
      : signals.includes('error_path') ? `how ${subjectLabel} handles failures`
        : signals.includes('public_api') ? `the public ${subjectLabel} contract`
          : subjectLabel;
  const fileCount = new Set(hunks.map((hunk) => hunk.filePath)).size;
  return `${verb} ${effect}${fileCount > 1 ? ` across ${fileCount} files` : ''}.`;
}

interface ParsedHunk { file: WorkspaceDiffFile; patchHunk: PatchHunk; fingerprint: string }

/** Reviews recorded against an earlier revision, indexed by the fingerprint of
 * the hunk they were recorded on. A carried review is only offered when the
 * pairing is unambiguous: exactly one hunk in the current diff carries that
 * fingerprint. Two byte-identical hunks in one diff cannot be told apart, and
 * silently marking the wrong one reviewed is worse than asking again. Among
 * several past decisions on identical content, the most recent one stands. */
function carriedReviewsByFingerprint(parsed: ParsedHunk[], reviews: DiffHunkReview[]): Map<string, DiffHunkReview> {
  const currentFingerprintByKey = new Map(parsed.map((entry) => [`${entry.file.path}::${entry.patchHunk.range}`, entry.fingerprint]));
  const currentCounts = new Map<string, number>();
  for (const entry of parsed) currentCounts.set(entry.fingerprint, (currentCounts.get(entry.fingerprint) ?? 0) + 1);
  const byFingerprint = new Map<string, DiffHunkReview>();
  for (const review of reviews) {
    if (!review.fingerprint) continue;
    // A review whose code is still at the coordinates it was recorded against
    // is applied there directly, so it is not a candidate for any other hunk.
    // Matching on the fingerprint rather than the coordinates alone matters:
    // an agent that replaced this hunk's lines while leaving the range intact
    // leaves a review that belongs to whichever hunk the code moved to, if any.
    if (currentFingerprintByKey.get(`${review.filePath}::${review.hunkRange}`) === review.fingerprint) continue;
    if (currentCounts.get(review.fingerprint) !== 1) continue;
    const existing = byFingerprint.get(review.fingerprint);
    if (!existing || review.updatedAt > existing.updatedAt) byFingerprint.set(review.fingerprint, review);
  }
  return byFingerprint;
}

/** The review recorded at a hunk's own coordinates, if it is about this code.
 * The reviews handed in span revisions, so coordinates alone no longer identify
 * a hunk: a decision recorded against an earlier revision can name a range that
 * now holds entirely different lines, and applying it there would mark unread
 * code reviewed. A row with no fingerprint predates them and is only ever
 * returned for the revision being read, so its coordinates still hold. */
function coordinateReview(atKey: DiffHunkReview[] | undefined, fingerprint: string): DiffHunkReview | undefined {
  return atKey?.find((review) => review.fingerprint === fingerprint) ?? atKey?.find((review) => !review.fingerprint);
}

export function buildReviewDecisions(files: WorkspaceDiffFile[], reviews: DiffHunkReview[]): ReviewDecision[] {
  const reviewsByKey = new Map<string, DiffHunkReview[]>();
  for (const review of reviews) {
    const key = `${review.filePath}::${review.hunkRange}`;
    reviewsByKey.set(key, [...(reviewsByKey.get(key) ?? []), review]);
  }
  const parsed: ParsedHunk[] = files.flatMap((file) => splitPatchHunks(file)
    .map((patchHunk) => ({ file, patchHunk, fingerprint: hunkFingerprint(file.path, patchHunk.lines) })));
  const carried = carriedReviewsByFingerprint(parsed, reviews);
  const candidates: DecisionCandidate[] = [];
  for (const { file, patchHunk, fingerprint } of parsed) {
    const review = coordinateReview(reviewsByKey.get(`${file.path}::${patchHunk.range}`), fingerprint) ?? carried.get(fingerprint);
    const counts = countChangedLines(patchHunk.lines);
    candidates.push({
      subject: hunkSubject(patchHunk), fileStatus: file.status,
      hunk: {
        id: `${file.path}::${patchHunk.range}`, fingerprint, filePath: file.path, editorUrl: file.editorUrl ?? null,
        hunkRange: patchHunk.range, location: hunkLocation(patchHunk.range), lines: patchHunk.lines,
        additions: counts.additions, deletions: counts.deletions, state: review?.state ?? null, note: review?.note ?? null,
      },
      riskSignals: staticRiskSignals(file, patchHunk),
      importOnly: isImportOnlyChange(patchHunk.lines),
    });
  }

  const subjectFileCounts = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (!candidate.subject) continue;
    const paths = subjectFileCounts.get(candidate.subject) ?? new Set<string>();
    paths.add(candidate.hunk.filePath);
    subjectFileCounts.set(candidate.subject, paths);
  }
  const groupKeys = candidates.map((candidate) => {
    const spansFiles = candidate.subject && (subjectFileCounts.get(candidate.subject)?.size ?? 0) > 1;
    return spansFiles ? `subject:${candidate.subject}` : `hunk:${candidate.hunk.id}`;
  });
  // New imports travel with the code that needed them. Judging `import { x }`
  // on its own tells a reviewer nothing — the question is always what x is now
  // used for — and it cost a queue position and an AI answer per import block.
  candidates.forEach((candidate, index) => {
    if (!candidate.importOnly) return;
    const symbols = importedSymbols(candidate.hunk.lines);
    if (symbols.length === 0) return;
    const consumer = candidates.findIndex((other, otherIndex) =>
      otherIndex !== index
      && !other.importOnly
      && other.hunk.filePath === candidate.hunk.filePath
      && usesSymbol(other.hunk.lines, symbols));
    if (consumer >= 0) groupKeys[index] = groupKeys[consumer];
  });
  const groups = new Map<string, DecisionCandidate[]>();
  candidates.forEach((candidate, index) => {
    const key = groupKeys[index];
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  });

  return [...groups.values()].map((group, index) => {
    const hunks = group.map((candidate) => candidate.hunk);
    // An import block carries no subject and no behavior worth naming, so a
    // group it merely accompanies is described by the code hunk instead.
    const primary = group.find((candidate) => !candidate.importOnly) ?? group[0];
    const filePaths = [...new Set(hunks.map((hunk) => hunk.filePath))];
    const riskSignals = REVIEW_RISK_SIGNALS.filter((signal) => group.some((candidate) => candidate.riskSignals.includes(signal)));
    if (filePaths.length > 1) riskSignals.push('cross_file');
    return {
      ordinal: index + 1,
      id: group.length > 1 ? `decision:${primary.subject}:${hunks.map((hunk) => hunk.id).sort().join('|')}` : hunks[0].id,
      subject: primary.subject,
      behavior: behaviorSummary(primary.subject, hunks, group.map((candidate) => candidate.fileStatus), riskSignals),
      hunks, filePaths,
      additions: hunks.reduce((total, hunk) => total + hunk.additions, 0),
      deletions: hunks.reduce((total, hunk) => total + hunk.deletions, 0),
      riskSignals, state: aggregateState(hunks), note: aggregateNote(hunks),
    };
  });
}

/** Part of the assist payload, not just a label: the AI answer cache is keyed
 * by this exact string, so the queue and the background scorer must render a
 * decision's review state the same way. */
export function reviewStateLabel(state: DiffHunkReviewState | null): string {
  if (state === 'reviewed') return 'Approved';
  if (state === 'needs_changes') return 'Needs changes';
  if (state === 'commented') return 'Commented';
  return 'Pending';
}

/** The badge form of the same label. The queue scrolls horizontally and
 * reviewed decisions sort to its tail, so a reviewer coming back around needs
 * to read "have I settled this one?" from a glance at a narrow chip rather than
 * from a sentence that would be truncated at that width. */
export function reviewStateShortLabel(state: DiffHunkReviewState | null): string {
  if (state === 'reviewed') return 'Done';
  if (state === 'needs_changes') return 'Changes';
  if (state === 'commented') return 'Noted';
  return 'To do';
}

/** The one place a decision is turned into an AI-assist request payload. Both
 * the reviewer's click and the background scorer go through it, so a decision
 * hashes to the same cache key from either side. */
export function reviewAssistDecisionPayload(decision: ReviewDecision): {
  behavior: string;
  state: string;
  hunks: Array<{ filePath: string; location: string; lines: string[] }>;
} {
  return {
    behavior: decision.behavior,
    state: reviewStateLabel(decision.state),
    hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines })),
  };
}
