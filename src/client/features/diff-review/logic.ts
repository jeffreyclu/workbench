import type { DiffHunkReview, DiffHunkReviewState, WorkspaceDiffFile } from '../../../shared/contracts.js';

export const REVIEW_RISK_SIGNALS = ['public_api', 'persistence', 'auth', 'cross_file', 'error_path'] as const;

export type ReviewRiskSignal = typeof REVIEW_RISK_SIGNALS[number];

export interface ReviewDecision {
  id: string;
  filePath: string;
  editorUrl: string | null;
  hunkRange: string;
  location: string;
  behavior: string;
  additions: number;
  deletions: number;
  riskSignals: ReviewRiskSignal[];
  state: DiffHunkReviewState | null;
  note: string | null;
}

export interface ReviewFileQueueItem {
  path: string;
  editorUrl: string | null;
  decisions: number;
  completed: number;
  state: 'pending' | 'needs_changes' | 'commented' | 'approved';
  riskSignals: ReviewRiskSignal[];
}

interface PatchHunk {
  range: string;
  lines: string[];
}

const RISK_WEIGHTS: Record<ReviewRiskSignal, number> = {
  auth: 5,
  persistence: 4,
  public_api: 3,
  error_path: 2,
  cross_file: 1,
};

const STATE_ORDER: Record<DiffHunkReviewState, number> = {
  needs_changes: 1,
  commented: 2,
  reviewed: 3,
};

function splitPatchHunks(file: Pick<WorkspaceDiffFile, 'patch' | 'isBinary'>): PatchHunk[] {
  if (!file.patch) return [{ range: file.isBinary ? 'Binary file' : 'Whole-file change', lines: [] }];
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;
  for (const line of file.patch.split('\n')) {
    if (line.startsWith('@@')) {
      current = { range: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    }
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
  const match = range.match(/^@@[^@]*@@\s*(.+)$/);
  const context = match?.[1]?.trim();
  return context ? context.slice(0, 100) : null;
}

function behaviorSummary(file: Pick<WorkspaceDiffFile, 'path' | 'status'>, hunk: PatchHunk, additions: number, deletions: number): string {
  const context = hunkContext(hunk.range);
  if (context) return `Changes ${context} in ${file.path}.`;
  const location = hunkLocation(hunk.range).toLowerCase();
  if (file.status === 'added' || deletions === 0) return `Adds behavior to ${file.path} near ${location}.`;
  if (file.status === 'removed' || additions === 0) return `Removes behavior from ${file.path} near ${location}.`;
  return `Updates behavior in ${file.path} near ${location}.`;
}

function riskSignals(file: Pick<WorkspaceDiffFile, 'path' | 'status'>, hunk: PatchHunk, changedFileCount: number): ReviewRiskSignal[] {
  const changedLines = hunk.lines.filter((line) => line.startsWith('+') || line.startsWith('-')).join('\n');
  const evidence = `${file.path}\n${changedLines}`;
  const signals: ReviewRiskSignal[] = [];
  if (/(?:^|\/)(?:api|routes?|contracts?|public)(?:\/|\.|-)|\b(?:export\s+(?:async\s+)?(?:function|class|const|interface|type)|router\.(?:get|post|put|patch|delete)|app\.(?:get|post|put|patch|delete))\b/i.test(evidence)) signals.push('public_api');
  if (/(?:database|migration|repository|schema|sqlite|sql|prisma|drizzle|\b(?:select|insert|update|delete)\s+(?:from|into|[a-z_]+\s+set)\b)/i.test(evidence)) signals.push('persistence');
  if (/(?:auth|oauth|permission|authorize|session|credential|secret|access[_ -]?token|bearer)/i.test(evidence)) signals.push('auth');
  if (changedFileCount > 1 && (file.status === 'renamed' || /(?:\bimport\b|\bexport\b|\brequire\s*\(|\bfrom\s+['"])/.test(changedLines))) signals.push('cross_file');
  if (/(?:\bthrow\b|\bcatch\b|\berror\b|\bfail(?:ed|ure)?\b|\bretr(?:y|ies)\b|\btimeout\b|\babort\b)/i.test(evidence)) signals.push('error_path');
  return signals;
}

function decisionPriority(decision: ReviewDecision): number {
  return decision.riskSignals.reduce((total, signal) => total + RISK_WEIGHTS[signal], 0);
}

export function buildReviewDecisions(files: WorkspaceDiffFile[], reviews: DiffHunkReview[]): ReviewDecision[] {
  const reviewByKey = new Map(reviews.map((review) => [`${review.filePath}::${review.hunkRange}`, review]));
  const decisions: ReviewDecision[] = [];
  for (const file of files) {
    for (const hunk of splitPatchHunks(file)) {
      const review = reviewByKey.get(`${file.path}::${hunk.range}`);
      const counts = countChangedLines(hunk.lines);
      decisions.push({
        id: `${file.path}::${hunk.range}`,
        filePath: file.path,
        editorUrl: file.editorUrl ?? null,
        hunkRange: hunk.range,
        location: hunkLocation(hunk.range),
        behavior: behaviorSummary(file, hunk, counts.additions, counts.deletions),
        additions: counts.additions,
        deletions: counts.deletions,
        riskSignals: riskSignals(file, hunk, files.length),
        state: review?.state ?? null,
        note: review?.note ?? null,
      });
    }
  }
  return decisions;
}

export function orderReviewDecisions(decisions: ReviewDecision[]): ReviewDecision[] {
  return [...decisions].sort((left, right) => {
    const stateDifference = (left.state ? STATE_ORDER[left.state] : 0) - (right.state ? STATE_ORDER[right.state] : 0);
    if (stateDifference !== 0) return stateDifference;
    const riskDifference = decisionPriority(right) - decisionPriority(left);
    if (riskDifference !== 0) return riskDifference;
    return left.id.localeCompare(right.id);
  });
}

export function buildReviewFileQueue(decisions: ReviewDecision[]): ReviewFileQueueItem[] {
  const files = new Map<string, ReviewDecision[]>();
  for (const decision of orderReviewDecisions(decisions)) {
    const entries = files.get(decision.filePath) ?? [];
    entries.push(decision);
    files.set(decision.filePath, entries);
  }
  return [...files.entries()].map(([path, entries]) => {
    const states = entries.map((entry) => entry.state);
    const state = states.includes('needs_changes') ? 'needs_changes'
      : states.includes(null) ? 'pending'
        : states.includes('commented') ? 'commented'
          : 'approved';
    return {
      path,
      editorUrl: entries[0]?.editorUrl ?? null,
      decisions: entries.length,
      completed: states.filter((entry) => entry !== null).length,
      state,
      riskSignals: REVIEW_RISK_SIGNALS.filter((signal) => entries.some((entry) => entry.riskSignals.includes(signal))),
    };
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
