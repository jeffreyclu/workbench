import { describe, expect, it } from 'vitest';
import { parseDiffConfidenceAssessment } from './diff-confidence-ai.js';

describe('parseDiffConfidenceAssessment', () => {
  it('keeps only validated integer scores for every requested block', () => {
    expect(parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":82,"reasoning":"Visible guard covers the branch."},"b":{"confidence":11,"reasoning":"No visible caller checks the result."},"extra":{"confidence":99,"reasoning":"Ignored."}}}', ['a', 'b'])).toEqual({ a: { confidence: 82, reasoning: 'Visible guard covers the branch.' }, b: { confidence: 11, reasoning: 'No visible caller checks the result.' } });
  });

  it('unwraps the Claude CLI JSON envelope before parsing the model result', () => {
    const output = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '```json\n{"assessments":{"a":{"confidence":82,"reasoning":"Visible path is covered."},"b":{"confidence":11,"reasoning":"No visible test covers this."}}}\n```',
    });

    expect(parseDiffConfidenceAssessment(output, ['a', 'b'])).toEqual({ a: { confidence: 82, reasoning: 'Visible path is covered.' }, b: { confidence: 11, reasoning: 'No visible test covers this.' } });
  });

  it('rejects missing, fractional, and out-of-range scores', () => {
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":50,"reasoning":"Covered."}}}', ['a', 'b'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":50.5,"reasoning":"Covered."}}}', ['a'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":101,"reasoning":"Covered."}}}', ['a'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":{"confidence":50,"reasoning":""}}}', ['a'])).toThrow();
  });
});
