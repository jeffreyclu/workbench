import { describe, expect, it } from 'vitest';
import { authoritativeMutationLineageProblem, authoritativeTicketIdentifier, isPublishOnlyCommand } from './external-mutation-lineage.js';

describe('authoritative external-mutation lineage', () => {
  it('extracts the linked Linear ticket as the durable task identity', () => {
    expect(authoritativeTicketIdentifier({ sourceIdentifier: null, sourceUrl: 'https://linear.app/writer/issue/CON-214/show-custom-domain' })).toBe('CON-214');
  });

  it('blocks publishing a branch that belongs to another ticket', () => {
    expect(authoritativeMutationLineageProblem({ ticket: 'CON-214', branch: 'fix/CON-221-connector-card-identity-revoke', publishOnly: true, hasCompletedExecution: true }))
      .toContain('conflicts with branch');
  });

  it('blocks a publish-only follow-up when the implementation never completed', () => {
    expect(authoritativeMutationLineageProblem({ ticket: 'CON-214', branch: 'jeffrey/CON-214-private-endpoint', publishOnly: true, hasCompletedExecution: false }))
      .toContain('no completed Workbench execution');
  });

  it('permits a matching completed implementation and does not block combined implementation commands', () => {
    expect(authoritativeMutationLineageProblem({ ticket: 'CON-214', branch: 'jeffrey/CON-214-private-endpoint', publishOnly: true, hasCompletedExecution: true })).toBeNull();
    expect(isPublishOnlyCommand('fix the implementation, push it, and open a draft PR')).toBe(false);
    expect(isPublishOnlyCommand('push and open a draft PR')).toBe(true);
  });
});
