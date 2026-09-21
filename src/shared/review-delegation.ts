import type { ReviewDecision } from './review-decisions.js';
import { assistAnswersEscalationReason } from './review-escalation.js';
import { LOW_RISK_DELEGATION_MAX, parseAiRiskScore } from './review-risk-score.js';
import type { ReviewTier } from './review-routing.js';

/**
 * Which tiers are handed to a model instead of to Jeffrey, and which of those
 * the model is allowed to close on its own.
 *
 * Two separate decisions, deliberately. *Delegating* is spending a turn:
 * cheap, reversible, and worth doing on anything the reviewer was not going to
 * open first. *Auto-reviewing* is accepting the answer as the verdict, and
 * that is only defensible where routing already said the question is bounded.
 *
 * T1 and T2 are both delegated. Only a scored, genuinely low-risk T1 may
 * close itself. T2 still gets a model read, but remains a human verdict. T3 is
 * critical study and T0 already settled by proof, so neither spends a
 * delegated turn at all.
 */
export function isDelegatedTier(tier: ReviewTier): boolean {
  return tier === 'T1' || tier === 'T2';
}

/** Only the lowest review tier is ever eligible to close itself. */
export function delegationAutoReviews(tier: ReviewTier): boolean {
  return tier === 'T1';
}

export interface DelegationOutcome {
  /** Record a reviewed verdict against the change without asking. */
  autoReview: boolean;
  /** What the delegated answer said it lacked, when it could not settle. */
  escalation: string | null;
}

/**
 * What a delegated answer earns.
 *
 * An answer that signs off confidently at an auto-reviewing tier closes the
 * change. Anything else leaves it owed: low confidence escalates it into
 * Jeffrey's queue with the model's own reason attached, and an empty answer —
 * a failed turn — is not evidence of anything.
 */
export function delegationOutcome(
  tier: ReviewTier,
  answer: string | null | undefined,
  scoreAnswer: string | null | undefined,
): DelegationOutcome {
  if (!answer) return { autoReview: false, escalation: 'Delegated review did not return an explanation.' };
  const confidenceFailure = assistAnswersEscalationReason([answer, scoreAnswer]);
  if (confidenceFailure) return { autoReview: false, escalation: confidenceFailure };
  const score = parseAiRiskScore(scoreAnswer);
  if (!score) return { autoReview: false, escalation: 'Delegated review did not return a valid risk score.' };
  if (score.score > LOW_RISK_DELEGATION_MAX) {
    return { autoReview: false, escalation: `AI risk score ${score.score}/100 needs review.` };
  }
  if (!delegationAutoReviews(tier)) {
    return { autoReview: false, escalation: 'Delegated review recommends a human read.' };
  }
  return { autoReview: true, escalation: null };
}

/** A change waiting on a delegated turn, and the tier it was priced at. */
export interface DelegationTarget {
  decisionId: string;
  decision: ReviewDecision;
  tier: ReviewTier;
}
