import { confidenceProminence, confidenceTone } from './diff-confidence.js';

export function DiffConfidenceBubble({ confidence }: { confidence: number }) {
  const tone = confidenceTone(confidence);
  const { opacity, fontWeight } = confidenceProminence(confidence);
  return <span
    className="diff-confidence-bubble"
    style={{ color: tone, borderColor: tone, opacity, fontWeight }}
    title={`Confidence in this change: ${confidence}/100`}
  >{confidence}</span>;
}
