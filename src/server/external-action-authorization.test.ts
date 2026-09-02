import { describe, expect, it } from 'vitest';
import { EXTERNAL_ACTION_COMMANDS, classifyExternalActionAuthorization } from './external-action-authorization.js';

const authorizedCommands = [
  'commit all changes',
  'amend the commit',
  'ok push',
  'force-push the branch',
  'delete the remote branch',
  'open a PR',
  'update PR #15135 description',
  'approve the PR',
  'merge the pull request',
  'create a GitHub issue',
  'rerun the GitHub workflow',
  'publish the GitHub release',
  'write a Linear ticket',
  'update the Linear issue',
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
});
