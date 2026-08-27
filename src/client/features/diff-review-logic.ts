import type { DiffConfidenceAssessment } from './diff-confidence.js';

export const LOW_RISK_THRESHOLD = 30;
export const HIGH_RISK_THRESHOLD = 70;

/** Pending and failed assessments remain expanded: neither is evidence of low risk. */
export function isLowRiskAssessment(assessment: DiffConfidenceAssessment | null): assessment is DiffConfidenceAssessment & { risk: number } {
  return assessment !== null && assessment.risk !== null && assessment.risk < LOW_RISK_THRESHOLD;
}

/** Flags the blocks the summary strip counts and the "next flagged block" jump targets. */
export function isHighRiskAssessment(assessment: DiffConfidenceAssessment | null): assessment is DiffConfidenceAssessment & { risk: number } {
  return assessment !== null && assessment.risk !== null && assessment.risk >= HIGH_RISK_THRESHOLD;
}
