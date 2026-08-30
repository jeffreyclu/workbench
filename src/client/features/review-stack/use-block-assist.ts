import { useCallback, useState } from 'react';

export type BlockAssistAnswers = ReadonlyMap<string, readonly (string | null | undefined)[]>;

function sameAnswers(left: readonly (string | null | undefined)[] | undefined, right: readonly (string | null | undefined)[]): boolean {
  return Boolean(left) && left!.length === right.length && left!.every((answer, index) => answer === right[index]);
}

/**
 * The assist answers this session has seen, by block.
 *
 * They accumulate rather than tracking the open block, because an escalation
 * has to outlive the visit that produced it: a block the model could not
 * settle must still read as escalated after the reviewer moves on, or the
 * queue would silently re-price it the moment it left the screen.
 *
 * Answers are dropped when the revision changes. They are statements about
 * specific code, and carrying them onto a rewritten diff would escalate a
 * block on the strength of an answer given about something else.
 */
export function useBlockAssistAnswers(revision: string | undefined): {
  answers: BlockAssistAnswers;
  remember: (decisionId: string, answers: readonly (string | null | undefined)[]) => void;
} {
  const [state, setState] = useState<{ revision: string | undefined; answers: Map<string, readonly (string | null | undefined)[]> }>(
    () => ({ revision, answers: new Map() }),
  );
  const remember = useCallback((decisionId: string, answers: readonly (string | null | undefined)[]) => {
    setState((previous) => {
      const stale = previous.revision !== revision;
      const base = stale ? new Map<string, readonly (string | null | undefined)[]>() : previous.answers;
      // Nothing cached for a block yet is the common case on first open, and
      // storing it would hand back a new Map on every render — a render loop
      // rather than an escalation.
      if (answers.length === 0 && !base.has(decisionId)) return stale ? { revision, answers: base } : previous;
      if (!stale && sameAnswers(base.get(decisionId), answers)) return previous;
      const next = new Map(base);
      next.set(decisionId, answers);
      return { revision, answers: next };
    });
  }, [revision]);
  return { answers: state.answers, remember };
}
