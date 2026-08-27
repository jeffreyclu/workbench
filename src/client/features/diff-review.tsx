import { memo, useCallback, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { DiffConfidenceBubble } from './diff-confidence-bubble.js';
import type { FlaggedBlock } from './diff-confidence-hooks.js';
import { isChangedBlock, type DiffBlock, type DiffConfidenceAssessment, type DiffFollowUpReference } from './diff-confidence.js';
import { isLowRiskAssessment } from './diff-review-logic.js';

/** Drives the "next flagged block" jump: cycles through the diff-level
 * flagged block queue, switching the selected file if needed and scrolling
 * the block into view once it's rendered. Flagged blocks are never collapsed
 * (low-risk and high-risk are disjoint), so no need to expand a <details>. */
export function useFlaggedBlockJump(flaggedBlocks: FlaggedBlock[], setSelectedPath: (path: string) => void) {
  const cursorRef = useRef(0);
  useEffect(() => { cursorRef.current = 0; }, [flaggedBlocks]);
  return useCallback(() => {
    if (flaggedBlocks.length === 0) return;
    const target = flaggedBlocks[cursorRef.current % flaggedBlocks.length];
    cursorRef.current += 1;
    setSelectedPath(target.path);
    requestAnimationFrame(() => {
      const element = document.querySelector<HTMLElement>(`[data-block-id="${target.path}::${target.blockKey}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.focus();
    });
  }, [flaggedBlocks, setSelectedPath]);
}

export const DiffSummaryStrip = memo(function DiffSummaryStrip({ changedFiles, additions, deletions, flaggedCount, onJumpToNextFlagged }: {
  changedFiles: number;
  additions: number;
  deletions: number;
  flaggedCount: number;
  onJumpToNextFlagged?: () => void;
}) {
  const flaggedLabel = `${flaggedCount} ${flaggedCount === 1 ? 'block' : 'blocks'} flagged high-risk`;
  return <span className="diff-summary-strip" aria-label={`${changedFiles} changed files, ${additions} additions, ${deletions} deletions${flaggedCount > 0 ? `, ${flaggedLabel}` : ''}`}>
    <span>{changedFiles} files</span><b>+{additions}</b><i>−{deletions}</i>
    {flaggedCount > 0 && <span className="diff-summary-flagged">· {flaggedLabel}</span>}
    {flaggedCount > 0 && onJumpToNextFlagged && <button type="button" className="diff-summary-jump" onClick={onJumpToNextFlagged}>Next flagged block</button>}
  </span>;
});

export const DiffBlockList = memo(function DiffBlockList({ blocks, lineHtml, assessments, filePath, onFollowUp }: {
  blocks: DiffBlock[];
  lineHtml: Map<string, string>;
  assessments: Record<string, DiffConfidenceAssessment | null>;
  filePath: string;
  onFollowUp?: (reference: DiffFollowUpReference) => void;
}) {
  return <>{blocks.map((block) => {
    const changed = isChangedBlock(block);
    const assessment = assessments[block.key] ?? null;
    const changedLineCount = block.lines.filter((line) => line.kind !== 'header').length;

    if (changed && isLowRiskAssessment(assessment)) {
      return <details key={block.key} className="diff-block diff-block-collapsed" data-block-id={`${filePath}::${block.key}`} tabIndex={-1}>
        <summary className="diff-block-disclosure" aria-label={`Show low-risk change, risk ${assessment.risk} out of 100`}>
          <ChevronRight size={13} aria-hidden="true" />
          <span>Low risk</span><small>{assessment.risk}/100 · {changedLineCount} changed {changedLineCount === 1 ? 'line' : 'lines'}</small>
        </summary>
        <DiffBlockContent block={block} lineHtml={lineHtml} assessment={assessment} filePath={filePath} onFollowUp={onFollowUp} />
      </details>;
    }

    return <div key={block.key} className={changed ? 'diff-block' : undefined} data-block-id={changed ? `${filePath}::${block.key}` : undefined} tabIndex={changed ? -1 : undefined}><DiffBlockContent block={block} lineHtml={lineHtml} assessment={assessment} filePath={filePath} onFollowUp={onFollowUp} /></div>;
  })}</>;
});

function DiffBlockContent({ block, lineHtml, assessment, filePath, onFollowUp }: {
  block: DiffBlock;
  lineHtml: Map<string, string>;
  assessment: DiffConfidenceAssessment | null;
  filePath: string;
  onFollowUp?: (reference: DiffFollowUpReference) => void;
}) {
  const changed = isChangedBlock(block);
  return <>
    {changed && <DiffConfidenceBubble assessment={assessment} onFollowUp={assessment && onFollowUp ? () => onFollowUp({ filePath, lines: block.lines, assessment }) : undefined} />}
    {block.lines.map((line) => <code key={line.key} className={`diff-line ${line.kind}`}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><span>{line.kind === 'header' ? (line.text || ' ') : <><span className="diff-line-marker">{line.text.slice(0, 1) || ' '}</span><span className="diff-line-code" dangerouslySetInnerHTML={{ __html: lineHtml.get(line.key) || '&nbsp;' }} /></>}</span></code>)}
  </>;
}
