import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, FileCode } from 'lucide-react';
import type { WorkspaceFileSource } from '../../../shared/contracts.js';
import type { ReviewDiffHunk } from '../diff-review/logic.js';
import { toFullFileReading } from './review-full-file.js';

/** Whole-file reading of the active block.
 *
 * Review owns this rather than extending the shared diff pane: whole-file is a
 * different unit of reading, not another mode of the patch window, and the
 * Changes surface must keep rendering exactly what it rendered before.
 *
 * The reader gets the file as it will exist, with the change marked where it
 * lands. That is the reading for a refactor whose meaning lives in the code
 * around it — the one case where the block boundary lies, because the evidence
 * that the change is wrong is outside the three lines git gave you. */
export const ReviewFullFilePane = memo(function ReviewFullFilePane({ filePath, file, isLoading, error, hunks, activeDecisionId, onSelect }: {
  filePath: string;
  file: WorkspaceFileSource | null;
  isLoading: boolean;
  error: string | null;
  hunks: ReviewDiffHunk[];
  activeDecisionId: string | null;
  onSelect: (decisionId: string) => void;
}) {
  const reading = useMemo(() => (file?.content ? toFullFileReading(file.content, hunks) : null), [file?.content, hunks]);
  const changes = reading?.changes ?? [];
  const activeIndex = changes.findIndex((change) => change.decisionId === activeDecisionId);
  const [pending, setPending] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);

  const jumpTo = useCallback((index: number) => {
    const change = changes[index];
    if (!change) return;
    setPending(change.firstLine);
    onSelect(change.decisionId);
  }, [changes, onSelect]);

  // The active block is what the reviewer asked to read, so the file opens at
  // it rather than at line 1 — a whole file that opens at its top would make
  // the reader hunt for the change they just selected.
  const landing = pending ?? changes[activeIndex]?.firstLine ?? null;
  useEffect(() => {
    if (landing === null) return;
    const container = scroller.current;
    const target = container?.querySelector<HTMLElement>(`[data-line="${landing}"]`);
    if (!container || !target) return;
    container.scrollTop = Math.max(0, target.offsetTop - container.offsetTop - 48);
    setPending(null);
  }, [landing, reading]);

  if (isLoading) return <p className="review-full-file-note">Reading the whole file…</p>;
  if (error) return <p className="review-full-file-note">{error}</p>;
  if (!file) return <p className="review-full-file-note">Nothing to read yet.</p>;
  if (file.unavailable || !file.content) return <p className="review-full-file-note">{file.unavailable ?? 'This file cannot be read whole.'}</p>;
  if (reading && !reading.aligned) {
    return <p className="review-full-file-note">This file has changed since the diff was read, so the change cannot be placed in it. Refresh, or read the diff.</p>;
  }

  return <div className="review-full-file">
    <header>
      <FileCode size={13} aria-hidden="true" />
      <strong>{filePath}</strong>
      <small>{changes.length} {changes.length === 1 ? 'change' : 'changes'} in this file</small>
      <nav aria-label="Changes in this file">
        <button type="button" className="button secondary compact" disabled={activeIndex <= 0} onClick={() => jumpTo(activeIndex - 1)} aria-label="Previous change in this file">
          <ChevronUp size={13} aria-hidden="true" />
        </button>
        <button type="button" className="button secondary compact" disabled={activeIndex < 0 || activeIndex >= changes.length - 1} onClick={() => jumpTo(activeIndex + 1)} aria-label="Next change in this file">
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </nav>
    </header>
    <div className="review-full-file-body" ref={scroller}>
      {reading?.rows.map((row) => (row.type === 'removed'
        ? <div key={row.key} className="review-full-file-row removed" data-line={row.lineNumber}>
            <span className="review-full-file-number" aria-hidden="true" />
            <span className="review-full-file-text">{row.lines.length} {row.lines.length === 1 ? 'line' : 'lines'} removed here</span>
          </div>
        : <div
            key={row.key}
            data-line={row.lineNumber}
            className={`review-full-file-row${row.changed ? ' changed' : ''}${row.decisionId && row.decisionId === activeDecisionId ? ' active' : ''}`}
            onClick={row.decisionId ? () => onSelect(row.decisionId!) : undefined}
          >
            <span className="review-full-file-number" aria-hidden="true">{row.lineNumber}</span>
            <span className="review-full-file-text">{row.text || ' '}</span>
          </div>))}
    </div>
  </div>;
});
