import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export type ExternalActionCapability = {
  actionIds: string[];
  command: string;
  requiredExecutables: string[];
  requiredWorkbenchTools: string[];
  source: 'direct_command' | 'terse_followup';
};

export type ExternalActionAuthorization =
  | { granted: false; operation: null }
  | { granted: true; operation: string; capability: ExternalActionCapability };
export type ExternalActionAuthorizationContext = {
  currentMessage: string | null | undefined;
  precedingHumanMessage?: string | null;
  precedingAgentMessage?: string | null;
};

export type AuthorizationRule = {
  id: string;
  description: string;
  pattern: RegExp;
  requiredExecutables?: readonly string[];
  requiredWorkbenchTools?: readonly string[];
};

/**
 * The complete supported one-turn command vocabulary. Keep this declarative:
 * every entry is exercised as a table in the test suite, and adding a new
 * external integration means adding its mutations here instead of teaching a
 * probabilistic classifier another example.
 */
export const EXTERNAL_ACTION_COMMANDS: readonly AuthorizationRule[] = [
  { id: 'commit', description: 'Commit local repository changes', requiredExecutables: ['git'], pattern: /\b(?:commit(?:\s+(?:the\s+)?(?:changes|work|files?|latest|everything))?|amend(?:\s+(?:the\s+)?commit)?)\b/i },
  { id: 'push', description: 'Push Git commits, branches, or tags to the named remote', requiredExecutables: ['git'], pattern: /\b(?:git\s+)?(?:push|force[- ]?push)\b/i },
  { id: 'remote_branch', description: 'Create, rename, or delete the named remote branch', requiredExecutables: ['git'], pattern: /\b(?:create|rename|delete|remove)\s+(?:the\s+)?(?:named\s+)?remote\s+branch\b/i },
  { id: 'pr_create', description: 'Push the named branch if needed and create or open the named pull request', requiredExecutables: ['git', 'gh'], pattern: /\b(?:create|open|raise|file|submit)\s+(?:(?:a|an|the|another)\s+)?(?:new\s+)?(?:draft\s+)?(?:github\s+)?(?:pull request|pr)\b/i },
  { id: 'pr_update', description: 'Update the named pull request metadata', requiredExecutables: ['gh'], pattern: /\b(?:update|edit|rewrite|change|rename|relink)\s+(?:the\s+)?(?:github\s+)?(?:pull request|pr)(?:\s+(?:title|desc(?:ription)?|body|base|head|labels?|assignees?|milestone))?\b|\b(?:update|edit|rewrite|change|rename|relink)\s+(?:the\s+)?(?:title|desc(?:ription)?|body|base|head|labels?|assignees?|milestone)\s+(?:of|on|for)\s+(?:the\s+)?(?:pull request|pr)\b|\b(?:pull request|pr)(?:\s+[^.!?\n]{0,50})?\s+(?:needs?\s+to\s+be|must\s+be|should\s+be)\s+(?:updated|edited|rewritten|changed|renamed|relinked)\b/i },
  { id: 'pr_review', description: 'Submit a review, approval, change request, or comment on the named pull request', requiredExecutables: ['gh'], pattern: /\b(?:approve|review|comment\s+on|post\s+(?:a\s+)?comment\s+(?:on|to)|request\s+changes\s+(?:on|to))\s+(?:the\s+)?(?:github\s+)?(?:pull request|pr)\b|\b(?:submit|post)\s+(?:the\s+|a\s+)?(?:review|approval|change request|pr comment)\b/i },
  { id: 'pr_lifecycle', description: 'Merge, close, reopen, mark ready, or convert the named pull request', requiredExecutables: ['gh'], pattern: /\b(?:merge|close|reopen)\s+(?:the\s+)?(?:github\s+)?(?:pull request|pr)\b|\b(?:mark\s+(?:the\s+)?(?:pull request|pr)\s+ready|convert\s+(?:the\s+)?(?:pull request|pr)\s+(?:to\s+)?draft)\b/i },
  { id: 'github_issue', description: 'Create or mutate the named GitHub issue', requiredExecutables: ['gh'], pattern: /\b(?:create|open|file|update|edit|close|reopen|delete|comment\s+on|label|assign)\s+(?:a\s+|the\s+)?github\s+(?:ticket|issue)\b/i },
  { id: 'github_workflow', description: 'Dispatch, rerun, or cancel the named GitHub workflow', requiredExecutables: ['gh'], pattern: /\b(?:dispatch|trigger|run|rerun|re-run|cancel)\s+(?:the\s+|a\s+)?(?:github\s+)?(?:actions?\s+)?workflow\b/i },
  { id: 'github_release', description: 'Create, publish, edit, or delete the named GitHub release or tag', requiredExecutables: ['gh'], pattern: /\b(?:create|publish|edit|update|delete|remove)\s+(?:the\s+|a\s+)?(?:github\s+)?(?:release|tag)\b/i },
  { id: 'linear_create', description: 'Create the requested Linear ticket', requiredWorkbenchTools: ['create_linear_issue'], pattern: /\b(?:create|open|file|write|make|add)\s+(?:(?:a|the|one|two|three|both|these|those|requested|authorized|following|\d+)\s+){0,4}(?:new\s+)?linear\s+(?:tickets?|issues?|cards?)\b|\b(?:create|open|file|write|make|add)\s+(?:(?:a|the|one|two|three|both|these|those|requested|authorized|following|\d+)\s+){0,4}(?:new\s+)?(?:tickets?|issues?|cards?)\s+(?:in|on)\s+linear\b|\blinear\s+(?:tickets?|issues?|cards?)(?:\s+[^.!?\n]{0,50})?\s+(?:needs?\s+to\s+be|must\s+be|should\s+be)\s+(?:created|opened|filed|written|added)\b/i },
  { id: 'linear_update', description: 'Update the named Linear ticket', requiredWorkbenchTools: ['update_linear_issue'], pattern: /\b(?:update|edit|change|move|close|cancel|archive|delete|comment(?:\s+on)?|assign|label|link|unlink)\s+(?:the\s+)?(?:linear\s+)?(?:ticket|issue|card)\b|\b(?:update|edit|change)\s+(?:the\s+)?(?:status|description|title|priority|assignee|labels?)\s+(?:of|on|for)\s+(?:the\s+)?linear\s+(?:ticket|issue|card)\b|\blinear\s+(?:ticket|issue|card)(?:\s+[^.!?\n]{0,50})?\s+(?:needs?\s+to\s+be|must\s+be|should\s+be)\s+(?:updated|edited|changed|moved|closed|canceled|archived|deleted|assigned|labeled|linked)\b/i },
  { id: 'project_tracker', description: 'Create or update the named Jira, Asana, or Shortcut ticket', pattern: /\b(?:create|open|file|write|make|add|update|edit|change|move|close|cancel|archive|delete|comment(?:\s+on)?|assign|label|link|unlink)\s+(?:a\s+|the\s+)?(?:jira|asana|shortcut)\s+(?:ticket|issue|card|task)\b|\b(?:create|open|file|write|make|add|update|edit|change|move|close|cancel|archive|delete|comment(?:\s+on)?|assign|label|link|unlink)\s+(?:a\s+|the\s+)?(?:ticket|issue|card|task)\s+(?:in|on)\s+(?:jira|asana|shortcut)\b/i },
  { id: 'slack_message', description: 'Send, post, edit, delete, reply to, or react to the named Slack message', pattern: /\b(?:send|post|publish|edit|update|delete|remove|reply\s+to|react\s+to)\s+(?:a\s+|the\s+|that\s+|this\s+)?(?:slack\s+)?(?:message|post|reply|dm|comment)\b|\b(?:send|post|publish|edit|update|delete|remove|reply|react)\b[^.!?\n]{0,80}\b(?:in|on|to)\s+slack\b/i },
  { id: 'confluence', description: 'Create, publish, update, comment on, move, archive, or delete the named Confluence page', pattern: /\b(?:create|write|publish|update|edit|rewrite|comment\s+on|move|archive|delete|remove)\s+(?:a\s+|the\s+|that\s+|this\s+)?(?:confluence\s+)?(?:page|document|doc)\b|\b(?:create|write|publish|update|edit|rewrite|comment|move|archive|delete|remove)\b[^.!?\n]{0,80}\b(?:in|on|to)\s+confluence\b/i },
  { id: 'notion', description: 'Create, publish, update, move, archive, or delete the named Notion page', pattern: /\b(?:create|write|publish|update|edit|rewrite|comment\s+on|move|archive|delete|remove)\s+(?:a\s+|the\s+|that\s+|this\s+)?notion\s+(?:page|document|doc|database)\b/i },
  { id: 'google_workspace', description: 'Create, update, share, move, or delete the named Google Workspace resource', pattern: /\b(?:create|write|publish|update|edit|share|move|archive|delete|remove|upload)\s+(?:a\s+|the\s+|that\s+|this\s+)?(?:google\s+)?(?:doc|document|sheet|spreadsheet|slide|deck|drive file|calendar event)\b/i },
  { id: 'artifact', description: 'Publish or upload the named file to the Workbench artifact library', requiredWorkbenchTools: ['publish_artifact'], pattern: /\b(?:publish|upload|add|save|copy|move)\s+(?:the\s+|this\s+|that\s+|a\s+)?(?:file|document|doc|artifact|report|timesheet)?[^.!?\n]{0,60}\b(?:artifact library|artifacts)\b|\bpublish\s+(?:the\s+|this\s+|that\s+)?artifact\b/i },
  { id: 'promotion', description: 'Promote the Workbench preview/runtime requested in this turn', requiredWorkbenchTools: ['promote_runtime'], pattern: /\b(?:promote|ship)\s*(?:the\s+)?(?:workbench|preview|runtime|changes|it|this|that)?\b/i },
  { id: 'deployment', description: 'Deploy, release, promote, or roll back the named external environment', pattern: /\b(?:deploy|release|promote|rollback|roll back)\s+(?:the\s+|this\s+|that\s+)?(?:app|service|site|build|release|environment|staging|production|prod)\b/i },
  { id: 'email', description: 'Send, reply to, or forward the named email', pattern: /\b(?:send|reply\s+to|forward)\s+(?:the\s+|this\s+|that\s+|an?\s+)?(?:email|mail)\b/i },
  { id: 'package_publish', description: 'Publish, release, deprecate, or unpublish the named package', pattern: /\b(?:publish|release|deprecate|unpublish)\s+(?:the\s+|this\s+|that\s+|a\s+)?(?:npm\s+|package registry\s+)?package\b|\bnpm\s+(?:publish|deprecate|unpublish)\b/i },
  { id: 'figma', description: 'Publish, update, edit, or comment on the named Figma resource', pattern: /\b(?:publish|update|edit|change|comment\s+on|delete|remove)\s+(?:the\s+|this\s+|that\s+|a\s+)?figma\s+(?:file|design|page|comment|prototype|library)\b/i },
  { id: 'cloud', description: 'Create, update, deploy, restart, or delete the named cloud resource', pattern: /\b(?:create|update|deploy|restart|stop|start|delete|remove|destroy)\b[^.!?\n]{0,100}\b(?:gcloud|google cloud|gcp|aws|azure|cloudflare|vercel)\b|\b(?:gcloud|aws|az|wrangler|vercel)\s+(?:deploy|run|create|update|delete|remove|destroy|publish)\b/i },
  { id: 'external_api', description: 'Perform the named mutating external API request', pattern: /\b(?:post|put|patch|delete)\s+(?:the\s+|this\s+|that\s+|an?\s+)?(?:request\s+)?(?:to\s+)?(?:the\s+)?(?:external\s+)?api\b|\bcall\s+(?:the\s+)?api\s+to\s+(?:create|update|edit|delete|publish|send)\b/i },
] as const;

const COMMAND_START = /^(?:commit|amend|push|force[- ]?push|promote|ship|deploy|release|rollback|roll back|publish|open|create|raise|file|submit|write|make|add|put|spin\s+up|update|edit|rewrite|change|rename|relink|approve|review|comment|post|request|merge|close|reopen|mark|convert|delete|remove|dispatch|trigger|run|rerun|re-run|cancel|move|archive|assign|label|link|unlink|send|reply|react|upload|save|copy|forward|deprecate|unpublish|restart|stop|start|destroy|call|npm|gcloud|aws|az|wrangler|vercel)\b/i;
const LEADING_REQUEST = /^(?:(?:ok(?:ay)?|please|now|just|then|also|finally|fucking|fuck|motherfucker|motherfucking)\b[\s,:-]*|(?:can|could|would|will)\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+|you\s+(?:can|may|should|must|need\s+to|have\s+to)\s+|go\s+ahead(?:\s+and)?\s+)+/i;
const PASSIVE_REQUEST = /\b(?:needs?\s+to(?:\s+be)?|must\s+be|should\s+be|has\s+to(?:\s+be)?|have\s+to(?:\s+be)?)\s+(?:created|opened|updated|edited|rewritten|changed|renamed|relinked|approved|reviewed|commented|merged|closed|reopened|deleted|removed|published|promoted|deployed|sent|pushed|committed)\b/i;
const TERSE_APPROVAL = /^(?:ok(?:ay)?\s+)?(?:yes|yeah|yep|approved?(?:\s+(?:it|this|that))?|do it|go|go ahead(?:\s+and\s+do\s+it)?|proceed|continue|ship it|send it|post it|publish it|push it|(?:now\s+)?you have (?:my\s+)?permission|permission granted|authorized)(?:\s+(?:now|please))?[.!]*$/i;
const TERSE_APPROVAL_FILLER = /\b(?:you|codex|claude|palmyra|fuck|fucking|fcking|motherfucker|motherfucking)\b/gi;
const META_EXAMPLE = /\b(?:is another (?:one|command)|add (?:this|that|it) to (?:the\s+)?(?:list|commands?)|command list|authorization (?:list|regex|parser)|regex (?:list|against|for))\b/i;
const NEGATED_COMMAND_START = /^(?:do\s+not|don'?t|not|never|no)\s+(?:ever\s+)?(?:commit|amend|push|force[- ]?push|promote|deploy|publish|open|create|update|edit|approve|merge|comment|post|send|delete|remove|release)\b/i;
const STATUS_REPORT = /^(?:(?:ok(?:ay)?|so|well)\s+)?(?:commit|amend|push|promote|deploy|publish|merge|approval?)\s+(?:is|was|seems|looks|keeps|failed|fails|broke|doesn'?t|does not)\b/i;

function matchingRules(message: string): AuthorizationRule[] {
  return EXTERNAL_ACTION_COMMANDS.filter((rule) => rule.pattern.test(message));
}

const GENERIC_EXTERNAL_TARGET = /\b(?:github|pull request|pr\b|linear|jira|asana|shortcut|slack|confluence|notion|google (?:doc|sheet|slide|drive|calendar)|artifact library|workbench (?:preview|runtime)|production|prod\b|staging|email|npm|package registry|figma|gcloud|google cloud|gcp|aws|azure|cloudflare|vercel|external api)\b/i;
const GENERIC_EXTERNAL_MUTATION = /\b(?:commit|amend|push|promote|ship|deploy|release|rollback|roll back|publish|open|create|raise|file|submit|write|make|add|put|spin\s+up|update|edit|rewrite|change|rename|relink|approve|review|comment|post|request|merge|close|reopen|mark|convert|delete|remove|dispatch|trigger|run|rerun|re-run|cancel|move|archive|assign|label|link|unlink|send|reply|react|upload|save|copy|forward|deprecate|unpublish|restart|stop|start|destroy|call)\b/i;
const GENERIC_EXTERNAL_RULE: AuthorizationRule = {
  id: 'external_mutation',
  description: 'Perform the explicitly requested external mutation',
  pattern: /$^/,
};

function robustMatchingRules(message: string): AuthorizationRule[] {
  const exact = matchingRules(message);
  if (exact.length || !GENERIC_EXTERNAL_TARGET.test(message) || !GENERIC_EXTERNAL_MUTATION.test(message)) return exact;
  const canonicalRule = (id: string) => EXTERNAL_ACTION_COMMANDS.find((rule) => rule.id === id);
  if (/\b(?:pull request|pr\b)/i.test(message) && /\b(?:create|open|raise|file|submit|spin\s+up)\b/i.test(message)) {
    return [canonicalRule('pr_create')!];
  }
  if (/\blinear\b/i.test(message) && /\b(?:create|open|file|write|make|add|put)\b/i.test(message)) {
    return [canonicalRule('linear_create')!];
  }
  if (/\b(?:artifact library|artifacts)\b/i.test(message) && /\b(?:publish|upload|add|save|copy|move|put)\b/i.test(message)) {
    return [canonicalRule('artifact')!];
  }
  if (/\bworkbench (?:preview|runtime)\b/i.test(message) && /\b(?:promote|ship)\b/i.test(message)) {
    return [canonicalRule('promotion')!];
  }
  return [GENERIC_EXTERNAL_RULE];
}

function directCommand(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed || META_EXAMPLE.test(trimmed) || STATUS_REPORT.test(trimmed)) return false;
  const stripped = trimmed.replace(LEADING_REQUEST, '').trim();
  if (NEGATED_COMMAND_START.test(stripped)) return false;
  return COMMAND_START.test(stripped) || PASSIVE_REQUEST.test(trimmed);
}

function terseApproval(message: string): boolean {
  if (TERSE_APPROVAL.test(message.trim())) return true;
  const withoutAddressOrEmphasis = message.replace(TERSE_APPROVAL_FILLER, ' ').replace(/\s+/g, ' ').trim();
  return TERSE_APPROVAL.test(withoutAddressOrEmphasis);
}

function authorizationFor(rules: AuthorizationRule[], current: string, source: ExternalActionCapability['source'], pending?: string): ExternalActionAuthorization {
  const actions = [...new Set(rules.map((rule) => rule.description))];
  const requiredExecutables = [...new Set(rules.flatMap((rule) => rule.requiredExecutables ?? []))];
  const requiredWorkbenchTools = [...new Set(rules.flatMap((rule) => rule.requiredWorkbenchTools ?? []))];
  const currentScope = current.replace(/\s+/g, ' ').trim().slice(0, 700);
  const pendingScope = pending?.replace(/\s+/g, ' ').trim().slice(0, 700);
  const toolRoute = [
    requiredWorkbenchTools.length ? `Workbench tools ${requiredWorkbenchTools.map((tool) => `\`${tool}\``).join(', ')}` : '',
    requiredExecutables.length ? `local executables ${requiredExecutables.map((tool) => `\`${tool}\``).join(', ')}` : '',
  ].filter(Boolean).join(' and ');
  const preflight = toolRoute ? ` The supervisor will preflight the required ${toolRoute} before the turn starts. Use that route directly; do not substitute a read-only connector or start a separate authentication flow.` : '';
  const operation = `${actions.join('; ')}.${preflight} Jeffrey's current instruction: ${currentScope}.${pendingScope ? ` Resolve any omitted target only from the immediately preceding pending operation: ${pendingScope}.` : ''}`.slice(0, 1_500);
  return {
    granted: true,
    operation,
    capability: {
      actionIds: [...new Set(rules.map((rule) => rule.id))],
      command: pendingScope || currentScope,
      requiredExecutables,
      requiredWorkbenchTools,
      source,
    },
  };
}

export function missingRequiredExecutables(authorization: ExternalActionAuthorization, path = process.env.PATH ?? ''): string[] {
  if (!authorization.granted) return [];
  return authorization.capability.requiredExecutables.filter((executable) => !path.split(delimiter).some((directory) => {
    if (!directory) return false;
    try {
      accessSync(join(directory, executable), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

const UNSUPPORTED_CAPABILITY_DENIALS = [
  /\bno (?:supervisor[- ]issued )?(?:mutation )?capability\b/i,
  /\b(?:capability|authorization|permission) (?:is |was )?(?:missing|absent|expired|not (?:available|granted|issued))\b/i,
  /\b(?:not authorized|unauthorized|prohibited)\b[^.!?\n]{0,100}\b(?:external|mutation|create|update|push|publish|send|deploy|promote)\b/i,
  /\b(?:required |write |mutation )?tool\b[^.!?\n]{0,100}\b(?:not available|unavailable|not exposed|not callable|not in (?:the )?(?:registry|tool list))\b/i,
  /\bi (?:can'?t|cannot|am unable to)\b[^.!?\n]{0,120}\b(?:because|without)\b[^.!?\n]{0,100}\b(?:capability|authorization|permission|tool)\b/i,
  /\bi\s+(?:do not|don'?t|lack)\s+(?:have\s+)?(?:the\s+)?(?:required\s+)?(?:access|permission|tooling)\b[^.!?\n]{0,160}\b(?:creat(?:e|ing)|updat(?:e|ing)|push(?:ing)?|publish(?:ing)?|send(?:ing)?|deploy(?:ing)?|promot(?:e|ing))\b/i,
  /\b(?:blocked|can'?t|cannot|couldn'?t|unable to)\b[^.!?\n]{0,160}\b(?:creat(?:e|ing)|updat(?:e|ing)|edit(?:ing)?|push(?:ing)?|publish(?:ing)?|send(?:ing)?|post(?:ing)?|deploy(?:ing)?|promot(?:e|ing)|merg(?:e|ing)|clos(?:e|ing)|open(?:ing)?|fil(?:e|ing)|commit(?:ting)?)\b/i,
] as const;

export function hasUnsupportedCapabilityDenial(output: string): boolean {
  return UNSUPPORTED_CAPABILITY_DENIALS.some((pattern) => pattern.test(output));
}

export function externalActionAttempted(authorization: ExternalActionAuthorization, eventDetails: readonly string[]): boolean {
  if (!authorization.granted) return false;
  const evidence = eventDetails.join('\n');
  if (authorization.capability.requiredWorkbenchTools.some((tool) => evidence.toLowerCase().includes(tool.toLowerCase()))) return true;
  const attemptPatterns: Record<string, RegExp> = {
    commit: /\bgit\s+commit\b/i,
    push: /\bgit\s+push\b/i,
    remote_branch: /\bgit\s+push\b|\bgh\s+api\b/i,
    pr_create: /\bgh\s+pr\s+create\b/i,
    pr_update: /\bgh\s+pr\s+edit\b|\bgh\s+api\b/i,
    pr_review: /\bgh\s+pr\s+(?:review|comment)\b/i,
    pr_lifecycle: /\bgh\s+pr\s+(?:merge|close|ready|reopen)\b|\bgh\s+api\b/i,
    github_issue: /\bgh\s+issue\b|\bgh\s+api\b/i,
    github_workflow: /\bgh\s+(?:workflow|run)\b/i,
    github_release: /\bgh\s+release\b/i,
    promotion: /\bpromote_runtime\b|\bruntime:promote\b/i,
    deployment: /\b(?:deploy|release|rollback|roll back)\b/i,
    cloud: /\b(?:gcloud|aws|az|wrangler|vercel)\b/i,
    package_publish: /\bnpm\s+(?:publish|deprecate|unpublish)\b/i,
    slack_message: /\bslack\b[^\n]{0,100}\b(?:send|post|publish|edit|update|delete|reply|react)|\b(?:send|post|publish|edit|update|delete|reply|react)[_./-].*\bslack\b/i,
    confluence: /\bconfluence\b[^\n]{0,100}\b(?:create|publish|update|edit|comment|move|archive|delete)|\b(?:create|publish|update|edit|comment|move|archive|delete)[_./-].*\bconfluence\b/i,
    notion: /\bnotion\b[^\n]{0,100}\b(?:create|publish|update|edit|move|archive|delete)|\b(?:create|publish|update|edit|move|archive|delete)[_./-].*\bnotion\b/i,
    email: /\b(?:send|reply|forward)[_./-]?(?:email|mail)\b|\b(?:email|mail)\b[^\n]{0,80}\b(?:send|reply|forward)\b/i,
  };
  return authorization.capability.actionIds.some((actionId) => attemptPatterns[actionId]?.test(evidence))
    || /(?:^|[._/:-])(?:create|update|delete|publish|send|post|deploy|promote|push|merge|close)(?:$|[._/:-])/im
      .test(evidence);
}

/**
 * Deterministic one-turn authorization. It recognizes only an explicit command
 * in the newest message, or a terse approval of a concrete operation in the
 * immediately preceding agent response. Old approvals and quoted examples do
 * not carry forward.
 */
export async function classifyExternalActionAuthorization(context: ExternalActionAuthorizationContext): Promise<ExternalActionAuthorization> {
  const current = context.currentMessage?.trim() ?? '';
  if (!current || META_EXAMPLE.test(current)) return { granted: false, operation: null };

  const directRules = robustMatchingRules(current);
  if (directRules.length && directCommand(current)) return authorizationFor(directRules, current, 'direct_command');

  if (terseApproval(current)) {
    const pending = context.precedingAgentMessage?.trim() || context.precedingHumanMessage?.trim() || '';
    const pendingRules = robustMatchingRules(pending);
    if (pendingRules.length) return authorizationFor(pendingRules, current, 'terse_followup', pending);
  }
  return { granted: false, operation: null };
}
