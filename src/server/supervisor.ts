import type { AgentRun } from '../shared/contracts.js';
import { missingRequiredExecutables, type ExternalActionAuthorization } from './external-action-authorization.js';
import {
  editFinalResponse,
  fallbackFinalResponse,
  finalResponseEditingEnabled,
  finalResponsePolicyViolation,
  normalizeFinalResponse,
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
- Finish each pass before starting the next. The final review must contain five sections headed exactly "### Pass 1" through "### Pass 5", in order. Inside each section, write every actual finding from that pass with its Blocking or Non-blocking severity, file/line evidence, impact, and recommended change. If a pass found nothing, write exactly "No material issues." Never replace findings with counts or a statement that the pass ran. Deduplicate a cross-cutting finding by placing it in its primary pass and cross-referencing it from another pass only when that adds useful context.
- Label every finding or risk as Blocking or Non-blocking. Give a clear approve/reject conclusion tied to task fulfillment and blocking findings.
- Keep investigation narration minimal. Return the review, not a transcript of file reads.
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
  if (kind !== 'review') return `${category}\n\n${sourceAuthority}`.trim();
  return `${category}\n\n${FRONTEND_REVIEWER_PERSONA}\n\n${sourceAuthority}`.trim();
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

const COMPLETION_CLAIM = /\b(?:root fix is in|fix is in|now (?:fixed|works|working)|is fixed|are fixed|has been fixed|have been fixed|fixed the|resolved the|works end[- ]to[- ]end|verified live|verified end[- ]to[- ]end|fully (?:working|verified)|all set|tests? pass(?:es|ed|ing)?)\b/i;
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
  code: 'missing_review_passes' | 'premature_evidence_request' | 'deferred_execution' | 'unverified_completion';
  reason: string;
  recoveryRequirement: string;
};

export function superviseDraft(kind: AgentRun['kind'], output: string, evidence: { investigated: boolean; executed: boolean }): SupervisorDraftDecision {
  if (kind === 'review') {
    const missing = missingReviewPasses(output);
    if (missing.length) return {
      accepted: false, code: 'missing_review_passes',
      reason: `Review omitted mandatory Pass ${missing.join(', Pass ')}.`,
      recoveryRequirement: reviewPassCompletionRequirement(output, missing),
    };
  }
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
    ? 'Synthesize the two supplied code reviews into one complete five-pass review. Use exact headings `### Pass 1` through `### Pass 5` in order. Under each heading, retain and reconcile every actual finding from that pass with its `Blocking:` or `Non-blocking:` severity, concrete file/line evidence, impact, and recommended change. If neither reviewer found a material issue in a pass, write exactly `No material issues.` Do not replace findings with counts or a statement that a pass ran.'
    : 'Write a concise synthesis of the two supplied agent responses below.';
}
