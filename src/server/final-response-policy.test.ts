import { describe, expect, it, vi } from 'vitest';

import { editFinalResponse, FINAL_RESPONSE_CONTRACT, finalResponsePolicyViolation } from './final-response-policy.js';

describe('final response policy', () => {
  it('rejects a multi-paragraph agent response', () => {
    expect(finalResponsePolicyViolation('Problem: The service is down.\n\nSolution: Restart it. Context: Not verified.'))
      .toBe('The response uses more than one line or paragraph.');
  });

  it('requires the problem, solution, and context in one short paragraph', () => {
    expect(finalResponsePolicyViolation('Problem: The service is down. Solution: Restart it. Context: Health is not verified.')).toBeNull();
    expect(finalResponsePolicyViolation('Restart the service.')).toContain('Problem, Solution, Context');
    expect(FINAL_RESPONSE_CONTRACT).toContain('plain-English paragraph');
  });

  it('edits a rejected draft and validates the replacement before delivery', async () => {
    const editor = vi.fn(async () => 'Problem: The local app was down. Solution: Restarted it. Context: Health returned 200.');
    const output = await editFinalResponse('The daemon failed.\n\nI restarted several processes.', 'Restart the local app.', editor);

    expect(output).toBe('Problem: The local app was down. Solution: Restarted it. Context: Health returned 200.');
    expect(editor).toHaveBeenCalledWith(expect.stringContaining('Agent draft:'));
  });

  it('fails closed when the editor still returns multiple paragraphs', async () => {
    await expect(editFinalResponse('Long draft.', 'Explain the failure.', async () => 'Problem: A.\n\nSolution: B. Context: C.'))
      .rejects.toThrow('Response editor failed');
  });
});
