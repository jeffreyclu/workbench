import { describe, expect, it, vi } from 'vitest';

import { editFinalResponse, fallbackFinalResponse, FINAL_RESPONSE_CONTRACT, finalResponsePolicyViolation, normalizeFinalResponse, verboseResponseRequested } from './final-response-policy.js';

describe('final response policy', () => {
  it('rejects inline labels that render as one long paragraph', () => {
    expect(finalResponsePolicyViolation('Problem: The service is down. Solution: Restart it. Context: Not verified.'))
      .toBe('The response does not use separate Problem, Solution, and Context sections in that order.');
  });

  it('converts inline labels into valid sections without a model call', () => {
    const normalized = normalizeFinalResponse('Problem: Reports differ. Solution: Reconcile them. Context: No files changed.');
    expect(normalized).toBe('## Problem\nReports differ.\n\n## Solution\nReconcile them.\n\n## Context\nNo files changed.');
    expect(finalResponsePolicyViolation(normalized)).toBeNull();
  });

  it('requires three short problem, solution, and context sections', () => {
    expect(finalResponsePolicyViolation('## Problem\nThe service is down.\n\n## Solution\nRestart it.\n\n## Context\nHealth is not verified.')).toBeNull();
    expect(finalResponsePolicyViolation('Restart the service.')).toContain('Problem, Solution, and Context');
    expect(FINAL_RESPONSE_CONTRACT).toContain('exactly three Markdown sections');
  });

  it('allows a multi-paragraph answer only for an explicit verbose request', async () => {
    const verbose = '## Problem\nThe service is down.\n\n## Solution\nRestart it.\n\nThen inspect the logs.\n\n## Context\nThe health route has not been checked.';
    expect(verboseResponseRequested('Give me a verbose response explaining this.')).toBe(true);
    expect(verboseResponseRequested("Don't be verbose; give me the short answer.")).toBe(false);
    expect(finalResponsePolicyViolation(verbose)).not.toBeNull();
    expect(finalResponsePolicyViolation(verbose, true)).toBeNull();

    const editor = vi.fn(async () => verbose);
    await expect(editFinalResponse('Draft.', 'Explain it verbosely.', { verbose: true }, editor)).resolves.toBe(verbose);
    expect(editor).toHaveBeenCalledWith(expect.stringContaining('VERBOSITY: VERBOSE'));
  });

  it('edits a rejected draft and validates the replacement before delivery', async () => {
    const editor = vi.fn(async () => '## Problem\nThe local app was down.\n\n## Solution\nRestarted it.\n\n## Context\nHealth returned 200.');
    const output = await editFinalResponse('The daemon failed.\n\nI restarted several processes.', 'Restart the local app.', editor);

    expect(output).toBe('## Problem\nThe local app was down.\n\n## Solution\nRestarted it.\n\n## Context\nHealth returned 200.');
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
