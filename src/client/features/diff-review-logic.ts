import type { DiffConfidenceAssessment } from './diff-confidence.js';

export const LOW_RISK_THRESHOLD = 30;

/** Pending and failed assessments remain expanded: neither is evidence of low risk. */
export function isLowRiskAssessment(assessment: DiffConfidenceAssessment | null): assessment is DiffConfidenceAssessment & { risk: number } {
  return assessment !== null && assessment.risk !== null && assessment.risk < LOW_RISK_THRESHOLD;
}
