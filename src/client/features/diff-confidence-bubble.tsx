import { useState } from 'react';
import { confidenceProminence, confidenceTone, type DiffConfidenceAssessment } from './diff-confidence.js';

/** `confidence` is null while the model is still assessing the file. The bubble
 * still renders so blocks do not shift position when the scores land. */
export function DiffConfidenceBubble({ assessment, onFollowUp }: { assessment: DiffConfidenceAssessment | null; onFollowUp?: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (assessment === null) {
    return <span className="diff-confidence-bubble diff-confidence-pending" aria-label="AI assessment in progress" aria-live="polite" title="AI is scoring this change"><span aria-hidden="true">AI scoring</span></span>;
  }
  const tone = confidenceTone(assessment.confidence);
  const { opacity, fontWeight } = confidenceProminence(assessment.confidence);
  return <span className="diff-confidence-control">
    <button type="button" className="diff-confidence-bubble" style={{ color: tone, borderColor: tone, opacity, fontWeight }} aria-label={`AI assessment: ${assessment.confidence} out of 100`} aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>{assessment.confidence}</button>
    {detailsOpen && <span className="diff-confidence-details" role="dialog" aria-label={`Confidence assessment: ${assessment.confidence} out of 100`}>
      <strong>{assessment.confidence}/100 confidence</strong>
      <p>{assessment.reasoning}</p>
      <span><button type="button" onClick={() => setDetailsOpen(false)}>Close</button>{onFollowUp && <button type="button" className="primary" onClick={() => { onFollowUp(); setDetailsOpen(false); }}>Follow up</button>}</span>
    </span>}
  </span>;
}
