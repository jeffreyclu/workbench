export type ExternalActionAuthorization = { granted: boolean; operation: string | null };
export type ExternalActionAuthorizationContext = {
  currentMessage: string | null | undefined;
  precedingHumanMessage?: string | null;
  precedingAgentMessage?: string | null;
};

export type AuthorizationRule = {
  id: string;
  description: string;
  pattern: RegExp;
};

/**
 * The complete supported one-turn command vocabulary. Keep this declarative:
 * every entry is exercised as a table in the test suite, and adding a new
 * external integration means adding its mutations here instead of teaching a
 * probabilistic classifier another example.
 */
export const EXTERNAL_ACTION_COMMANDS: readonly AuthorizationRule[] = [
  { id: 'commit', description: 'Commit local repository changes', pattern: /\b(?:commit(?:\s+(?:the\s+)?(?:changes|work|files?|latest|everything))?|amend(?:\s+(?:the\s+)?commit)?)\b/i },
  { id: 'push', description: 'Push Git commits, branches, or tags to the named remote', pattern: /\b(?:git\s+)?(?:push|force[- ]?push)\b/i },
  { id: 'remote_branch', description: 'Create, rename, or delete the named remote branch', pattern: /\b(?:create|rename|delete|remove)\s+(?:the\s+)?(?:named\s+)?remote\s+branch\b/i },
  { id: 'pr_create', description: 'Create or open the named pull request', pattern: /\b(?:create|open|raise|file|submit)\s+(?:a\s+|the\s+)?(?:github\s+)?(?:pull request|pr)\b/i },
  { id: 'pr_update', description: 'Update the named pull request metadata', pattern: /\b(?:update|edit|rewrite|change|rename|relink)\s+(?:the\s+)?(?:github\s+)?(?:pull request|pr)(?:\s+(?:title|desc(?:ription)?|body|base|head|labels?|assignees?|milestone))?\b|\b(?:update|edit|rewrite|change|rename|relink)\s+(?:the\s+)?(?:title|desc(?:ription)?|body|base|head|labels?|assignees?|milestone)\s+(?:of|on|for)\s+(?:the\s+)?(?:pull request|pr)\b|\b(?:pull request|pr)(?:\s+[^.!?\n]{0,50})?\s+(?:needs?\s+to\s+be|must\s+be|should\s+be)\s+(?:updated|edited|rewritten|changed|renamed|relinked)\b/i },
  { id: 'pr_review', description: 'Submit a review, approval, change request, or comment on the named pull request', pattern: /\b(?:approve|review|comment\s+on|post\s+(?:a\s+)?comment\s+(?:on|to)|request\s+changes\s+(?:on|to))\s+(?:the\s+)?(?:github\s+)?(?:pull request|pr)\b|\b(?:submit|post)\s+(?:the\s+|a\s+)?(?:review|approval|change request|pr comment)\b/i },
  { id: 'pr_lifecycle', description: 'Merge, close, reopen, mark ready, or convert the named pull request', pattern: /\b(?:merge|close|reopen)\s+(?:the\s+)?(?:github\s+)?(?:pull request|pr)\b|\b(?:mark\s+(?:the\s+)?(?:pull request|pr)\s+ready|convert\s+(?:the\s+)?(?:pull request|pr)\s+(?:to\s+)?draft)\b/i },
  { id: 'github_issue', description: 'Create or mutate the named GitHub issue', pattern: /\b(?:create|open|file|update|edit|close|reopen|delete|comment\s+on|label|assign)\s+(?:a\s+|the\s+)?github\s+(?:ticket|issue)\b/i },
  { id: 'github_workflow', description: 'Dispatch, rerun, or cancel the named GitHub workflow', pattern: /\b(?:dispatch|trigger|run|rerun|re-run|cancel)\s+(?:the\s+|a\s+)?(?:github\s+)?(?:actions?\s+)?workflow\b/i },
  { id: 'github_release', description: 'Create, publish, edit, or delete the named GitHub release or tag', pattern: /\b(?:create|publish|edit|update|delete|remove)\s+(?:the\s+|a\s+)?(?:github\s+)?(?:release|tag)\b/i },
  { id: 'linear_create', description: 'Create the requested Linear ticket', pattern: /\b(?:create|open|file|write|make|add)\s+(?:a\s+|the\s+)?(?:new\s+)?linear\s+(?:ticket|issue|card)\b|\b(?:create|open|file|write|make|add)\s+(?:a\s+|the\s+)?(?:new\s+)?(?:ticket|issue|card)\s+(?:in|on)\s+linear\b|\blinear\s+(?:ticket|issue|card)(?:\s+[^.!?\n]{0,50})?\s+(?:needs?\s+to\s+be|must\s+be|should\s+be)\s+(?:created|opened|filed|written|added)\b/i },
  { id: 'linear_update', description: 'Update the named Linear ticket', pattern: /\b(?:update|edit|change|move|close|cancel|archive|delete|comment(?:\s+on)?|assign|label|link|unlink)\s+(?:the\s+)?(?:linear\s+)?(?:ticket|issue|card)\b|\b(?:update|edit|change)\s+(?:the\s+)?(?:status|description|title|priority|assignee|labels?)\s+(?:of|on|for)\s+(?:the\s+)?linear\s+(?:ticket|issue|card)\b|\blinear\s+(?:ticket|issue|card)(?:\s+[^.!?\n]{0,50})?\s+(?:needs?\s+to\s+be|must\s+be|should\s+be)\s+(?:updated|edited|changed|moved|closed|canceled|archived|deleted|assigned|labeled|linked)\b/i },
  { id: 'project_tracker', description: 'Create or update the named Jira, Asana, or Shortcut ticket', pattern: /\b(?:create|open|file|write|make|add|update|edit|change|move|close|cancel|archive|delete|comment(?:\s+on)?|assign|label|link|unlink)\s+(?:a\s+|the\s+)?(?:jira|asana|shortcut)\s+(?:ticket|issue|card|task)\b|\b(?:create|open|file|write|make|add|update|edit|change|move|close|cancel|archive|delete|comment(?:\s+on)?|assign|label|link|unlink)\s+(?:a\s+|the\s+)?(?:ticket|issue|card|task)\s+(?:in|on)\s+(?:jira|asana|shortcut)\b/i },
  { id: 'slack_message', description: 'Send, post, edit, delete, reply to, or react to the named Slack message', pattern: /\b(?:send|post|publish|edit|update|delete|remove|reply\s+to|react\s+to)\s+(?:a\s+|the\s+|that\s+|this\s+)?(?:slack\s+)?(?:message|post|reply|dm|comment)\b|\b(?:send|post|publish|edit|update|delete|remove|reply|react)\b[^.!?\n]{0,80}\b(?:in|on|to)\s+slack\b/i },
  { id: 'confluence', description: 'Create, publish, update, comment on, move, archive, or delete the named Confluence page', pattern: /\b(?:create|write|publish|update|edit|rewrite|comment\s+on|move|archive|delete|remove)\s+(?:a\s+|the\s+|that\s+|this\s+)?(?:confluence\s+)?(?:page|document|doc)\b|\b(?:create|write|publish|update|edit|rewrite|comment|move|archive|delete|remove)\b[^.!?\n]{0,80}\b(?:in|on|to)\s+confluence\b/i },
  { id: 'notion', description: 'Create, publish, update, move, archive, or delete the named Notion page', pattern: /\b(?:create|write|publish|update|edit|rewrite|comment\s+on|move|archive|delete|remove)\s+(?:a\s+|the\s+|that\s+|this\s+)?notion\s+(?:page|document|doc|database)\b/i },
  { id: 'google_workspace', description: 'Create, update, share, move, or delete the named Google Workspace resource', pattern: /\b(?:create|write|publish|update|edit|share|move|archive|delete|remove|upload)\s+(?:a\s+|the\s+|that\s+|this\s+)?(?:google\s+)?(?:doc|document|sheet|spreadsheet|slide|deck|drive file|calendar event)\b/i },
  { id: 'artifact', description: 'Publish or upload the named file to the Workbench artifact library', pattern: /\b(?:publish|upload|add|save|copy|move)\s+(?:the\s+|this\s+|that\s+|a\s+)?(?:file|document|doc|artifact|report|timesheet)?[^.!?\n]{0,60}\b(?:artifact library|artifacts)\b|\bpublish\s+(?:the\s+|this\s+|that\s+)?artifact\b/i },
  { id: 'promotion', description: 'Promote the Workbench preview/runtime requested in this turn', pattern: /\b(?:promote|ship)\s*(?:the\s+)?(?:workbench|preview|runtime|changes|it|this|that)?\b/i },
  { id: 'deployment', description: 'Deploy, release, promote, or roll back the named external environment', pattern: /\b(?:deploy|release|promote|rollback|roll back)\s+(?:the\s+|this\s+|that\s+)?(?:app|service|site|build|release|environment|staging|production|prod)\b/i },
  { id: 'email', description: 'Send, reply to, or forward the named email', pattern: /\b(?:send|reply\s+to|forward)\s+(?:the\s+|this\s+|that\s+|an?\s+)?(?:email|mail)\b/i },
  { id: 'package_publish', description: 'Publish, release, deprecate, or unpublish the named package', pattern: /\b(?:publish|release|deprecate|unpublish)\s+(?:the\s+|this\s+|that\s+|a\s+)?(?:npm\s+|package registry\s+)?package\b|\bnpm\s+(?:publish|deprecate|unpublish)\b/i },
  { id: 'figma', description: 'Publish, update, edit, or comment on the named Figma resource', pattern: /\b(?:publish|update|edit|change|comment\s+on|delete|remove)\s+(?:the\s+|this\s+|that\s+|a\s+)?figma\s+(?:file|design|page|comment|prototype|library)\b/i },
  { id: 'cloud', description: 'Create, update, deploy, restart, or delete the named cloud resource', pattern: /\b(?:create|update|deploy|restart|stop|start|delete|remove|destroy)\b[^.!?\n]{0,100}\b(?:gcloud|google cloud|gcp|aws|azure|cloudflare|vercel)\b|\b(?:gcloud|aws|az|wrangler|vercel)\s+(?:deploy|run|create|update|delete|remove|destroy|publish)\b/i },
  { id: 'external_api', description: 'Perform the named mutating external API request', pattern: /\b(?:post|put|patch|delete)\s+(?:the\s+|this\s+|that\s+|an?\s+)?(?:request\s+)?(?:to\s+)?(?:the\s+)?(?:external\s+)?api\b|\bcall\s+(?:the\s+)?api\s+to\s+(?:create|update|edit|delete|publish|send)\b/i },
] as const;

const COMMAND_START = /^(?:commit|amend|push|force[- ]?push|promote|ship|deploy|release|rollback|roll back|publish|open|create|raise|file|submit|write|make|add|update|edit|rewrite|change|rename|relink|approve|review|comment|post|request|merge|close|reopen|mark|convert|delete|remove|dispatch|trigger|run|rerun|re-run|cancel|move|archive|assign|label|link|unlink|send|reply|react|upload|save|copy|forward|deprecate|unpublish|restart|stop|start|destroy|call|npm|gcloud|aws|az|wrangler|vercel)\b/i;
const LEADING_REQUEST = /^(?:(?:ok(?:ay)?|please|now|just|then|also|finally|fucking|fuck|motherfucker|motherfucking)\b[\s,:-]*|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+|you\s+(?:can|may|should|must|need\s+to|have\s+to)\s+|go\s+ahead(?:\s+and)?\s+)+/i;
const PASSIVE_REQUEST = /\b(?:needs?\s+to(?:\s+be)?|must\s+be|should\s+be|has\s+to(?:\s+be)?|have\s+to(?:\s+be)?)\s+(?:created|opened|updated|edited|rewritten|changed|renamed|relinked|approved|reviewed|commented|merged|closed|reopened|deleted|removed|published|promoted|deployed|sent|pushed|committed)\b/i;
const RHETORICAL_COMMAND = /^why\s+(?:the\s+fuck\s+)?(?:don'?t|won'?t|can'?t)\s+you\s+/i;
const TERSE_APPROVAL = /^(?:ok(?:ay)?\s+)?(?:yes|yeah|yep|approved?(?:\s+(?:it|this|that))?|do it|go|go ahead(?:\s+and\s+do\s+it)?|proceed|continue|ship it|send it|post it|publish it|push it|(?:now\s+)?you have (?:my\s+)?permission|permission granted|authorized)(?:\s+(?:now|please))?[.!]*$/i;
const META_EXAMPLE = /\b(?:is another (?:one|command)|add (?:this|that|it) to (?:the\s+)?(?:list|commands?)|command list|authorization (?:list|regex|parser)|regex (?:list|against|for))\b/i;
const NEGATED_ACTION = /\b(?:do\s+not|don'?t|never|no)\s+(?:ever\s+)?(?:commit|amend|push|force[- ]?push|promote|deploy|publish|open|create|update|edit|approve|merge|comment|post|send|delete|remove|release)\b/i;
const STATUS_REPORT = /^(?:(?:ok(?:ay)?|so|well)\s+)?(?:commit|amend|push|promote|deploy|publish|merge|approval?)\s+(?:is|was|seems|looks|keeps|failed|fails|broke|doesn'?t|does not)\b/i;

function matchingRules(message: string): AuthorizationRule[] {
  return EXTERNAL_ACTION_COMMANDS.filter((rule) => rule.pattern.test(message));
}

function directCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || META_EXAMPLE.test(trimmed) || NEGATED_ACTION.test(trimmed) || STATUS_REPORT.test(trimmed)) return false;
  const stripped = trimmed.replace(LEADING_REQUEST, '').trim();
  return COMMAND_START.test(stripped) || PASSIVE_REQUEST.test(trimmed) || COMMAND_START.test(trimmed.replace(RHETORICAL_COMMAND, '').trim());
}

function operationFor(rules: AuthorizationRule[], current: string, pending?: string): string {
  const actions = [...new Set(rules.map((rule) => rule.description))];
  const currentScope = current.replace(/\s+/g, ' ').trim().slice(0, 700);
  const pendingScope = pending?.replace(/\s+/g, ' ').trim().slice(0, 700);
  return `${actions.join('; ')}. Jeffrey's current instruction: ${currentScope}.${pendingScope ? ` Resolve any omitted target only from the immediately preceding pending operation: ${pendingScope}.` : ''}`.slice(0, 1_500);
}

/**
 * Deterministic one-turn authorization. It recognizes only an explicit command
 * in the newest message, or a terse approval of a concrete operation in the
 * immediately preceding agent response. Old approvals and quoted examples do
 * not carry forward.
 */
export async function classifyExternalActionAuthorization(context: ExternalActionAuthorizationContext): Promise<ExternalActionAuthorization> {
  const current = context.currentMessage?.trim() ?? '';
  if (!current || META_EXAMPLE.test(current) || NEGATED_ACTION.test(current)) return { granted: false, operation: null };

  const directRules = matchingRules(current);
  if (directRules.length && directCommand(current)) return { granted: true, operation: operationFor(directRules, current) };

  if (TERSE_APPROVAL.test(current)) {
    const pending = context.precedingAgentMessage?.trim() || context.precedingHumanMessage?.trim() || '';
    const pendingRules = matchingRules(pending);
    if (pendingRules.length) return { granted: true, operation: operationFor(pendingRules, current, pending) };
  }
  return { granted: false, operation: null };
}
