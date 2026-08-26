import { describe, expect, it } from 'vitest';
import { parseDiffConfidenceAssessment } from './diff-confidence-ai.js';

describe('parseDiffConfidenceAssessment', () => {
  it('keeps only validated integer scores for every requested block', () => {
    expect(parseDiffConfidenceAssessment('{"assessments":{"a":82,"b":11,"extra":99}}', ['a', 'b'])).toEqual({ a: 82, b: 11 });
  });

  it('unwraps the Claude CLI JSON envelope before parsing the model result', () => {
    const output = JSON.stringify({
      type: 'result',
      is_error: false,
      result: '```json\n{"assessments":{"a":82,"b":11}}\n```',
    });

    expect(parseDiffConfidenceAssessment(output, ['a', 'b'])).toEqual({ a: 82, b: 11 });
  });

  it('rejects missing, fractional, and out-of-range scores', () => {
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":50}}', ['a', 'b'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":50.5}}', ['a'])).toThrow();
    expect(() => parseDiffConfidenceAssessment('{"assessments":{"a":101}}', ['a'])).toThrow();
  });
});
