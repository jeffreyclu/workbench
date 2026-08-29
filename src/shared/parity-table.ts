import type { ReviewChangeType } from './change-type.js';

/** The four axes a behavior-preserving claim has to survive. Fixed and ordered:
 * a reviewer comparing two decisions should read the same axes in the same
 * places, and a free-form comparison reliably dropped whichever axis the diff
 * made least obvious — usually ordering. */
export const PARITY_AXES = ['SIGNATURE', 'ERROR HANDLING', 'ORDERING', 'COMPLEXITY'] as const;

export type ParityAxis = (typeof PARITY_AXES)[number];

/** Only the two types that assert equivalence. `behavior_edit` also compares an
 * old and a new version, but it is *expected* to differ, so demanding a parity
 * verdict there would turn every intended change into a reported difference. */
const PARITY_TYPES = new Set<ReviewChangeType>(['refactor_pure', 'replacement']);

export function parityTableApplies(changeType: ReviewChangeType): boolean {
  return PARITY_TYPES.has(changeType);
}

/** The output contract handed to the model. Verdict tokens are closed so the
 * audit below can check the answer without re-reading the prose, and UNCLEAR is
 * offered deliberately: without it the model picks SAME when the diff does not
 * show enough, which is the false all-clear this whole layer exists to stop. */
export const PARITY_DIRECTIVE = [
  'Before anything else, emit the parity table: one line per axis, in this order and with these exact labels —',
  `${PARITY_AXES.join(', ')}.`,
  'Each line is "AXIS: VERDICT — detail", where VERDICT is SAME, CHANGED, or UNCLEAR.',
  'A CHANGED verdict must carry a [path:line] citation to the line that differs; SAME and UNCLEAR take no citation.',
  'Use UNCLEAR when the hunks do not show enough to compare that axis — never SAME.',
  'Then continue with the rest of the instruction.',
].join(' ');

/** Matches an axis label at the start of a line, tolerating a bullet marker and
 * either spelling of the two-word axis. Case-insensitive on purpose: the answer
 * shouting or not is the one thing about this contract that does not matter,
 * while whether the axis was compared at all is the thing that does. */
function axisPattern(axis: ParityAxis): RegExp {
  const label = axis.replace(/ /g, '[\\s-]+');
  return new RegExp(`^\\s*(?:[-*•]\\s*)?${label}\\s*[:–-]`, 'i');
}

const VERDICT = /\b(SAME|CHANGED|UNCLEAR)\b/i;
const CITATION_PRESENT = /\[[^\][\s:]+:\d+/;

export interface ParityAudit {
  /** Axes with no line at all — the comparison silently skipped them. */
  missingAxes: ParityAxis[];
  /** Axes stated without one of the closed verdict tokens, so the line reads as
   * a verdict to a human but cannot be checked or compared across decisions. */
  unverdictedAxes: ParityAxis[];
  /** Axes claimed CHANGED with no citation, which is the difference between a
   * reported difference a reviewer can jump to and one they must hunt for. */
  uncitedChanges: ParityAxis[];
}

export function parityAuditIsClean(audit: ParityAudit): boolean {
  return audit.missingAxes.length === 0 && audit.unverdictedAxes.length === 0 && audit.uncitedChanges.length === 0;
}

/** Checks an answer against the parity contract. Deterministic and text-only:
 * it judges whether the axes were addressed, never whether the verdicts are
 * right — that stays the reviewer's job, which is the point of forcing the
 * verdicts into a fixed shape in the first place. */
export function auditParityTable(answer: string): ParityAudit {
  const lines = answer.split('\n');
  const audit: ParityAudit = { missingAxes: [], unverdictedAxes: [], uncitedChanges: [] };
  for (const axis of PARITY_AXES) {
    const pattern = axisPattern(axis);
    const line = lines.find((candidate) => pattern.test(candidate));
    if (line === undefined) { audit.missingAxes.push(axis); continue; }
    // Read the verdict from after the label only. A detail like "nothing
    // changed" on a SAME line would otherwise be scanned as the verdict, and
    // the first token after the colon is the slot the contract reserves.
    const body = line.replace(pattern, '');
    const verdict = body.match(VERDICT);
    if (!verdict) { audit.unverdictedAxes.push(axis); continue; }
    if (verdict[1].toUpperCase() === 'CHANGED' && !CITATION_PRESENT.test(body)) audit.uncitedChanges.push(axis);
  }
  return audit;
}

function list(axes: ParityAxis[]): string {
  return axes.map((axis) => axis.toLowerCase()).join(', ');
}

/** One deterministic line appended to an answer when the parity table is
 * incomplete, so an axis the model skipped reads as skipped rather than as
 * nothing to report. Returns null for a complete table: a clean contract should
 * cost the reviewer no extra line. */
export function parityAuditNote(audit: ParityAudit): string | null {
  if (parityAuditIsClean(audit)) return null;
  const problems: string[] = [];
  if (audit.missingAxes.length > 0) problems.push(`${list(audit.missingAxes)} not compared`);
  if (audit.unverdictedAxes.length > 0) problems.push(`${list(audit.unverdictedAxes)} stated without a SAME/CHANGED/UNCLEAR verdict`);
  if (audit.uncitedChanges.length > 0) problems.push(`${list(audit.uncitedChanges)} reported as changed with no citation`);
  return `Parity check: ${problems.join('; ')}. Treat those axes as uncompared, not as equivalent.`;
}
