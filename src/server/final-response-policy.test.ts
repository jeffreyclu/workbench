import { describe, expect, it, vi } from 'vitest';

import { editFinalResponse, fallbackFinalResponse, FINAL_RESPONSE_CONTRACT, finalResponsePolicyViolation, normalizeFinalResponse, responseStyleViolation, verboseResponseRequested } from './final-response-policy.js';

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

  it('preserves readable paragraphs while recognizing an explicit verbose request', async () => {
    const verbose = '## Problem\nThe service is down.\n\n## Solution\nRestart it.\n\nThen inspect the logs.\n\n## Context\nThe health route has not been checked.';
    expect(verboseResponseRequested('Give me a verbose response explaining this.')).toBe(true);
    expect(verboseResponseRequested("Don't be verbose; give me the short answer.")).toBe(false);
    expect(finalResponsePolicyViolation(verbose)).toBeNull();
    expect(finalResponsePolicyViolation(verbose, true)).toBeNull();

    const editor = vi.fn(async () => verbose);
    await expect(editFinalResponse(verbose, 'Explain it verbosely.', { verbose: true }, editor)).resolves.toBe(verbose);
    expect(editor).not.toHaveBeenCalled();
  });

  it('makes brevity measurable while honoring only an explicit per-turn override', () => {
    const long = Array.from({ length: 121 }, (_, index) => `word${index}`).join(' ');
    expect(responseStyleViolation(long)).toContain('non-verbose limit is 120');
    expect(responseStyleViolation(long, { verbose: true })).toBeNull();
  });

  it('does not reject a concise review because one evidence bullet is long', () => {
    const review = `## Problem\nOne blocking issue was found.\n\n## Solution\n- The migration writes both old and new records before switching readers, but the linked rollback path still reads only the old record and needs to be updated before merge: [src/server/migrate.ts:42](https://github.com/example/repository/blob/abcdef/src/server/migrate.ts#L42).\n\n## Context\nThe rest of the diff is non-blocking.`;

    expect(responseStyleViolation(review, { review: true })).toBeNull();
  });

  it('removes a decision preamble without flattening section lists', () => {
    const draft = `Decision: answer directly.\n\n## Problem\nHardware roles are buried in software listings.\n\n## Solution\nUse targeted sources:\n\n1. [IEEE Job Site](https://jobs.ieee.org)\n2. [iHireEngineering](https://www.ihireengineering.com)\n\n## Context\nPrioritize the specialist boards.`;
    const normalized = normalizeFinalResponse(draft);

    expect(normalized).not.toContain('Decision:');
    expect(normalized).toContain('## Solution\nUse targeted sources:\n\n1. [IEEE Job Site]');
    expect(normalized).toContain('2. [iHireEngineering]');
    expect(finalResponsePolicyViolation(normalized)).toBeNull();
  });

  it('formats a rejected draft locally without another model turn', async () => {
    const editor = vi.fn(async () => '## Problem\nThe local app was down.\n\n## Solution\nRestarted it.\n\n## Context\nHealth returned 200.');
    const output = await editFinalResponse('The daemon failed.\n\nI restarted several processes.', 'Restart the local app.', editor);

    expect(output).toBe('## Problem\nRestart the local app.\n\n## Solution\nThe daemon failed.\n\nI restarted several processes.\n\n## Context\nNo additional context.');
    expect(editor).not.toHaveBeenCalled();
  });

  it('keeps the completed result without calling the supplied editor', async () => {
    const editor = vi.fn(async () => { throw new Error('must not run'); });
    const output = await editFinalResponse('The service was restarted.\n\nHealth returned 200.', 'Restart the service.', editor);
    expect(finalResponsePolicyViolation(output)).toBeNull();
    expect(output).toContain('The service was restarted.\n\nHealth returned 200.');
    expect(output).toContain('## Context\nNo additional context.');
    expect(output).not.toContain('editor');
    expect(editor).not.toHaveBeenCalled();
  });

  it('never cuts off a long completed result to meet the length target', () => {
    const draft = `${Array.from({ length: 160 }, (_, index) => `result-${index}`).join(' ')} FINAL-RESULT`;
    const output = fallbackFinalResponse(draft, 'Report every result.');

    expect(output).toContain('result-0');
    expect(output).toContain('result-159 FINAL-RESULT');
    expect(output).not.toContain('…');
    expect(finalResponsePolicyViolation(output)).toBeNull();
  });

  it('preserves Markdown lists when wrapping an unstructured final answer', () => {
    const draft = 'Test the fixed flow:\n\n1. Open **Connectors**.\n2. Submit the DCR form.\n3. Confirm `kind: "dcr"` in the request.';
    const output = fallbackFinalResponse(draft, 'Explain how to test the feature.');

    expect(output).toContain('## Solution\nTest the fixed flow:\n\n1. Open **Connectors**.');
    expect(output).toContain('2. Submit the DCR form.');
    expect(output).toContain('3. Confirm `kind: "dcr"` in the request.');
  });
});
