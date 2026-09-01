import type { ReviewChangeType } from '../../../shared/change-type.js';
import type { ReviewDecision, ReviewRiskSignal } from '../../../shared/review-decisions.js';

/** Who can settle a question about a block.
 *
 * `proof` means the patch itself answers it — no model turn is justified.
 * `ai` means bounded judgment against evidence already in the payload.
 * `human` means the answer costs something to be wrong about, so it is
 * Jeffrey's, and the surface owes him the relationship map when he asks. */
export type ObligationSettledBy = 'proof' | 'ai' | 'human';

/** Whether the question has actually been answered yet.
 *
 * `unresolved` is the honest default, and the only outcome an `ai` or `human`
 * obligation carries here: those are settled by a model turn or by Jeffrey,
 * not by this module. `proven` and `failed` are reserved for a check that ran
 * and produced the evidence it is reported with. */
export type ObligationOutcome = 'proven' | 'failed' | 'unresolved';

/** The catalogue entry: the question, and who is allowed to answer it. */
export interface ObligationQuestion {
  id: string;
  /** Phrased as the question the block has to answer, not as a checklist item:
   * the queue's value is that a reviewer reads a question, not a category. */
  question: string;
  settledBy: ObligationSettledBy;
}

/** A question carried with whatever answer it has so far. An obligation that
 * says `proof` and never records one is a claim rather than a proof, and the
 * router spends T0 on that claim — the outcome is what makes the difference
 * visible, both to routing and to the reviewer reading the queue. */
export interface ReviewObligation extends ObligationQuestion {
  outcome: ObligationOutcome;
  /** What did the proving or the disproving, in the reviewer's words. Null
   * exactly when the outcome is unresolved. */
  evidence: string | null;
}

const CHANGE_TYPE_OBLIGATIONS: Record<ReviewChangeType, ObligationQuestion[]> = {
  generated: [{ id: 'generated_source', question: 'Was this regenerated from a source change that is itself reviewed?', settledBy: 'proof' }],
  docs_comment: [{ id: 'docs_accurate', question: 'Does the prose still describe what the code does?', settledBy: 'proof' }],
  config_dep: [{ id: 'config_blast', question: 'What runtime behaviour changes when this configuration or dependency moves?', settledBy: 'human' }],
  test_only: [{ id: 'test_asserts', question: 'Does the test assert the behaviour, or only that the code ran?', settledBy: 'ai' }],
  move_rename: [{ id: 'move_identical', question: 'Is the moved content identical, and is every reference updated?', settledBy: 'proof' }],
  deletion: [{ id: 'deletion_references', question: 'Is everything that referenced this gone too?', settledBy: 'human' }],
  replacement: [{ id: 'replacement_parity', question: 'Does the replacement cover every case the old code handled?', settledBy: 'human' }],
  refactor_pure: [{ id: 'refactor_behavior', question: 'Is behaviour genuinely unchanged, including error and edge paths?', settledBy: 'ai' }],
  new_code: [{ id: 'new_code_reached', question: 'Is this reachable, and is it covered by something that would fail if it broke?', settledBy: 'ai' }],
  extension: [{ id: 'extension_existing', question: 'Do existing callers still behave the same after the extension?', settledBy: 'ai' }],
  behavior_edit: [{ id: 'behavior_intent', question: 'Is the new behaviour the intended one, and who else depends on the old one?', settledBy: 'human' }],
};

const RISK_OBLIGATIONS: Record<ReviewRiskSignal, ObligationQuestion> = {
  public_api: { id: 'risk_public_api', question: 'Does every existing caller of this exported surface still compile and behave?', settledBy: 'human' },
  persistence: { id: 'risk_persistence', question: 'Is this a forward-only migration, and does an already-migrated database reach the new schema?', settledBy: 'human' },
  auth: { id: 'risk_auth', question: 'Can this change let a request through that the old code refused?', settledBy: 'human' },
  cross_file: { id: 'risk_cross_file', question: 'Did every file this change implies actually move with it?', settledBy: 'ai' },
  error_path: { id: 'risk_error_path', question: 'Is the failure path still reported, or is it now swallowed?', settledBy: 'ai' },
};

/** What must be proven about a block before it can leave the queue. Change
 * type selects the primary question; risk signals add the ones that are about
 * blast radius rather than about the edit. */
export function blockObligations(decision: Pick<ReviewDecision, 'changeType' | 'secondaryChangeTypes' | 'riskSignals'>): ReviewObligation[] {
  const questions = new Map<string, ObligationQuestion>();
  for (const question of CHANGE_TYPE_OBLIGATIONS[decision.changeType] ?? []) questions.set(question.id, question);
  for (const type of decision.secondaryChangeTypes) {
    for (const question of CHANGE_TYPE_OBLIGATIONS[type] ?? []) questions.set(question.id, question);
  }
  for (const signal of decision.riskSignals) questions.set(RISK_OBLIGATIONS[signal].id, RISK_OBLIGATIONS[signal]);
  // Unanswered is the only honest starting state: nothing has been checked at
  // the point the questions are selected.
  return [...questions.values()].map((question) => ({ ...question, outcome: 'unresolved' as const, evidence: null }));
}

export function heaviestObligation(obligations: ReviewObligation[]): ObligationSettledBy {
  if (obligations.some((obligation) => obligation.settledBy === 'human')) return 'human';
  if (obligations.some((obligation) => obligation.settledBy === 'ai')) return 'ai';
  return 'proof';
}
