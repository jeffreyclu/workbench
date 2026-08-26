import { confidenceProminence, confidenceTone } from './diff-confidence.js';

/** `confidence` is null while the model is still assessing the file. The bubble
 * still renders so blocks do not shift position when the scores land. */
export function DiffConfidenceBubble({ confidence }: { confidence: number | null }) {
  if (confidence === null) {
    return <span className="diff-confidence-bubble diff-confidence-pending" aria-label="AI assessment in progress" aria-live="polite" title="AI is scoring this change"><span aria-hidden="true">AI scoring</span></span>;
  }
  const tone = confidenceTone(confidence);
  const { opacity, fontWeight } = confidenceProminence(confidence);
  return <span
    className="diff-confidence-bubble"
    style={{ color: tone, borderColor: tone, opacity, fontWeight }}
    aria-label={`AI assessment: ${confidence} out of 100`}
    title={`AI assessment of this change: ${confidence}/100`}
  >{confidence}</span>;
}
