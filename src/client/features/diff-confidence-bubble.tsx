import { useState } from 'react';
import { confidenceProminence, confidenceTone, type DiffConfidenceAssessment } from './diff-confidence.js';

export function DiffConfidenceBubble({ assessment, onFollowUp }: { assessment: DiffConfidenceAssessment | null; onFollowUp?: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (assessment === null) {
    return (
      <span className="diff-confidence-bubble diff-confidence-pending" aria-label="AI assessment in progress" aria-live="polite" title="AI is scoring this change">
        <span aria-hidden="true">AI scoring</span>
      </span>
    );
  }

  const unavailable = assessment.risk === null;
  const tone = confidenceTone(assessment.risk);
  const { opacity, fontWeight } = confidenceProminence(assessment.risk);

  return (
    <span className="diff-confidence-control">
      <button
        type="button"
        className="diff-confidence-bubble"
        style={{ color: tone, borderColor: tone, opacity, fontWeight }}
        aria-label={unavailable ? 'AI assessment unavailable' : `AI risk assessment: ${assessment.risk} out of 100`}
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        {unavailable ? '--' : assessment.risk}
      </button>
      {detailsOpen && (
        <span className="diff-confidence-details" role="dialog" aria-label={unavailable ? 'AI assessment unavailable' : `Risk assessment: ${assessment.risk} out of 100`}>
          <strong>{unavailable ? 'AI assessment unavailable' : `${assessment.risk}/100 risk`}</strong>
          <p>{assessment.reasoning}</p>
          <span>
            <button type="button" onClick={() => setDetailsOpen(false)}>Close</button>
            {onFollowUp && <button type="button" className="primary" onClick={() => { onFollowUp(); setDetailsOpen(false); }}>Follow up</button>}
          </span>
        </span>
      )}
    </span>
  );
}
