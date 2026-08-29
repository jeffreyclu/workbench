import { describe, expect, it } from 'vitest';
import { reviewAssistRequestSchema, REVIEW_ASSIST_MAX_HUNKS, REVIEW_ASSIST_MAX_LINES_PER_HUNK, REVIEW_ASSIST_MAX_LINE_LENGTH } from './contracts.js';
import { reviewAssistDecisionPayload, type ReviewDecision, type ReviewDecisionHunk } from './review-decisions.js';

function hunk(index: number, lines: string[]): ReviewDecisionHunk {
  return {
    id: `src/example.ts::${index}`,
    filePath: 'src/example.ts',
    fileStatus: 'modified',
    editorUrl: null,
    hunkRange: `@@ -${index},1 +${index},1 @@`,
    location: `Line ${index}`,
    lines,
    additions: 1,
    deletions: 1,
    state: null,
    note: null,
  };
}

describe('reviewAssistDecisionPayload', () => {
  it('always produces a payload accepted by the review-assist wire contract', () => {
    const oversizedLines = Array.from({ length: 260 }, (_, index) => index === 130 ? `+${'x'.repeat(5_000)}` : `+line ${index}`);
    const hunks = Array.from({ length: 55 }, (_, index) => hunk(index + 1, index === 0 ? oversizedLines : ['+change']));
    const decision: ReviewDecision = {
      id: 'decision:oversized', ordinal: 1, subject: 'oversized', behavior: 'Changes oversized.', hunks,
      filePaths: ['src/example.ts'], additions: 55, deletions: 55, riskSignals: [], changeType: 'behavior_edit',
      secondaryChangeTypes: [], state: null, note: null,
    };

    const payload = reviewAssistDecisionPayload(decision, [decision]);

    expect(reviewAssistRequestSchema.safeParse({ action: 'score_risk', decision: payload, taskIntent: null }).success).toBe(true);
    expect(payload.hunks).toHaveLength(REVIEW_ASSIST_MAX_HUNKS);
    expect(payload.hunks[0].lines).toHaveLength(REVIEW_ASSIST_MAX_LINES_PER_HUNK);
    expect(Math.max(...payload.hunks.flatMap((item) => item.lines.map((line) => line.length)))).toBeLessThanOrEqual(REVIEW_ASSIST_MAX_LINE_LENGTH);
    expect(payload.hunks[0].lines.some((line) => line.includes('diff lines omitted'))).toBe(true);
  });

  it('normalizes an oversized payload from a tab opened before the current release', () => {
    const oldClientPayload = {
      action: 'score_risk',
      decision: {
        behavior: 'Changes a large hunk.', state: 'Pending', changeType: 'behavior_edit', secondaryChangeTypes: [],
        hunks: [{ filePath: 'src/example.ts', location: 'Line 1', lines: Array.from({ length: 260 }, (_, index) => `+line ${index}`) }],
        coverageEvidence: { symbols: [], hunks: [], uncitedSymbols: [] },
        referenceEvidence: { symbols: [], hunks: [], residualSymbols: [], clearedSymbols: [] },
      },
      taskIntent: null,
    };

    const parsed = reviewAssistRequestSchema.parse(oldClientPayload);

    expect(parsed.decision.hunks[0].lines).toHaveLength(REVIEW_ASSIST_MAX_LINES_PER_HUNK);
    expect(parsed.decision.hunks[0].lines.some((line) => line.includes('diff lines omitted'))).toBe(true);
  });
});
