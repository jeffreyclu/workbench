import { learningsFromEvents, type ObservedRunEvent } from './review-handoff.js';
import { isNonTrivialRun } from './work-log.js';

/** The one sentence an agent may answer with instead of recording a lesson. */
export const NOTHING_LEARNED_SENTENCE = 'Nothing non-obvious learned.';

export const CAPTURE_GATE_PROMPT = `Record any non-obvious finding with record_learning, or reply '${NOTHING_LEARNED_SENTENCE}'`;

export const CAPTURE_GATE_ISSUED_EVENT = 'capture gate: follow-up issued';
export const CAPTURE_GATE_SATISFIED_EVENT = 'capture gate: satisfied';

export type CaptureGateState = 'not_required' | 'recorded' | 'declared' | 'follow_up';

/**
 * Substantive work (eight tool uses or any file write) owes the shared memory
 * one lesson or an explicit "none". `follow_up` is the only state that asks
 * for another turn; the caller issues it at most once.
 */
export function captureGateState(events: ObservedRunEvent[], output: string): CaptureGateState {
  if (!isNonTrivialRun(events)) return 'not_required';
  if (learningsFromEvents(events).length > 0) return 'recorded';
  if (output.includes(NOTHING_LEARNED_SENTENCE)) return 'declared';
  return 'follow_up';
}

/** Handoff learnings[] line naming which path the gate took. */
export function captureGateHandoffLine(issued: boolean, state: CaptureGateState): string | undefined {
  if (state === 'not_required') return undefined;
  const outcome = state === 'recorded' ? 'lesson recorded' : state === 'declared' ? `"${NOTHING_LEARNED_SENTENCE}"` : 'no lesson or declaration';
  return `Capture gate: ${issued ? 'follow-up issued' : 'satisfied'}; ${outcome}`;
}
