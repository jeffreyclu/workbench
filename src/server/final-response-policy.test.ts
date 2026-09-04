import { describe, expect, it, vi } from 'vitest';

import { editFinalResponse, fallbackFinalResponse, FINAL_RESPONSE_CONTRACT, finalResponsePolicyViolation, verboseResponseRequested } from './final-response-policy.js';

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

  it('allows a multi-paragraph answer only for an explicit verbose request', async () => {
    const verbose = 'Problem: The service is down.\n\nSolution: Restart it and inspect the logs.\n\nContext: The health route has not been checked.';
    expect(verboseResponseRequested('Give me a verbose response explaining this.')).toBe(true);
    expect(verboseResponseRequested("Don't be verbose; give me the short answer.")).toBe(false);
    expect(finalResponsePolicyViolation(verbose)).not.toBeNull();
    expect(finalResponsePolicyViolation(verbose, true)).toBeNull();

    const editor = vi.fn(async () => verbose);
    await expect(editFinalResponse('Draft.', 'Explain it verbosely.', { verbose: true }, editor)).resolves.toBe(verbose);
    expect(editor).toHaveBeenCalledWith(expect.stringContaining('VERBOSITY: VERBOSE'));
  });

  it('edits a rejected draft and validates the replacement before delivery', async () => {
    const editor = vi.fn(async () => 'Problem: The local app was down. Solution: Restarted it. Context: Health returned 200.');
    const output = await editFinalResponse('The daemon failed.\n\nI restarted several processes.', 'Restart the local app.', editor);

    expect(output).toBe('Problem: The local app was down. Solution: Restarted it. Context: Health returned 200.');
    expect(editor).toHaveBeenCalledWith(expect.stringContaining('Agent draft:'));
  });

  it('keeps the completed result when the editor times out', async () => {
    const output = await editFinalResponse('The service was restarted.\n\nHealth returned 200.', 'Restart the service.', async () => {
      throw new Error('Haiku response editor timed out after 30s.');
    });
    expect(finalResponsePolicyViolation(output)).toBeNull();
    expect(output).toContain('The service was restarted. Health returned 200.');
    expect(output).toContain('language editor was unavailable');
  });

  it('keeps the fallback under the hard word limit', () => {
    const output = fallbackFinalResponse(new Array(200).fill('detail').join(' '), new Array(100).fill('request').join(' '));
    expect(finalResponsePolicyViolation(output)).toBeNull();
  });
});
