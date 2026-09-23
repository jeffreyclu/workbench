import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../shared/contracts.js';
import type { ExternalActionAuthorization } from './external-action-authorization.js';
import {
  finalizeSupervisedOutput,
  githubSourceAuthorityForRequest,
  missingReviewPasses,
  superviseDraft,
  superviseExternalAction,
  supervisedRetryPrompt,
  supervisorRetryError,
  supervisorPromptContract,
  supervisorSynthesisContract,
  currentTurnAuthorityContract,
  isStatusOnlyTurn,
} from './supervisor.js';

const kinds: AgentRun['kind'][] = ['analysis', 'research', 'strategy', 'review', 'bugfix', 'execute'];

const completeReview = [1, 2, 3, 4, 5].map((pass) => (
  `### Pass ${pass}\n\n${pass === 1 ? 'Blocking: src/button.ts:42 drops the click handler. Preserve the handler.' : 'No material issues.'}`
)).join('\n\n');

describe('Workbench supervisor', () => {
  it('distinguishes status-only questions from explicit continuation', () => {
    expect(isStatusOnlyTurn("so what's the status?")).toBe(true);
    expect(isStatusOnlyTurn("what's the current status.")).toBe(true);
    expect(isStatusOnlyTurn('where do things stand')).toBe(true);
    expect(isStatusOnlyTurn('why is this still stuck?')).toBe(true);
    expect(isStatusOnlyTurn('show status and then continue')).toBe(false);
    expect(isStatusOnlyTurn('why is this stuck? fix it')).toBe(false);
    expect(currentTurnAuthorityContract("what's the status")).toContain('Do not resume an older plan');
    expect(currentTurnAuthorityContract('continue the run')).toBe('');
  });
  it.each(kinds)('makes the selected %s category authoritative', (kind) => {
    const prompt = supervisorPromptContract(kind, 'Execute something that sounds like a different category.');
    expect(prompt).toContain(`Supervisor-selected execution category: ${kind}`);
    expect(prompt).toContain('must not be inferred again from the request text');
  });

  it.each(kinds)('gives every %s agent one canonical local document root', (kind) => {
    const prompt = supervisorPromptContract(kind, 'Handle the request.');
    expect(prompt).toContain('~/Documents/Workbench');
    expect(prompt).toContain('~/notes is a compatibility symlink only');
    expect(prompt).toContain('Repository-owned documentation stays in that repository');
  });

  it.each(kinds)('requires every %s agent to write code only in ~/dev worktrees', (kind) => {
    const prompt = supervisorPromptContract(kind, 'Handle the request.');
    expect(prompt).toContain('Every code edit must be made in a dedicated Git worktree under ~/dev');
    expect(prompt).toContain("Never write code in a repository's primary checkout");
    expect(prompt).toContain('reuse an existing ~/dev worktree whose branch matches the task or ticket');
    expect(prompt).toContain('Never create a duplicate detached worktree');
    expect(prompt).toContain('one ~/dev worktree per repository');
  });

  it('owns the complete five-pass review contract and authoritative GitHub source', () => {
    const request = 'review https://github.com/WriterColab/writer-monorepo/pull/16623';
    const prompt = supervisorPromptContract('review', request);

    expect(prompt).toContain('### Pass 1');
    expect(prompt).toContain('### Pass 5');
    expect(prompt).toContain('Does it work?');
    expect(prompt).toContain('never exceed 350 words');
    expect(prompt).toContain('No material issues.');
    expect(prompt).toContain('base and head commit SHAs');
    expect(prompt).toContain('https://github.com/WriterColab/writer-monorepo/pull/16623');
    expect(githubSourceAuthorityForRequest(request, 'review')).toContain('source of truth');
  });

  it.each(kinds.filter((kind) => kind !== 'review'))('does not leak the review persona into %s', (kind) => {
    expect(supervisorPromptContract(kind, 'review this')).not.toContain('frontend-reviewer');
  });

  it.each(kinds.filter((kind) => kind !== 'review'))('keeps an explicit GitHub PR authoritative for %s', (kind) => {
    const prompt = supervisorPromptContract(kind, 'Use https://github.com/WriterColab/writer-monorepo/pull/16623');
    expect(prompt).toContain('PR URL: https://github.com/WriterColab/writer-monorepo/pull/16623');
    expect(prompt).toContain('source of truth');
  });

  it('accepts only review passes that contain findings or the exact empty-pass result', () => {
    expect(missingReviewPasses(completeReview)).toEqual([]);
    expect(missingReviewPasses('### Pass 1\nPass completed.')).toEqual([1, 2, 3, 4, 5]);
    expect(superviseDraft('review', completeReview, { investigated: true, executed: false })).toEqual({ accepted: true });
  });

  it('returns one concrete recovery requirement for every harness violation', () => {
    expect(superviseDraft('analysis', 'Tell me the specific error.', { investigated: false, executed: false }))
      .toMatchObject({ accepted: false, code: 'premature_evidence_request' });
    expect(superviseDraft('execute', 'Say the word and I will implement it.', { investigated: true, executed: false }))
      .toMatchObject({ accepted: false, code: 'deferred_execution' });
    expect(superviseDraft('execute', 'The fix is in and works end-to-end.', { investigated: true, executed: false }))
      .toMatchObject({ accepted: false, code: 'unverified_completion' });
    expect(superviseDraft('analysis', 'The behavior comes from src/state.ts:12.', { investigated: true, executed: false }))
      .toEqual({ accepted: true });
    expect(superviseDraft('execute', 'The CI job timed out after 9 tests passed and 1 did not run.', { investigated: true, executed: false }))
      .toEqual({ accepted: true });
  });

  it('enforces the same 120-word limit without replaying an execute turn that already mutated state', () => {
    const longDraft = Array.from({ length: 121 }, (_, index) => `word${index}`).join(' ');
    for (const kind of kinds.filter((candidate) => candidate !== 'review' && candidate !== 'execute')) {
      expect(superviseDraft(kind, longDraft, { investigated: true, executed: true }))
        .toMatchObject({ accepted: false, code: 'response_style' });
      expect(superviseDraft(kind, longDraft, { investigated: true, executed: true }, { verbose: true }))
        .toEqual({ accepted: true });
    }
    const executed = superviseDraft('execute', longDraft, { investigated: true, executed: true });
    expect(executed).toMatchObject({ accepted: false, code: 'response_style' });
    if (executed.accepted) throw new Error('Expected a response-style rejection.');
    const retry = supervisedRetryPrompt('ORIGINAL EXECUTABLE TASK', executed);
    expect(retry).not.toContain('ORIGINAL EXECUTABLE TASK');
    expect(retry).toContain('Do not call tools');
    expect(retry).toContain('Target 90 words and never exceed 120');
    expect(retry).toContain('Rejected draft:');
    expect(supervisorRetryError(executed)).toBeNull();
    expect(superviseDraft('execute', longDraft, { investigated: true, executed: false }))
      .toMatchObject({ accepted: false, code: 'response_style' });
  });

  it('never fails a completed turn only because its brevity retry is still long', () => {
    const longDraft = Array.from({ length: 168 }, (_, index) => `word${index}`).join(' ');
    const styleDecision = superviseDraft('analysis', longDraft, { investigated: true, executed: true });
    expect(styleDecision).toMatchObject({ accepted: false, code: 'response_style' });
    expect(supervisorRetryError(styleDecision)).toBeNull();

    const substantiveDecision = superviseDraft('execute', 'Say the word and I will implement it.', { investigated: true, executed: false });
    expect(substantiveDecision).toMatchObject({ accepted: false, code: 'deferred_execution' });
    expect(supervisorRetryError(substantiveDecision)).toContain('rejected after one automatic supervisor retry');
  });

  it('keeps complete five-pass reviews but rejects dense review prose', () => {
    const dense = `${completeReview}\n\n${Array.from({ length: 360 }, (_, index) => `detail${index}`).join(' ')}`;
    expect(superviseDraft('review', dense, { investigated: true, executed: false }))
      .toMatchObject({ accepted: false, code: 'response_style' });
  });

  it('preserves complete review passes through final formatting', async () => {
    const output = await finalizeSupervisedOutput({
      kind: 'review',
      rawOutput: completeReview,
      objective: 'Review the PR.',
      verbose: false,
    });
    expect(output).toContain('### Pass 1');
    expect(output).toContain('### Pass 5');
    expect(output).toContain('Blocking: src/button.ts:42');
  });

  it('gives review synthesis the same five-pass contract', () => {
    expect(supervisorSynthesisContract('review')).toContain('### Pass 1');
    expect(supervisorSynthesisContract('review')).toContain('### Pass 5');
    expect(supervisorSynthesisContract('review')).toContain('never exceed 350 words');
    expect(supervisorSynthesisContract('analysis')).not.toContain('five-pass');
  });

  it('persists a conversation capability and preflights its exact tools before returning it', async () => {
    const fresh = {
      granted: true,
      operation: 'Create the requested Linear ticket.',
      capability: {
        actionIds: ['linear_create'],
        command: 'create the Linear ticket',
        requiredExecutables: [],
        requiredWorkbenchTools: ['create_linear_issue'],
        source: 'direct_command',
      },
    } satisfies ExternalActionAuthorization;
    const resolveConversationAuthorization = vi.fn((_conversationId: string, authorization: ExternalActionAuthorization) => authorization);
    const preflightWorkbenchTools = vi.fn(async () => undefined);

    const resolved = await superviseExternalAction({
      conversationId: 'conversation-1',
      freshAuthorization: fresh,
      resolveConversationAuthorization,
      preflightWorkbenchTools,
      path: '',
    });

    expect(resolved).toEqual(fresh);
    expect(resolveConversationAuthorization).toHaveBeenCalledWith('conversation-1', fresh);
    expect(preflightWorkbenchTools).toHaveBeenCalledWith(['create_linear_issue']);
  });

  it('fails before provider execution when an authorized executable is missing', async () => {
    const authorization = {
      granted: true,
      operation: 'Run it.',
      capability: {
        actionIds: ['external_mutation'],
        command: 'run it',
        requiredExecutables: ['definitely-not-a-real-workbench-executable'],
        requiredWorkbenchTools: [],
        source: 'direct_command',
      },
    } satisfies ExternalActionAuthorization;
    const preflightWorkbenchTools = vi.fn(async () => undefined);

    await expect(superviseExternalAction({
      conversationId: null,
      freshAuthorization: authorization,
      preflightWorkbenchTools,
      path: '',
    })).rejects.toThrow('Missing executables: definitely-not-a-real-workbench-executable');
    expect(preflightWorkbenchTools).not.toHaveBeenCalled();
  });
});
