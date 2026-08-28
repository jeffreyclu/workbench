import type { DiffHunkReview, DiffHunkReviewState, WorkspaceDiffFile } from '../../../shared/contracts.js';
import type { DiffDecisionFollowUpReference } from '../diff-confidence.js';

export const REVIEW_RISK_SIGNALS = ['public_api', 'persistence', 'auth', 'cross_file', 'error_path'] as const;
export type ReviewRiskSignal = typeof REVIEW_RISK_SIGNALS[number];

export interface ReviewDecisionHunk {
  id: string;
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

interface PatchHunk { range: string; lines: string[] }
interface DecisionCandidate {
  subject: string | null;
  fileStatus: WorkspaceDiffFile['status'];
  hunk: ReviewDecisionHunk;
  riskSignals: ReviewRiskSignal[];
}

const STATE_ORDER: Record<DiffHunkReviewState, number> = { needs_changes: 1, commented: 2, reviewed: 3 };
const NON_SUBJECTS = new Set([
  'async', 'await', 'catch', 'class', 'const', 'describe', 'else', 'export', 'false', 'function', 'if',
  'import', 'interface', 'it', 'let', 'null', 'return', 'test', 'throw', 'true', 'type', 'undefined', 'var',
  // CSS pseudo-classes (e.g. `button:not(.foo)`) match the generic `word(` scan but are not code identifiers.
  'not', 'is', 'has', 'where', 'matches', 'dir', 'lang',
]);

function splitPatchHunks(file: Pick<WorkspaceDiffFile, 'patch' | 'isBinary'>): PatchHunk[] {
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

function countChangedLines(lines: string[]) {
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

function hunkLocation(range: string): string {
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

export function buildReviewDecisions(files: WorkspaceDiffFile[], reviews: DiffHunkReview[]): ReviewDecision[] {
  const reviewByKey = new Map(reviews.map((review) => [`${review.filePath}::${review.hunkRange}`, review]));
  const candidates: DecisionCandidate[] = [];
  for (const file of files) {
    for (const patchHunk of splitPatchHunks(file)) {
      const review = reviewByKey.get(`${file.path}::${patchHunk.range}`);
      const counts = countChangedLines(patchHunk.lines);
      candidates.push({
        subject: hunkSubject(patchHunk), fileStatus: file.status,
        hunk: {
          id: `${file.path}::${patchHunk.range}`, filePath: file.path, editorUrl: file.editorUrl ?? null,
          hunkRange: patchHunk.range, location: hunkLocation(patchHunk.range), lines: patchHunk.lines,
          additions: counts.additions, deletions: counts.deletions, state: review?.state ?? null, note: review?.note ?? null,
        },
        riskSignals: staticRiskSignals(file, patchHunk),
      });
    }
  }

  const subjectFileCounts = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (!candidate.subject) continue;
    const paths = subjectFileCounts.get(candidate.subject) ?? new Set<string>();
    paths.add(candidate.hunk.filePath);
    subjectFileCounts.set(candidate.subject, paths);
  }
  const groups = new Map<string, DecisionCandidate[]>();
  for (const candidate of candidates) {
    const spansFiles = candidate.subject && (subjectFileCounts.get(candidate.subject)?.size ?? 0) > 1;
    const key = spansFiles ? `subject:${candidate.subject}` : `hunk:${candidate.hunk.id}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  return [...groups.values()].map((group, index) => {
    const hunks = group.map((candidate) => candidate.hunk);
    const filePaths = [...new Set(hunks.map((hunk) => hunk.filePath))];
    const riskSignals = REVIEW_RISK_SIGNALS.filter((signal) => group.some((candidate) => candidate.riskSignals.includes(signal)));
    if (filePaths.length > 1) riskSignals.push('cross_file');
    return {
      ordinal: index + 1,
      id: group.length > 1 ? `decision:${group[0].subject}:${hunks.map((hunk) => hunk.id).sort().join('|')}` : hunks[0].id,
      subject: group[0].subject,
      behavior: behaviorSummary(group[0].subject, hunks, group.map((candidate) => candidate.fileStatus), riskSignals),
      hunks, filePaths,
      additions: hunks.reduce((total, hunk) => total + hunk.additions, 0),
      deletions: hunks.reduce((total, hunk) => total + hunk.deletions, 0),
      riskSignals, state: aggregateState(hunks), note: aggregateNote(hunks),
    };
  });
}

/** Priority order is purely deterministic: unreviewed decisions first, then in
 * stable source order (ordinal). No AI signal ever reorders or gates the
 * queue — assistance is available on demand from the detail card instead. */
export function orderReviewDecisions(decisions: ReviewDecision[]): ReviewDecision[] {
  return [...decisions].sort((left, right) => {
    const stateDifference = (left.state ? STATE_ORDER[left.state] : 0) - (right.state ? STATE_ORDER[right.state] : 0);
    return stateDifference !== 0 ? stateDifference : left.ordinal - right.ordinal;
  });
}

export function nextPendingDecisionId(decisions: ReviewDecision[], currentId: string): string | null {
  const ordered = orderReviewDecisions(decisions);
  const currentIndex = ordered.findIndex((decision) => decision.id === currentId);
  const after = ordered.slice(currentIndex + 1).find((decision) => decision.state === null);
  const before = ordered.slice(0, Math.max(currentIndex, 0)).find((decision) => decision.state === null);
  return after?.id ?? before?.id ?? ordered.find((decision) => decision.id !== currentId)?.id ?? null;
}

export function reviewStateLabel(state: DiffHunkReviewState | null): string {
  if (state === 'reviewed') return 'Approved';
  if (state === 'needs_changes') return 'Needs changes';
  if (state === 'commented') return 'Commented';
  return 'Pending';
}

export function riskSignalLabel(signal: ReviewRiskSignal): string {
  if (signal === 'public_api') return 'Public API';
  if (signal === 'cross_file') return 'Cross-file';
  if (signal === 'error_path') return 'Error path';
  return signal[0].toUpperCase() + signal.slice(1);
}

/** Turns one queue decision into the context the agent receives in the
 * composer for "Request fix": the reviewer discusses the decision, not a
 * detached line range, so every hunk it spans travels with the behaviour and
 * review state. This surface no longer computes an ambient AI score, so
 * `assessment` is always null here — the reviewer's own on-demand AI answers,
 * if any, are theirs to paste in separately. */
export function reviewDecisionFollowUpReference(decision: ReviewDecision): DiffDecisionFollowUpReference {
  return {
    ordinal: decision.ordinal,
    behavior: decision.behavior,
    assessment: null,
    state: reviewStateLabel(decision.state),
    hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, location: hunk.location, lines: hunk.lines })),
  };
}

export interface ReviewDiffLine {
  key: string;
  kind: 'context' | 'addition' | 'deletion';
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

/** One hunk of a file's patch, carrying the id of the decision it belongs to so
 * selecting a decision can highlight its block inside the whole-file diff. */
export interface ReviewDiffHunk {
  decisionId: string;
  range: string;
  location: string;
  additions: number;
  deletions: number;
  lines: ReviewDiffLine[];
}

function hunkStart(range: string, side: 'old' | 'new'): number | null {
  const match = range.match(side === 'old' ? /^@@ -(\d+)/ : /^@@ -\S+ \+(\d+)/);
  return match ? Number(match[1]) : null;
}

/** The complete patch of one file, split into decision-addressable blocks. The
 * review surface renders every line of it — reviewers judge a change in its
 * surrounding context, not as detached lines. */
export function buildFileDiffHunks(file: Pick<WorkspaceDiffFile, 'path' | 'patch' | 'isBinary'>): ReviewDiffHunk[] {
  return splitPatchHunks(file).map((hunk) => {
    let oldLine = hunkStart(hunk.range, 'old');
    let newLine = hunkStart(hunk.range, 'new');
    const lines: ReviewDiffLine[] = hunk.lines.map((text, index) => {
      const key = `${hunk.range}:${index}`;
      if (text.startsWith('+')) {
        const line = { key, kind: 'addition' as const, oldLine: null, newLine, text };
        if (newLine !== null) newLine += 1;
        return line;
      }
      if (text.startsWith('-')) {
        const line = { key, kind: 'deletion' as const, oldLine, newLine: null, text };
        if (oldLine !== null) oldLine += 1;
        return line;
      }
      const line = { key, kind: 'context' as const, oldLine, newLine, text };
      if (oldLine !== null) oldLine += 1;
      if (newLine !== null) newLine += 1;
      return line;
    });
    const counts = countChangedLines(hunk.lines);
    return { decisionId: `${file.path}::${hunk.range}`, range: hunk.range, location: hunkLocation(hunk.range), additions: counts.additions, deletions: counts.deletions, lines };
  });
}
