import { REVIEW_ASSIST_CONFIDENCE_PREFIX, REVIEW_ASSIST_MISSING_PREFIX } from '../../../shared/contracts.js';

/**
 * Reading a delegated answer's own verdict on itself.
 *
 * A tier is a spending decision made before anyone has looked at the block, so
 * it is sometimes wrong — and the cheapest way to find that out is to let the
 * cheap answer say so. An answer that ends in low confidence is not a bad
 * answer; it is the block telling the queue it was priced too low.
 *
 * Silence means confident on purpose. Untiered answers (every Changes answer,
 * and any answer cached before tiering existed) carry no marker, and treating
 * a missing marker as doubt would escalate the entire queue to study.
 */
export function assistEscalationReason(answer: string | null | undefined): string | null {
  if (!answer) return null;
  const lines = answer.split('\n').map((line) => line.trim()).filter(Boolean);
  const confidence = lines.find((line) => line.toUpperCase().startsWith(REVIEW_ASSIST_CONFIDENCE_PREFIX));
  if (!confidence) return null;
  if (confidence.slice(REVIEW_ASSIST_CONFIDENCE_PREFIX.length).trim().toLowerCase() !== 'low') return null;
  const missing = lines.find((line) => line.toUpperCase().startsWith(REVIEW_ASSIST_MISSING_PREFIX));
  const detail = missing?.slice(REVIEW_ASSIST_MISSING_PREFIX.length).trim();
  // The reason is what the reviewer reads next to the block, so it says what
  // the model lacked rather than that a threshold was crossed.
  return detail ? `Delegated answer was not confident: ${detail}` : 'Delegated answer was not confident.';
}

/** The first answer of the several a block can have that reports low
 * confidence. One unconfident answer is enough: the block has already proven
 * a cheap turn cannot settle it. */
export function assistAnswersEscalationReason(answers: Iterable<string | null | undefined>): string | null {
  for (const answer of answers) {
    const reason = assistEscalationReason(answer);
    if (reason) return reason;
  }
  return null;
}
