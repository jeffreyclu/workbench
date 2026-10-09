import type { WorkspaceDiffFile } from '../../../shared/contracts.js';
import type { ReviewDecision } from '../diff-review/logic.js';
import { fileLabel } from './logic.js';
import { decisionIdForFile } from './palette-commands.js';

export type FileDecisionState = 'none' | 'pending' | 'reviewed' | 'needs_changes' | 'commented';
export type FileRisk = 'low' | 'elevated' | 'high';

export interface FileNavigatorRow {
  path: string;
  label: string;
  status: WorkspaceDiffFile['status'];
  additions: number;
  deletions: number;
  decisionState: FileDecisionState;
  decisionsSettled: number;
  decisionsTotal: number;
  openNotes: number;
  whitespaceOnly: boolean;
  risk: FileRisk | null;
  /** The decision a click lands on; null when the file has none to open. */
  decisionId: string | null;
}

const RISK_RANK: Record<FileRisk, number> = { low: 1, elevated: 2, high: 3 };

function isRisk(band: string | undefined): band is FileRisk {
  return band === 'low' || band === 'elevated' || band === 'high';
}

/** The worst thing a reviewer still owes on a file: a rejected hunk outranks an
 * unanswered one, which outranks a comment, and only a file with every decision
 * reviewed reads as reviewed. */
function fileDecisionState(touching: { state: ReviewDecision['state'] }[]): FileDecisionState {
  if (touching.length === 0) return 'none';
  if (touching.some((decision) => decision.state === 'needs_changes')) return 'needs_changes';
  if (touching.some((decision) => decision.state === null)) return 'pending';
  if (touching.some((decision) => decision.state === 'commented')) return 'commented';
  return 'reviewed';
}

export function buildFileNavigatorRows({ files, decisions, automatic, openNotesByFile, whitespaceOnly, riskBands }: {
  files: WorkspaceDiffFile[];
  decisions: ReviewDecision[];
  /** Decisions the proof settled by itself; they count as reviewed. */
  automatic?: ReadonlySet<string>;
  openNotesByFile: ReadonlyMap<string, number>;
  whitespaceOnly: ReadonlySet<string>;
  /** AI risk band per decision id. */
  riskBands: ReadonlyMap<string, string>;
}): FileNavigatorRow[] {
  return files.map((file) => {
    const touching = decisions
      .filter((decision) => decision.filePaths.includes(file.path))
      .map((decision) => (decision.state === null && automatic?.has(decision.id) ? { ...decision, state: 'reviewed' as const } : decision));
    let risk: FileRisk | null = null;
    for (const decision of touching) {
      const band = riskBands.get(decision.id);
      if (isRisk(band) && (!risk || RISK_RANK[band] > RISK_RANK[risk])) risk = band;
    }
    return {
      path: file.path,
      label: fileLabel(file),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      decisionState: fileDecisionState(touching),
      decisionsSettled: touching.filter((decision) => decision.state !== null).length,
      decisionsTotal: touching.length,
      openNotes: openNotesByFile.get(file.path) ?? 0,
      whitespaceOnly: whitespaceOnly.has(file.path),
      risk,
      decisionId: decisionIdForFile(decisions, file.path),
    };
  });
}

/** Open (unresolved, still anchored) notes per file, from the drawer's groups. */
export function openNoteCounts(groups: { filePath: string; notes: { note: { resolved: boolean }; target: unknown }[] }[]): Map<string, number> {
  return new Map(groups.map((group) => [group.filePath, group.notes.filter((entry) => !entry.note.resolved).length] as const));
}

export const DECISION_STATE_LABEL: Record<FileDecisionState, string> = {
  none: 'No decisions',
  pending: 'Awaiting review',
  reviewed: 'Reviewed',
  needs_changes: 'Needs changes',
  commented: 'Commented',
};

export const FILE_STATUS_LETTER: Record<WorkspaceDiffFile['status'], string> = {
  added: 'A', modified: 'M', removed: 'D', renamed: 'R', copied: 'C', changed: 'M',
};

export function describeFileRow(row: FileNavigatorRow): string {
  const parts = [
    `${row.label}, ${row.status}`,
    `${row.additions} added, ${row.deletions} removed`,
    row.decisionsTotal > 0 ? `${DECISION_STATE_LABEL[row.decisionState]}, ${row.decisionsSettled} of ${row.decisionsTotal} decisions answered` : DECISION_STATE_LABEL.none,
  ];
  if (row.openNotes > 0) parts.push(`${row.openNotes} open ${row.openNotes === 1 ? 'note' : 'notes'}`);
  if (row.whitespaceOnly) parts.push('whitespace only');
  if (row.risk) parts.push(`${row.risk} risk`);
  return parts.join(', ');
}
