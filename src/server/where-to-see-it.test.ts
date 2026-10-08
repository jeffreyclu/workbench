import { describe, expect, it } from 'vitest';

import { namesUiSurface, writesClientFiles } from './final-response-policy.js';
import { supervisedRetryPrompt, superviseDraft, supervisorRetryError } from './supervisor.js';

const ANSWER = '## Problem\nThe tab was empty.\n\n## Solution\nFilled it.\n\n## Context\nChecked.';
const WITH_LINE = `${ANSWER}\nWhere to see it: Tasks screen, Review tab, with a completed run selected.`;

describe('where-to-see-it policy', () => {
  it('recognises client paths in each repository and ignores server and test files', () => {
    expect(writesClientFiles(['/w/workbench/src/client/App.tsx'])).toBe(true);
    expect(writesClientFiles(['/w/writer-monorepo/frontend/src/page.tsx'])).toBe(true);
    expect(writesClientFiles(['/d/.workbench-worktrees/fe.web-app-5b70ed090a0e/abc/src/view.tsx'])).toBe(true);
    expect(writesClientFiles(['/w/workbench/src/server/supervisor.ts'])).toBe(false);
    expect(writesClientFiles(['/w/workbench/src/client/App.test.tsx'])).toBe(false);
    expect(writesClientFiles([])).toBe(false);
  });

  it('requires the line to start a line and name something', () => {
    expect(namesUiSurface(WITH_LINE)).toBe(true);
    expect(namesUiSurface('Context: I mention Where to see it: nowhere')).toBe(false);
    expect(namesUiSurface(`${ANSWER}\nWhere to see it:`)).toBe(false);
  });

  it('retries a client-writing execute run without the line, once, without failing it', () => {
    const evidence = { investigated: true, executed: true, clientFilesWritten: true };
    const decision = superviseDraft('execute', ANSWER, evidence);
    expect(decision).toMatchObject({ accepted: false, code: 'missing_where_to_see_it' });
    if (decision.accepted) throw new Error('unreachable');
    expect(decision.recoveryRequirement).toContain('Where to see it:');
    expect(supervisedRetryPrompt('ORIGINAL TASK', decision)).not.toContain('ORIGINAL TASK');
    expect(supervisorRetryError(decision)).toBeNull();
  });

  it('accepts the line, and ignores server-only runs and non-execute runs', () => {
    expect(superviseDraft('execute', WITH_LINE, { investigated: true, executed: true, clientFilesWritten: true })).toEqual({ accepted: true });
    expect(superviseDraft('execute', ANSWER, { investigated: true, executed: true, clientFilesWritten: false })).toEqual({ accepted: true });
    expect(superviseDraft('execute', ANSWER, { investigated: true, executed: true })).toEqual({ accepted: true });
    expect(superviseDraft('analyze' as never, ANSWER, { investigated: true, executed: true, clientFilesWritten: true })).toEqual({ accepted: true });
  });
});
