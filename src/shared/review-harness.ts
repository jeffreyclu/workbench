import { z } from 'zod';
import { changeTypeLabel } from './change-type.js';
import type { DiffHunkReview, DiffHunkReviewState, WorkspaceDiffFile } from './contracts.js';
import { createReviewDirectorPlan } from './review-director.js';
import { blockObligations } from './review-obligations.js';
import type { ReviewTier } from './review-routing.js';

/**
 * The review harness every agent review runs.
 *
 * Jeffrey reviews through the Review Director: one queue of decisions, priced
 * and ordered by the same router, each owing the same questions. An agent
 * review is held to that exact queue. The harness is deterministic: the same
 * diff and the same stored verdicts always produce the same decisions, the
 * same order, and the same pass-by-decision coverage the agent must return.
 * Nothing here calls a model.
 */
export const REVIEW_HARNESS_VERSION = 1;

export const REVIEW_PASSES = [
  { number: 1, key: 'correctness', heading: 'Pass 1 — Does it work?', focus: 'Correctness and readability: task fulfillment, control flow, data flow, naming, maintainability, failure handling, and concrete bugs.' },
  { number: 2, key: 'performance', heading: 'Pass 2 — Will it stay fast?', focus: 'Performance and scaling: rendering, algorithms, I/O, queries, caching, concurrency, resource use, and behavior as data, traffic, tenants, or call sites grow.' },
  { number: 3, key: 'conventions', heading: 'Pass 3 — Does it fit the codebase?', focus: 'Conventions and existing patterns: repository rules, nearby implementations, shared abstractions, API contracts, naming, and consistency with established architecture. Prefer local conventions; recommend a different pattern only when the diff adds avoidable complexity or breaks correctness.' },
  { number: 4, key: 'ux', heading: 'Pass 4 — Is it good for users?', focus: 'UX issues and bugs: user flows, loading/empty/error/permission states, accessibility, responsive behavior, feedback, recovery, stale UI, races, and confusing or broken interactions.' },
  { number: 5, key: 'security', heading: 'Pass 5 — Is it safe?', focus: 'Security: authentication, authorization, trust boundaries, validation, injection, secrets, privacy, data exposure, and abuse cases.' },
] as const;

export type ReviewPassNumber = typeof REVIEW_PASSES[number]['number'];
export const REVIEW_PASS_NUMBERS: readonly ReviewPassNumber[] = REVIEW_PASSES.map((pass) => pass.number);

/** Decision 0 is the whole change: task fulfillment and anything that is not
 * about one block, such as a file the task needed that the diff never touched. */
export const WHOLE_CHANGE_DECISION = 0;

/** Every verdict the harness writes starts with this, so the queue can always
 * tell an agent's verdict from Jeffrey's and never overwrites his. */
export const AGENT_REVIEW_NOTE_PREFIX = 'Agent review';

const LEDGER_PATTERN = /<review-ledger>([\s\S]*?)<\/review-ledger>/i;
const MAX_NOTE_CHARS = 4_000;

export type ReviewHarnessSource =
  | { kind: 'workspace'; workspacePath: string }
  | { kind: 'pull-request'; url: string; baseSha: string | null }
  | { kind: 'unavailable'; reason: string };

export interface ReviewHarnessHunk { filePath: string; hunkRange: string; contentHash: string }

export interface ReviewHarnessDecision {
  ordinal: number;
  decisionId: string;
  tier: ReviewTier;
  tierReason: string;
  changeType: string;
  behavior: string;
  locations: string[];
  obligations: string[];
  hunks: ReviewHarnessHunk[];
}

export interface ReviewHarness {
  version: typeof REVIEW_HARNESS_VERSION;
  source: ReviewHarnessSource;
  revision: string | null;
  /** The diff the plan was built from. Recording verdicts rebuilds the plan
   * from these files against the verdicts stored at that moment. */
  files: WorkspaceDiffFile[];
  /** Every decision that needs a reviewer, in Review Director priority order. */
  required: ReviewHarnessDecision[];
  /** Decisions the Director already settled by proof, which no pass reopens. */
  settled: Array<{ ordinal: number; locations: string[]; reason: string }>;
}

export function buildReviewHarness(input: {
  source: ReviewHarnessSource;
  revision: string | null;
  files: WorkspaceDiffFile[];
  reviews: DiffHunkReview[];
}): ReviewHarness {
  const plan = createReviewDirectorPlan(input.files, input.reviews);
  const required: ReviewHarnessDecision[] = [];
  const settled: ReviewHarness['settled'] = [];
  for (const decision of plan.orderedDecisions) {
    const entry = plan.byDecisionId.get(decision.id)!;
    const locations = decision.hunks.map((hunk) => `${hunk.filePath} (${hunk.location})`);
    if (entry.routing.autoSettled) {
      settled.push({ ordinal: decision.ordinal, locations, reason: entry.routing.reason });
      continue;
    }
    required.push({
      ordinal: decision.ordinal,
      decisionId: decision.id,
      tier: entry.tier,
      tierReason: entry.routing.reason,
      changeType: changeTypeLabel(decision.changeType),
      behavior: decision.behavior,
      locations,
      obligations: blockObligations(decision).map((obligation) => obligation.question),
      hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, hunkRange: hunk.hunkRange, contentHash: hunk.contentHash })),
    });
  }
  return { version: REVIEW_HARNESS_VERSION, source: input.source, revision: input.revision, files: input.files, required, settled };
}

function sourceLine(harness: ReviewHarness): string {
  const { source } = harness;
  if (source.kind === 'workspace') return `Local checkout ${source.workspacePath} at revision ${harness.revision}.`;
  if (source.kind === 'pull-request') {
    return source.baseSha
      ? `Pull request ${source.url} from base ${source.baseSha} to head ${harness.revision}. Compare with \`git diff ${source.baseSha}...${harness.revision}\`, never a local branch.`
      : `Pull request ${source.url} at head ${harness.revision}. Workbench did not record its base commit; name the base you compare against.`;
  }
  return `Unavailable: ${source.reason}`;
}

/** The algorithm the agent runs, rendered from the harness alone. */
export function reviewHarnessPrompt(harness: ReviewHarness): string {
  const decisions = harness.required.length
    ? harness.required.map((decision) => [
      `- D${decision.ordinal} · ${decision.tier} · ${decision.changeType} · ${decision.locations.join('; ')}`,
      `  What changed: ${decision.behavior}`,
      `  Why this tier: ${decision.tierReason}`,
      ...decision.obligations.map((question) => `  Owes: ${question}`),
    ].join('\n')).join('\n')
    : harness.source.kind === 'unavailable'
      ? '- None. Workbench could not read the diff (see Source). Review the whole change as D0 and name that gap in Pass 1.'
      : '- None. Every change in this diff is settled by proof or there are no changes; review the whole change as D0.';
  const settled = harness.settled.length
    ? `\nSettled by proof (do not reopen): ${harness.settled.map((entry) => `D${entry.ordinal} ${entry.locations.join('; ')}`).join(' | ')}`
    : '';
  const ordinals = harness.required.map((decision) => decision.ordinal);
  return `Review harness v${REVIEW_HARNESS_VERSION} (deterministic; Workbench enforces it):
This is the same Review Director queue Jeffrey reviews. Workbench built it from the diff and his stored verdicts.
Source: ${sourceLine(harness)}
Decisions, in Review Director priority order:
${decisions}${settled}

Run this algorithm exactly, every time:
1. Read the task intent. It is D0, the whole change.
2. For Pass 1 through Pass 5, in order, visit D0 and then every decision above in the listed order. Read its hunks and the surrounding code it needs.
${REVIEW_PASSES.map((pass) => `   - ${pass.heading}: ${pass.focus}`).join('\n')}
3. In each pass, answer the pass question and the decision's owed questions. Mark each decision clear, or record every blocking or non-blocking finding against it.
4. Write the five-pass review with the exact headings above.
5. End with exactly one ledger block. Every pass must list every decision number (${ordinals.length ? ordinals.join(', ') : 'none'}) exactly once, either in clear or in findings. D0 appears only as a finding. A pass with ledger findings must list them in its section; a pass without findings must say "No material issues."
<review-ledger>{"version":${REVIEW_HARNESS_VERSION},"passes":[{"pass":1,"clear":[<decision numbers with no finding>],"findings":[{"decision":<decision number or 0>,"severity":"blocking" or "non-blocking","finding":"<what breaks, the fix, file:line>"}]}, …one object per pass, 1 through 5]}</review-ledger>
Workbench rejects a ledger that skips a pass or a decision. It then records your verdicts in Jeffrey's review queue: blocking becomes Needs changes, non-blocking becomes Commented, clear decisions stay for Jeffrey. It never overwrites his verdicts.`;
}

const ledgerSchema = z.object({
  version: z.literal(REVIEW_HARNESS_VERSION),
  passes: z.array(z.object({
    pass: z.number().int(),
    clear: z.array(z.number().int().nonnegative()),
    findings: z.array(z.object({
      decision: z.number().int().nonnegative(),
      severity: z.enum(['blocking', 'non-blocking']),
      finding: z.string().trim().min(1).max(1_000),
    })),
  })),
});

export type ReviewLedger = z.infer<typeof ledgerSchema>;

export type ReviewLedgerParse = { ledger: ReviewLedger; error: null } | { ledger: null; error: string };

export function parseReviewLedger(output: string): ReviewLedgerParse {
  const blocks = output.match(new RegExp(LEDGER_PATTERN.source, 'gi')) ?? [];
  if (blocks.length === 0) return { ledger: null, error: 'The review has no <review-ledger> block.' };
  if (blocks.length > 1) return { ledger: null, error: `The review has ${blocks.length} <review-ledger> blocks; return exactly one.` };
  let json: unknown;
  try { json = JSON.parse(LEDGER_PATTERN.exec(output)![1].trim()); }
  catch (error) { return { ledger: null, error: `The <review-ledger> block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }; }
  const parsed = ledgerSchema.safeParse(json);
  if (!parsed.success) return { ledger: null, error: `The <review-ledger> block does not match the harness schema: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'ledger'} ${issue.message}`).join('; ')}.` };
  return { ledger: parsed.data, error: null };
}

/** A brevity-only rewrite may drop the ledger it was told to copy. Carry the
 * earlier one forward; the rewritten prose is still checked against it. */
export function carryReviewLedger(previous: string, next: string): string {
  if (LEDGER_PATTERN.test(next)) return next;
  const ledger = previous.match(new RegExp(LEDGER_PATTERN.source, 'gi'));
  return ledger?.length === 1 ? `${next.trim()}\n\n${ledger[0]}` : next;
}

export function stripReviewLedger(output: string): string {
  return output.replace(new RegExp(LEDGER_PATTERN.source, 'gi'), '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Whether a rendered pass section reports "No material issues." Headings
 * follow the same grammar the supervisor enforces. */
function passSectionIsClear(output: string, pass: number): boolean | null {
  const heading = new RegExp(`^###[ \\t]+Pass[ \\t]+${pass}(?:[ \\t]*[—:.-].*)?[ \\t]*$`, 'im').exec(output);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const next = /^###[ \t]+Pass[ \t]+[1-5](?:[ \t]*[—:.-].*)?[ \t]*$/gim;
  next.lastIndex = start;
  const end = next.exec(output)?.index ?? output.length;
  return /^No material issues\.(?:\s|$)/i.test(output.slice(start, end).trim());
}

/**
 * Every way the review failed the harness, in a fixed order. Empty means the
 * review covered every required decision in every pass and its prose agrees
 * with its ledger.
 */
export function reviewHarnessViolations(harness: ReviewHarness, output: string): string[] {
  const parsed = parseReviewLedger(output);
  if (!parsed.ledger) return [parsed.error];
  const problems: string[] = [];
  const required = new Set(harness.required.map((decision) => decision.ordinal));
  const passNumbers = parsed.ledger.passes.map((pass) => pass.pass);
  if (passNumbers.join(',') !== REVIEW_PASS_NUMBERS.join(',')) {
    problems.push(`The ledger must list passes ${REVIEW_PASS_NUMBERS.join(', ')} once each, in order; it listed ${passNumbers.join(', ') || 'none'}.`);
  }
  for (const pass of parsed.ledger.passes) {
    if (!REVIEW_PASS_NUMBERS.includes(pass.pass as ReviewPassNumber)) continue;
    const clear = new Set(pass.clear);
    const withFindings = new Set(pass.findings.map((finding) => finding.decision));
    const unknown = [...new Set([...pass.clear, ...withFindings])]
      .filter((ordinal) => ordinal !== WHOLE_CHANGE_DECISION && !required.has(ordinal))
      .sort((left, right) => left - right);
    if (unknown.length) problems.push(`Pass ${pass.pass} names decisions that are not in the harness: ${unknown.map((ordinal) => `D${ordinal}`).join(', ')}.`);
    if (clear.has(WHOLE_CHANGE_DECISION)) problems.push(`Pass ${pass.pass} lists D0 as clear; D0 appears only as a finding.`);
    if (clear.size !== pass.clear.length) problems.push(`Pass ${pass.pass} lists a decision as clear more than once.`);
    const both = [...clear].filter((ordinal) => withFindings.has(ordinal)).sort((left, right) => left - right);
    if (both.length) problems.push(`Pass ${pass.pass} marks ${both.map((ordinal) => `D${ordinal}`).join(', ')} both clear and with findings.`);
    const missing = [...required].filter((ordinal) => !clear.has(ordinal) && !withFindings.has(ordinal));
    if (missing.length) problems.push(`Pass ${pass.pass} skipped ${missing.map((ordinal) => `D${ordinal}`).join(', ')}.`);
    const sectionClear = passSectionIsClear(output, pass.pass);
    if (sectionClear === true && pass.findings.length) problems.push(`Pass ${pass.pass} says "No material issues." but its ledger has ${pass.findings.length} finding(s).`);
    if (sectionClear === false && pass.findings.length === 0) problems.push(`Pass ${pass.pass} lists findings in prose but none in its ledger.`);
  }
  return problems;
}

export interface ReviewHarnessVerdict {
  ordinal: number;
  decisionId: string;
  hunks: ReviewHarnessHunk[];
  state: Extract<DiffHunkReviewState, 'needs_changes' | 'commented'>;
  note: string;
}

/** What the ledger means for Jeffrey's queue. A clean decision earns no
 * verdict: approval stays his, and only the Director's own gates auto-approve. */
export function reviewHarnessVerdicts(harness: ReviewHarness, ledger: ReviewLedger, attribution: string): ReviewHarnessVerdict[] {
  return harness.required.flatMap((decision) => {
    const findings = ledger.passes.flatMap((pass) => pass.findings
      .filter((finding) => finding.decision === decision.ordinal)
      .map((finding) => ({ pass: pass.pass, ...finding })));
    if (!findings.length) return [];
    const state = findings.some((finding) => finding.severity === 'blocking') ? 'needs_changes' as const : 'commented' as const;
    const lines = findings.map((finding) => `Pass ${finding.pass} ${finding.severity === 'blocking' ? 'Blocking' : 'Non-blocking'}: ${finding.finding}`);
    return [{
      ordinal: decision.ordinal,
      decisionId: decision.decisionId,
      hunks: decision.hunks,
      state,
      note: `${AGENT_REVIEW_NOTE_PREFIX} (${attribution}):\n${lines.join('\n')}`.slice(0, MAX_NOTE_CHARS),
    }];
  });
}

/** An agent verdict may replace an earlier agent verdict, never a human or
 * Director verdict. When two agent reviews disagree, the stricter state wins
 * and both notes are kept. */
export function mergeAgentVerdict(
  existing: { state: DiffHunkReviewState | null; note: string | null },
  verdict: Pick<ReviewHarnessVerdict, 'state' | 'note'>,
): { state: ReviewHarnessVerdict['state']; note: string } | null {
  if (existing.state === null) return { state: verdict.state, note: verdict.note };
  if (!existing.note?.startsWith(AGENT_REVIEW_NOTE_PREFIX)) return null;
  if (existing.note.includes(verdict.note)) return null;
  const state = existing.state === 'needs_changes' || verdict.state === 'needs_changes' ? 'needs_changes' : 'commented';
  return { state, note: `${existing.note}\n\n${verdict.note}`.slice(0, MAX_NOTE_CHARS) };
}
