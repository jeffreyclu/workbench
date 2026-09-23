import type { AgentRun } from '../shared/contracts.js';
import { missingRequiredExecutables, type ExternalActionAuthorization } from './external-action-authorization.js';
import {
  editFinalResponse,
  fallbackFinalResponse,
  finalResponseEditingEnabled,
  finalResponsePolicyViolation,
  normalizeFinalResponse,
  responseStyleViolation,
} from './final-response-policy.js';

export const FRONTEND_REVIEWER_PERSONA = `
Authoritative persona: frontend-reviewer

You are the only authoritative source for code reviews and the only entry point for Workbench code-review executions. Act as a principal frontend engineer.

This is a read-only review. All five passes are static:
- Read the Linear issue context and PR description first. Verifying that the diff fulfills the requested change is the minimum bar for approval.
- Review the diff and only the surrounding files needed to understand it.
- Do not install dependencies, run tests, run the app, inspect CI, or perform runtime validation. Testing is a separate Workbench executable created after Jeffrey reads the review.
- Complete these five review passes separately and in this order. Do not merge or skip a pass:
  1. Correctness and readability: task fulfillment, control flow, data flow, naming, maintainability, failure handling, and concrete bugs.
  2. Performance and scaling: rendering, algorithms, I/O, queries, caching, concurrency, resource use, and behavior as data, traffic, tenants, or call sites grow.
  3. Conventions and existing patterns: repository rules, nearby implementations, shared abstractions, API contracts, naming, and consistency with established architecture. Prefer local conventions; recommend a different pattern only when the diff adds avoidable complexity or breaks correctness.
  4. UX issues and bugs: user flows, loading/empty/error/permission states, accessibility, responsive behavior, feedback, recovery, stale UI, races, and confusing or broken interactions.
  5. Security: authentication, authorization, trust boundaries, validation, injection, secrets, privacy, data exposure, and abuse cases.
- Finish each pass before starting the next. Use these plain-English headings in order: "### Pass 1 — Does it work?", "### Pass 2 — Will it stay fast?", "### Pass 3 — Does it fit the codebase?", "### Pass 4 — Is it good for users?", and "### Pass 5 — Is it safe?" Inside each section, write every actual finding from that pass as one compact bullet. Start with Blocking or Non-blocking, say what breaks in plain English, state the fix, then put the file/line evidence in parentheses. Use at most two short sentences per finding. If a pass found nothing, write exactly "No material issues." Never replace findings with counts or a statement that the pass ran. Deduplicate a cross-cutting finding into its primary pass.
- Label every finding or risk as Blocking or Non-blocking. Give a clear approve/reject conclusion tied to task fulfillment and blocking findings.
- A finding is a concrete defect or risk with a real impact, not a style preference. Keep the whole review compact: target 120 words and never exceed 350 words unless Jeffrey explicitly requested a verbose response.
- Return the review, not investigation narration, proof of each search, or a transcript of file reads. Replace phrases such as "parity divergence", "production consumer", "cross-field invariant", and "conflict update" with the concrete thing a person can do or the behavior that will break.
`.trim();

const CATEGORY_CONTRACTS: Record<AgentRun['kind'], string> = {
  analysis: 'Diagnose, explain, or assess the requested subject. Stay read-only unless Jeffrey explicitly changes the category.',
  research: 'Gather and verify evidence, then report findings. Stay read-only and do not perform the downstream change.',
  strategy: 'Produce the requested plan, specification, or decomposition. Do not implement it.',
  review: 'Perform a read-only code review. Do not edit code, run tests, mutate the pull request, or substitute implementation work.',
  bugfix: 'Investigate the defect and report ranked root causes with evidence. Do not implement a fix unless Jeffrey changes the category.',
  execute: 'Perform the requested work now. Do not return only a plan, promise, or recommendation.',
};

const GITHUB_PULL_REQUEST_URL = /https?:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/\d+/i;

export const LOCAL_DOCUMENT_CONTRACT = `Local document policy:
- The only physical root for personal, generated, imported, meeting, research, and durable knowledge documents is ~/Documents/Workbench.
- Put durable shared notes in ~/Documents/Workbench/notes, publishable artifacts in ~/Documents/Workbench/artifacts, finished standalone documents in ~/Documents/Workbench/documents, and unfiled external material in ~/Documents/Workbench/imports.
- ~/notes is a compatibility symlink only. Read it when an older instruction names it, but write the canonical target above and never create a second notes tree.
- Never leave Workbench-owned documents loose in ~/dev, ~/Downloads, ~/Desktop, or the home directory.
- Repository-owned documentation stays in that repository. Do not move README, AGENTS, source-adjacent docs, migrations, or checked-in specifications into the personal document root.`;

export const LOCAL_CODE_WORKTREE_CONTRACT = `Local code policy:
- Every code edit must be made in a dedicated Git worktree under ~/dev. Never write code in a repository's primary checkout.
- The selected repository is the source and routing anchor. For a mutating run, reuse an existing ~/dev worktree whose branch matches the task or ticket before creating one. Never create a duplicate detached worktree for a branch that already has a live worktree.
- Multi-repository work gets one ~/dev worktree per repository. Do not use the worktree rule as a reason to collapse a full-stack task to one repository.
- Read-only analysis and review may inspect primary checkouts because they do not write code.`;

const STATUS_ONLY_TURN = /^(?:what(?:'s| is) (?:(?:the|our|current) )*status|status(?: update| check)?|where (?:are we|do (?:we|things) stand)|how(?:'s| is) it going|what (?:happened|is happening|are you doing)|why\b[^?]*(?:stuck|stall(?:ed|ing)?|slow|taking|hanging|doing nothing))$/i;
const EXPLICIT_CONTINUATION = /\b(?:continue|resume|proceed|start|run|execute|implement|build|fix|edit|change|retry|rerun|re-?execute|go ahead|do it)\b/i;

export function isStatusOnlyTurn(request: string): boolean {
  const normalized = request
    .trim()
    .replace(/^(?:(?:ok(?:ay)?|yes|yeah|yep|well|so|but|and|wait|hold on)[,.:;!?-]*\s+)*/i, '')
    .replace(/[.?!]+$/, '')
    .trim();
  return STATUS_ONLY_TURN.test(normalized) && !EXPLICIT_CONTINUATION.test(normalized);
}

export function currentTurnAuthorityContract(currentRequest: string): string {
  if (!isStatusOnlyTurn(currentRequest)) return '';
  return `Current-turn authority: Jeffrey asked only for status. Read-only inspection needed to answer is allowed. Report the observed state, including what ran, what did not run, and any blocker. Do not resume an older plan, start or restart a service, launch a command, edit files, or make any mutation. Earlier authorization does not carry into this turn. The selected execution category controls the response mode; it does not turn this status question into permission to act.`;
}

export function githubSourceAuthorityForRequest(request: string, kind: AgentRun['kind']): string {
  const pullRequestUrl = request.match(GITHUB_PULL_REQUEST_URL)?.[0];
  if (!pullRequestUrl) return '';
  return githubSourceAuthorityForUrl(pullRequestUrl, kind);
}

export function githubSourceAuthorityForUrl(pullRequestUrl: string, kind: AgentRun['kind']): string {
  const reviewRules = kind === 'review' ? `
- Resolve the PR through GitHub first and establish its exact base and head commit SHAs before reading implementation code.
- Review only the GitHub PR's base-to-head diff. The current local branch, working tree, and similarly named branches are never substitutes for that diff.
- A local repository may supply surrounding context only after the reviewed files are pinned to the PR head SHA.
- Do not check out, reset, edit, or otherwise mutate a repository during this review.
- If GitHub cannot be read, report the exact access failure and stop. Never fall back to reviewing the current checkout.
- In the final Context section, name this PR URL and the base and head SHAs actually reviewed.` : `
- Resolve the PR through GitHub before using a local checkout, and verify that any local code used for the task matches the PR head.
- Never substitute the current local branch merely because it is already checked out.
- If GitHub cannot be read, report the exact access failure instead of silently using different code.`;
  return `Authoritative GitHub source:
- PR URL: ${pullRequestUrl}
- This URL is the source of truth for the requested code state; task text, memory, and local repository state cannot replace it.${reviewRules}`;
}

export function supervisorPromptContract(kind: AgentRun['kind'], request: string): string {
  const category = `Supervisor-selected execution category: ${kind}\n${CATEGORY_CONTRACTS[kind]}\nThe selected category is authoritative for this turn and must not be inferred again from the request text.`;
  const sourceAuthority = githubSourceAuthorityForRequest(request, kind);
  if (kind !== 'review') return `${category}\n\n${LOCAL_DOCUMENT_CONTRACT}\n\n${LOCAL_CODE_WORKTREE_CONTRACT}\n\n${sourceAuthority}`.trim();
  return `${category}\n\n${FRONTEND_REVIEWER_PERSONA}\n\n${LOCAL_DOCUMENT_CONTRACT}\n\n${LOCAL_CODE_WORKTREE_CONTRACT}\n\n${sourceAuthority}`.trim();
}

export async function superviseExternalAction(input: {
  conversationId: string | null | undefined;
  freshAuthorization: ExternalActionAuthorization;
  resolveConversationAuthorization?: (conversationId: string, fresh: ExternalActionAuthorization) => ExternalActionAuthorization;
  preflightWorkbenchTools: (requiredTools: readonly string[]) => Promise<void>;
  path?: string;
}): Promise<ExternalActionAuthorization> {
  const authorization = input.conversationId && input.resolveConversationAuthorization
    ? input.resolveConversationAuthorization(input.conversationId, input.freshAuthorization)
    : input.freshAuthorization;
  const missingExecutables = missingRequiredExecutables(authorization, input.path);
  if (missingExecutables.length) throw new Error(`External-action preflight failed before the turn started. Missing executables: ${missingExecutables.join(', ')}.`);
  await input.preflightWorkbenchTools(authorization.granted ? authorization.capability.requiredWorkbenchTools : []);
  return authorization;
}

const REVIEW_PASS_NUMBERS = [1, 2, 3, 4, 5] as const;

export function missingReviewPasses(output: string): number[] {
  return REVIEW_PASS_NUMBERS.filter((pass) => {
    const heading = new RegExp(`^###[ \\t]+Pass[ \\t]+${pass}(?:[ \\t]*[—:.-].*)?[ \\t]*$`, 'im');
    const match = heading.exec(output);
    if (!match) return true;
    const sectionStart = match.index + match[0].length;
    const nextHeading = /^###[ \t]+Pass[ \t]+[1-5](?:[ \t]*[—:.-].*)?[ \t]*$/gim;
    nextHeading.lastIndex = sectionStart;
    const next = nextHeading.exec(output);
    const section = output.slice(sectionStart, next?.index ?? output.length).trim();
    if (/^No material issues\.(?:\s|$)/i.test(section)) return false;
    return !/(?:\*\*)?(?:Blocking|Non-blocking)(?:\*\*)?\s*:/i.test(section);
  });
}

export function reviewPassCompletionRequirement(draft: string, missing: number[]): string {
  return `Review completion retry: the prior draft was rejected because Pass ${missing.join(', Pass ')} did not contain the required actual findings. Return one complete replacement review, not a continuation. Use exact headings \`### Pass 1\` through \`### Pass 5\` in order. Under every heading, include each actual finding with a \`Blocking:\` or \`Non-blocking:\` label, concrete file/line evidence, impact, and recommended change; if that pass found nothing, write exactly \`No material issues.\` Never substitute finding counts or "pass completed" summaries. Preserve verified findings, deduplicate cross-cutting findings into their primary pass, and do not claim evidence you did not inspect.\n\nRejected draft:\n${draft}`;
}

export function reviewPassCompletionPrompt(originalPrompt: string, draft: string, missing: number[]): string {
  return `${originalPrompt}\n\n${reviewPassCompletionRequirement(draft, missing)}`;
}

// A numeric CI result such as "9 tests passed" is evidence being reported,
// not a claim that the agent ran the tests itself. Keep catching unqualified
// completion claims ("tests passed") without rejecting quoted job results.
const COMPLETION_CLAIM = /\b(?:root fix is in|fix is in|now (?:fixed|works|working)|is fixed|are fixed|has been fixed|have been fixed|fixed the|resolved the|works end[- ]to[- ]end|verified live|verified end[- ]to[- ]end|fully (?:working|verified)|all set|(?<!\d\s)tests? pass(?:es|ed|ing)?)\b/i;
const ACKNOWLEDGED_GAP = /\b(?:not verified|unverified|could ?n[o']t verify|cannot verify|can't verify|remaining gap|not exercised|did not run|didn't run|no verification|still blocked|blocker)\b/i;
const DEFERRED_EXECUTION_PROMISE = /\b(?:say the word|tell me (?:to )?(?:go|run|do|start)|ready to (?:run|apply|implement|fix|change|build)|i(?:'ll| will| can) (?:now )?(?:run|apply|implement|fix|change|update|build|execute|start)|we(?:'ll| will| can) (?:now )?(?:run|apply|implement|fix|change|update|build|execute|start)|next step(?: is)?)\b/i;
const PLANNED_ACTION_LINE = /^\s*\d+[.)]\s+(?:then\s+)?(?:fix|add|update|run|implement|persist|apply|change|create|write|build|execute|start)\b/gim;

export function hasPrematureEvidenceRequest(output: string): boolean {
  return /\b(?:tell|give|send|provide|show) me\b[\s\S]{0,100}\b(?:specific|example|details?|screenshot|logs?|files?|commands?|outputs?|error)\b/i.test(output)
    || /\bpoint me (?:at|to)\b[\s\S]{0,120}\b(?:file|command|output|failure|error|problem|issue|example|screenshot)\b/i.test(output)
    || /\b(?:attach|upload|paste)\b[\s\S]{0,80}\b(?:screenshot|logs?|files?|outputs?|error|details?)\b/i.test(output);
}

export function hasUnverifiedCompletionClaim(output: string): boolean {
  return COMPLETION_CLAIM.test(output) && !ACKNOWLEDGED_GAP.test(output);
}

export function hasDeferredExecutionResponse(output: string): boolean {
  if (ACKNOWLEDGED_GAP.test(output)) return false;
  if (DEFERRED_EXECUTION_PROMISE.test(output)) return true;
  return [...output.matchAll(PLANNED_ACTION_LINE)].length >= 2;
}

export type SupervisorDraftDecision = { accepted: true } | {
  accepted: false;
  code: 'missing_review_passes' | 'response_style' | 'premature_evidence_request' | 'deferred_execution' | 'unverified_completion';
  reason: string;
  recoveryRequirement: string;
};

export function supervisedRetryPrompt(originalPrompt: string, decision: Exclude<SupervisorDraftDecision, { accepted: true }>): string {
  // Presentation repair must never replay a task that already used tools or
  // mutated state. The rejected draft is embedded in the recovery requirement,
  // so a fresh provider can rewrite it without receiving the executable task.
  return decision.code === 'response_style'
    ? decision.recoveryRequirement
    : `${originalPrompt}\n\n${decision.recoveryRequirement}`;
}

export function supervisorRetryError(decision: SupervisorDraftDecision): string | null {
  if (decision.accepted || decision.code === 'response_style') return null;
  return `${decision.reason} The response was rejected after one automatic supervisor retry.`;
}

export function superviseDraft(kind: AgentRun['kind'], output: string, evidence: { investigated: boolean; executed: boolean }, options: { verbose?: boolean } = {}): SupervisorDraftDecision {
  if (kind === 'review') {
    const missing = missingReviewPasses(output);
    if (missing.length) return {
      accepted: false, code: 'missing_review_passes',
      reason: `Review omitted mandatory Pass ${missing.join(', Pass ')}.`,
      recoveryRequirement: reviewPassCompletionRequirement(output, missing),
    };
  }
  const styleProblem = responseStyleViolation(output, { verbose: options.verbose, review: kind === 'review' });
  if (styleProblem) return {
    accepted: false, code: 'response_style',
    reason: `Response broke the global brevity rule. ${styleProblem}`,
    recoveryRequirement: `Formatting-only retry: rewrite the rejected draft below and return one complete replacement answer. Do not call tools, repeat file edits, rerun commands, or repeat external actions. ${styleProblem} Apply the global brevity rule: lead with the result, use plain English and short sentences, remove investigation narration and unexplained engineering shorthand, and use compact bullets for multiple findings. Preserve material findings and exact evidence by shortening each item, not by dropping it. ${kind === 'review' ? 'Keep all five named pass sections. Use one compact bullet per actual finding with the impact, fix, and file/line in parentheses; target 300 words and never exceed 350.' : 'Target 90 words and never exceed 120.'} This is not a verbose turn.\n\nRejected draft:\n${output}`,
  };
  if (!evidence.investigated && hasPrematureEvidenceRequest(output)) return {
    accepted: false, code: 'premature_evidence_request',
    reason: 'Agent asked Jeffrey for inspectable evidence without investigating available sources first.',
    recoveryRequirement: 'Recovery requirement: inspect the existing conversation, memory, repository, logs, and database as applicable before asking Jeffrey for evidence. Complete the original request now; do not repeat the request for examples or details.',
  };
  if (kind === 'execute' && hasDeferredExecutionResponse(output)) return {
    accepted: false, code: 'deferred_execution',
    reason: 'Agent returned a plan or promise instead of executing the selected execute turn.',
    recoveryRequirement: 'Recovery requirement: the selected category is execute. Perform the requested action now with the available tools. Do not return another plan, ask for confirmation, or promise later work. Report only a concrete tool error if blocked.',
  };
  if (!evidence.executed && hasUnverifiedCompletionClaim(output)) return {
    accepted: false, code: 'unverified_completion',
    reason: 'Agent reported completion without executing a command or changing a file.',
    recoveryRequirement: 'Recovery requirement: exercise the requested outcome against the real system before reporting completion. If it cannot be verified in this run, state the exact unverified gap instead.',
  };
  return { accepted: true };
}

export function preserveReviewPassesAfterFormatting(rawOutput: string, formattedOutput: string, objective: string): string {
  if (!missingReviewPasses(formattedOutput).length) return formattedOutput;
  const normalizedRaw = normalizeFinalResponse(rawOutput);
  if (!finalResponsePolicyViolation(normalizedRaw) && !missingReviewPasses(normalizedRaw).length) return normalizedRaw;
  return fallbackFinalResponse(rawOutput, objective, true);
}

export async function finalizeSupervisedOutput(input: {
  kind: AgentRun['kind'];
  rawOutput: string;
  draftOutput?: string;
  objective: string;
  verbose: boolean;
}): Promise<string> {
  const normalized = normalizeFinalResponse(input.draftOutput ?? input.rawOutput);
  let output = finalResponseEditingEnabled() && finalResponsePolicyViolation(normalized, input.verbose)
    ? await editFinalResponse(normalized, input.objective, { verbose: input.verbose })
    : normalized;
  if (input.kind === 'review') {
    output = preserveReviewPassesAfterFormatting(input.rawOutput, output, input.objective);
    const missing = missingReviewPasses(output);
    if (missing.length) throw new Error(`Final review response omitted mandatory Pass ${missing.join(', Pass ')}.`);
  }
  return output;
}

export function supervisorSynthesisContract(kind: AgentRun['kind'] | null | undefined): string {
  return kind === 'review'
    ? 'Synthesize the two supplied code reviews into one short, plain-English five-pass review. Use these headings in order: `### Pass 1 — Does it work?`, `### Pass 2 — Will it stay fast?`, `### Pass 3 — Does it fit the codebase?`, `### Pass 4 — Is it good for users?`, and `### Pass 5 — Is it safe?` Deduplicate overlap. Under each heading, retain every unique actual finding as one compact bullet: severity, what breaks, the fix, then file/line evidence in parentheses. Use at most two short sentences per finding. If neither reviewer found a material issue in a pass, write exactly `No material issues.` Lead with approve or reject and the human consequence. Do not repeat investigation mechanics or unexplained engineering shorthand. Target 120 words and never exceed 350 words unless Jeffrey explicitly asked for a verbose response.'
    : 'Write a concise synthesis of the two supplied agent responses below.';
}
