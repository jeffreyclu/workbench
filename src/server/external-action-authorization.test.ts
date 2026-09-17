import { describe, expect, it } from 'vitest';
import { EXTERNAL_ACTION_COMMANDS, classifyExternalActionAuthorization, externalActionAttempted, hasUnsupportedCapabilityDenial, mergeExternalActionAuthorizations, missingRequiredExecutables } from './external-action-authorization.js';

const authorizedCommands = [
  'commit all changes',
  'amend the commit',
  'ok push',
  'force-push the branch',
  'delete the remote branch',
  'open a PR',
  'open another draft pr',
  'update PR #15135 description',
  'approve the PR',
  'merge the pull request',
  'create a GitHub issue',
  'rerun the GitHub workflow',
  'publish the GitHub release',
  'write a Linear ticket',
  'create two Linear tickets',
  'create the two authorized Linear tickets',
  'create the tickets in Linear',
  'update the Linear issue',
  'rewrite the Linear ticket',
  'RE-WRITE THE FUCKING TICKET TO BE LESS WORDY',
  'the LINEAR TICKET YOU JUST MADE IS TOO FUCKING WORDY',
  'create a Jira ticket',
  'post the message to Slack',
  'write a Confluence page',
  'create a Notion page',
  'update the Google doc',
  'publish the file to the artifact library',
  'promote when ready',
  'deploy the app to production',
  'send the email',
  'npm publish',
  'edit the Figma design',
  'gcloud deploy the service',
  'call the API to update the record',
  'the FE PR and branch needs to be relinked to CON-230',
];

describe('external action authorization command catalog', () => {
  it.each(authorizedCommands)('authorizes the direct command: %s', async (currentMessage) => {
    await expect(classifyExternalActionAuthorization({ currentMessage })).resolves.toEqual(expect.objectContaining({ granted: true }));
  });

  it('contains a named rule for every supported mutation family', () => {
    expect(EXTERNAL_ACTION_COMMANDS.map((rule) => rule.id)).toEqual([
      'commit', 'push', 'remote_branch', 'pr_create', 'pr_update', 'pr_review', 'pr_lifecycle',
      'github_issue', 'github_workflow', 'github_release', 'linear_create', 'linear_update',
      'project_tracker', 'slack_message', 'confluence', 'notion', 'google_workspace', 'artifact',
      'promotion', 'deployment', 'email', 'package_publish', 'figma', 'cloud', 'external_api',
    ]);
  });

  it.each([
    'why are the agents not pushing?',
    "why can't you create a Linear ticket?",
    'these agents cannot push',
    'did you push?',
    'do not push',
    'push is broken again',
    'can you explain why the push failed?',
    'we need a rule so agents can push',
    'write linear ticket is another one',
    'the command list should include "open PR"',
  ])('does not mistake discussion, status, negation, or examples for a grant: %s', async (currentMessage) => {
    await expect(classifyExternalActionAuthorization({ currentMessage })).resolves.toEqual({ granted: false, operation: null });
  });

  it.each(['yes', 'do it', 'approve it', 'permission granted', 'go ahead and do it'])('authorizes a terse approval only against the immediately pending operation: %s', async (currentMessage) => {
    await expect(classifyExternalActionAuthorization({
      currentMessage,
      precedingAgentMessage: 'The backend branch is ready; I need authorization to push it to origin.',
    })).resolves.toEqual(expect.objectContaining({ granted: true }));
    await expect(classifyExternalActionAuthorization({ currentMessage })).resolves.toEqual({ granted: false, operation: null });
  });

  it('carries the immediately preceding Linear operation through an emphatic addressed follow-up', async () => {
    await expect(classifyExternalActionAuthorization({
      currentMessage: 'YOU FCKING DO IT CODEX',
      precedingHumanMessage: 'I AM AUTHORIZING YOU TO CREATE THE TICKETS IN LINEAR',
      precedingAgentMessage: 'I cannot create the two Linear tickets without a mutation capability.',
    })).resolves.toEqual(expect.objectContaining({
      granted: true,
      operation: expect.stringMatching(/Create the requested Linear ticket.*create_linear_issue/),
    }));
  });

  it('treats opening a draft PR as authorization for its required branch push', async () => {
    const authorization = await classifyExternalActionAuthorization({
      currentMessage: 'open another draft pr',
    });
    expect(authorization).toEqual(expect.objectContaining({
      granted: true,
      operation: expect.stringMatching(/Push the named branch if needed and create or open the named pull request/),
      capability: expect.objectContaining({ requiredExecutables: ['git', 'gh'] }),
    }));
    expect(missingRequiredExecutables(authorization, '')).toEqual(['git', 'gh']);
  });

  it.each([
    'spin up one more draft GitHub PR for this branch',
    'please put this into Linear as a ticket',
    'can you publish this in Confluence now',
    'I need you to post that update in Slack',
  ])('grants a scoped external mutation despite wording modifiers: %s', async (currentMessage) => {
    await expect(classifyExternalActionAuthorization({ currentMessage })).resolves.toEqual(expect.objectContaining({
      granted: true,
      capability: expect.objectContaining({ command: currentMessage, source: 'direct_command' }),
    }));
  });

  it('attaches the exact required Workbench tool to a Linear creation capability', async () => {
    const authorization = await classifyExternalActionAuthorization({ currentMessage: 'please put this into Linear as a ticket' });
    expect(authorization).toEqual(expect.objectContaining({
      granted: true,
      capability: expect.objectContaining({ actionIds: ['linear_create'], requiredWorkbenchTools: ['create_linear_issue'] }),
    }));
    expect(externalActionAttempted(authorization, ['mcp__workbench__create_linear_issue'])).toBe(true);
  });

  it.each([
    'rewrite the Linear ticket',
    'RE-WRITE THE FUCKING TICKET TO BE LESS WORDY',
    'the LINEAR TICKET YOU JUST MADE IS TOO FUCKING WORDY',
  ])('attaches the Linear update tool to the corrective command: %s', async (currentMessage) => {
    await expect(classifyExternalActionAuthorization({ currentMessage })).resolves.toEqual(expect.objectContaining({
      granted: true,
      capability: expect.objectContaining({ actionIds: ['linear_update'], requiredWorkbenchTools: ['update_linear_issue'] }),
    }));
  });

  it('treats an immediate complaint about a just-created Linear ticket as an update command', async () => {
    await expect(classifyExternalActionAuthorization({
      currentMessage: "brooo that's so fucking wordy",
      precedingAgentMessage: 'Filed CON-420 — https://linear.app/writer/issue/CON-420/example',
    })).resolves.toEqual(expect.objectContaining({
      granted: true,
      capability: expect.objectContaining({ actionIds: ['linear_update'], requiredWorkbenchTools: ['update_linear_issue'], source: 'terse_followup' }),
    }));
  });

  it('combines active conversation grants without widening beyond their named actions and tools', async () => {
    const push = await classifyExternalActionAuthorization({ currentMessage: 'push the branch' });
    const linear = await classifyExternalActionAuthorization({ currentMessage: 'rewrite the Linear ticket' });
    const combined = mergeExternalActionAuthorizations([push, linear]);

    expect(combined).toEqual(expect.objectContaining({
      granted: true,
      capability: expect.objectContaining({
        actionIds: ['push', 'linear_update'],
        requiredExecutables: ['git'],
        requiredWorkbenchTools: ['update_linear_issue'],
      }),
    }));
  });

  it.each([
    'I cannot create it because no supervisor-issued mutation capability exists.',
    'The required write tool is not exposed in the registry.',
    'I am blocked from creating the ticket.',
  ])('rejects an unsupported blocker claim: %s', (output) => {
    expect(hasUnsupportedCapabilityDenial(output)).toBe(true);
  });

  it('keeps an explicit creation grant when a later clause forbids duplicates', async () => {
    await expect(classifyExternalActionAuthorization({
      currentMessage: 'Create the two Linear tickets in the current cycle. Do not create duplicates.',
    })).resolves.toEqual(expect.objectContaining({ granted: true }));
  });

  it.each(['please do not create a Linear ticket', 'I want you to not push', 'never send the email'])(
    'does not grant a leading negated command: %s',
    async (currentMessage) => {
      await expect(classifyExternalActionAuthorization({ currentMessage })).resolves.toEqual({ granted: false, operation: null });
    },
  );
});
