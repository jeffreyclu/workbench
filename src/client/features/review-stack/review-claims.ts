import type { ReviewChangeType } from '../../../shared/change-type.js';
import type { ReviewDecision } from '../../../shared/review-decisions.js';

/** What a block asserts about behaviour, before anyone reads a line of it.
 *
 * The obligations catalogue asks what must be established; this one states
 * what the change is claiming in the first place. They are two halves of the
 * same framing: the claim is what the reviewer is trying to falsify, and the
 * obligations are the ways it can fail. Keyed on change type rather than
 * derived from the patch text, because the classifier already did that work —
 * re-reading the lines here would be a second, weaker classifier. */
const CHANGE_TYPE_CLAIMS: Record<ReviewChangeType, string> = {
  generated: 'Nothing here was written by hand — this output follows from a source that changed elsewhere.',
  docs_comment: 'Only the description changes. The code it describes behaves exactly as it did.',
  config_dep: 'The system still runs the same way under the new configuration or dependency.',
  test_only: 'Production behaviour is untouched; only what is asserted about it changed.',
  move_rename: 'The same behaviour now lives under a different name or in a different place.',
  deletion: 'Nothing left in the system still needs what this removes.',
  replacement: 'The new implementation covers everything the old one did.',
  refactor_pure: 'Behaviour is unchanged — this is the same thing said differently.',
  new_code: 'This adds behaviour nothing depended on before, so nothing existing can regress.',
  extension: 'Existing callers keep the behaviour they had; only the new path is new.',
  behavior_edit: 'Behaviour changes here, and the new behaviour is the intended one.',
};

export interface ReviewClaim {
  /** The assertion the reviewer is being asked to accept or falsify. */
  primary: string;
  /** Further assertions the same block makes because it was classified as more
   * than one kind of change. Deduplicated against the primary claim, so a
   * secondary type that repeats it does not restate it. */
  also: string[];
}

/** The claim a block makes, stated so the reviewer can open the code to
 * disprove it rather than to discover what it is. */
export function blockClaim(decision: Pick<ReviewDecision, 'changeType' | 'secondaryChangeTypes'>): ReviewClaim {
  const primary = CHANGE_TYPE_CLAIMS[decision.changeType];
  const also: string[] = [];
  for (const type of decision.secondaryChangeTypes) {
    const claim = CHANGE_TYPE_CLAIMS[type];
    if (claim && claim !== primary && !also.includes(claim)) also.push(claim);
  }
  return { primary, also };
}
