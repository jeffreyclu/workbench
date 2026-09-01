import type { ReviewDecision } from '../../../shared/review-decisions.js';
import { assistEscalationReason } from './review-escalation.js';
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
 * T1 is exactly that block — "bounded question — delegated", proof-settled but
 * large enough to skim. T2 is priced at "needs a judgment call": worth
 * delegating so the answer is waiting when the block is opened, never worth
 * closing unread. T3 is study and T0 already settled by proof, so neither
 * spends a delegated turn at all.
 */
export function isDelegatedTier(tier: ReviewTier): boolean {
  return tier === 'T1' || tier === 'T2';
}

/** Only T1. A delegated T2 answer is reading material, not a verdict. */
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
export function delegationOutcome(tier: ReviewTier, answer: string | null | undefined): DelegationOutcome {
  const escalation = assistEscalationReason(answer);
  return { autoReview: delegationAutoReviews(tier) && Boolean(answer) && !escalation, escalation };
}

/** A change waiting on a delegated turn, and the tier it was priced at. */
export interface DelegationTarget {
  decisionId: string;
  decision: ReviewDecision;
  tier: ReviewTier;
}
