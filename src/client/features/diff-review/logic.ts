import type { DiffHunkReviewState, WorkspaceDiffFile } from '../../../shared/contracts.js';
// Derivation lives in shared code so the server's background scorer builds the
// same decisions, with the same ids, as the queue the reviewer is reading.
export { REVIEW_RISK_SIGNALS, buildReviewDecisions, reviewAssistDecisionPayload, reviewStateLabel, reviewStateShortLabel } from '../../../shared/review-decisions.js';
export type { ReviewDecision, ReviewDecisionHunk, ReviewRiskSignal } from '../../../shared/review-decisions.js';
export { REVIEW_CHANGE_TYPES, changeTypeLabel } from '../../../shared/change-type.js';
export type { ReviewChangeType } from '../../../shared/change-type.js';
import { countChangedLines, hunkLocation, reviewStateLabel, splitPatchHunks } from '../../../shared/review-decisions.js';
import type { ReviewDecision, ReviewRiskSignal } from '../../../shared/review-decisions.js';


const STATE_ORDER: Record<DiffHunkReviewState, number> = { needs_changes: 1, commented: 2, reviewed: 3 };

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

export function riskSignalLabel(signal: ReviewRiskSignal): string {
  if (signal === 'public_api') return 'Public API';
  if (signal === 'cross_file') return 'Cross-file';
  if (signal === 'error_path') return 'Error path';
  return signal[0].toUpperCase() + signal.slice(1);
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

/** The model is told to answer `score_risk` as `SCORE: <n>` plus one line of
 * reason. Parsing is strict on purpose: an answer that ignores the format is
 * shown as plain text instead of being coerced into a number the model never
 * committed to, so a bad turn is visible rather than silently neutral. */
export function parseAiRiskScore(answer: string | undefined | null): { score: number; reason: string } | null {
  if (!answer) return null;
  const match = /^\s*SCORE:\s*(\d{1,3})\s*$/im.exec(answer);
  if (!match) return null;
  const score = Number(match[1]);
  if (score > 100) return null;
  return { score, reason: answer.slice(match.index + match[0].length).trim() };
}

/** Three bands, because a bare number carries no judgement: the reviewer should
 * be able to read severity from the colour without doing arithmetic. */
export function aiRiskBand(score: number): 'low' | 'elevated' | 'high' {
  if (score < 34) return 'low';
  if (score < 67) return 'elevated';
  return 'high';
}
