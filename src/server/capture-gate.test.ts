import { describe, expect, it } from 'vitest';
import { CAPTURE_GATE_PROMPT, NOTHING_LEARNED_SENTENCE, captureGateHandoffLine, captureGateState } from './capture-gate.js';
import type { ObservedRunEvent } from './review-handoff.js';

const write: ObservedRunEvent = { category: 'agent_file_write', detail: 'update: src/app.ts', streamKind: 'file_write' };
const recordLearning: ObservedRunEvent = { category: 'agent_tool_use', detail: 'workbench.record_learning', streamKind: 'tool', result: '"Recorded [workbench-operating-practices.md#7]"' };

describe('captureGateState', () => {
  it('owes nothing for trivial work', () => {
    expect(captureGateState([], 'Done.')).toBe('not_required');
  });

  it('asks for exactly one follow-up when substantive work recorded nothing and declared nothing', () => {
    expect(captureGateState([write], 'Done.')).toBe('follow_up');
  });

  it('is satisfied by a declaration or by a recorded lesson', () => {
    expect(captureGateState([write], NOTHING_LEARNED_SENTENCE)).toBe('declared');
    expect(captureGateState([write, recordLearning], 'Done.')).toBe('recorded');
  });

  it('judges the follow-up turn together with the work turn, so one injected turn closes the gate', () => {
    const afterFollowUp = captureGateState([write, recordLearning], `Done.\n${NOTHING_LEARNED_SENTENCE}`);
    expect(afterFollowUp).toBe('recorded');
    expect(captureGateHandoffLine(true, afterFollowUp)).toBe('Capture gate: follow-up issued; lesson recorded');
  });

  it('reports an unanswered follow-up without issuing another', () => {
    expect(captureGateHandoffLine(true, captureGateState([write], 'Done.\nStill nothing said.'))).toBe('Capture gate: follow-up issued; no lesson or declaration');
    expect(CAPTURE_GATE_PROMPT).toContain(NOTHING_LEARNED_SENTENCE);
  });
});
