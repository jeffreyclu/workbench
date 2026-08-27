import { memo } from 'react';
import { ChevronRight } from 'lucide-react';
import { DiffConfidenceBubble } from './diff-confidence-bubble.js';
import { isChangedBlock, type DiffBlock, type DiffConfidenceAssessment, type DiffFollowUpReference } from './diff-confidence.js';
import { isLowRiskAssessment } from './diff-review-logic.js';

export const DiffSummaryStrip = memo(function DiffSummaryStrip({ changedFiles, additions, deletions }: { changedFiles: number; additions: number; deletions: number }) {
  return <span className="diff-summary-strip" aria-label={`${changedFiles} changed files, ${additions} additions, ${deletions} deletions`}>
    <span>{changedFiles} files</span><b>+{additions}</b><i>−{deletions}</i>
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
      return <details key={block.key} className="diff-block diff-block-collapsed">
        <summary className="diff-block-disclosure" aria-label={`Show low-risk change, risk ${assessment.risk} out of 100`}>
          <ChevronRight size={13} aria-hidden="true" />
          <span>Low risk</span><small>{assessment.risk}/100 · {changedLineCount} changed {changedLineCount === 1 ? 'line' : 'lines'}</small>
        </summary>
        <DiffBlockContent block={block} lineHtml={lineHtml} assessment={assessment} filePath={filePath} onFollowUp={onFollowUp} />
      </details>;
    }

    return <div key={block.key} className={changed ? 'diff-block' : undefined}><DiffBlockContent block={block} lineHtml={lineHtml} assessment={assessment} filePath={filePath} onFollowUp={onFollowUp} /></div>;
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
