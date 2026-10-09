import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SUPERVISOR_EVIDENCE_REASON_PREFIX, type DiffHunkReview, type WorkspaceDiff } from '../shared/contracts.js';
import { buildReviewDecisions } from '../shared/review-decisions.js';
import { adversarialLensPrompt, buildReviewHarness, mergeAgentVerdict, parseAdversarialLedger, parseReviewLedger, reviewHarnessVerdicts, stripAdversarialLedger, type ReviewHarness, type ReviewLensLedgers } from '../shared/review-harness.js';
import { parseGitHubPullRequestUrl } from './github-pull-request-diff.js';
import { publishRealtimeEvent } from './realtime.js';
import type { DiffReviewScope, WorkItemRepository } from './repository.js';
import { getWorkspaceDiff } from './workspace-diff.js';

export interface ReviewHarnessScopes { workItemId: string | null; conversationId: string | null }

const PULL_REQUEST_URL = /https?:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/\d+/i;

/** The pull request a review request names, if any. The supervisor brokers
 * exactly this URL so the harness finds the snapshot it resolves against. */
export function reviewPullRequestUrl(requestText: string): string | null {
  return PULL_REQUEST_URL.exec(requestText)?.[0] ?? null;
}

function scopesOf(scopes: ReviewHarnessScopes): DiffReviewScope[] {
  return [
    ...(scopes.workItemId ? [{ workItemId: scopes.workItemId }] : []),
    ...(scopes.conversationId ? [{ conversationId: scopes.conversationId }] : []),
  ];
}

/** The PR diff the supervisor already brokered for this turn. The harness
 * never fetches GitHub itself: one immutable snapshot is the evidence both the
 * agent and the review queue read. */
function brokeredPullRequestDiff(repository: WorkItemRepository, scopes: ReviewHarnessScopes, url: string): WorkspaceDiff | null {
  const target = parseGitHubPullRequestUrl(url);
  if (!target) return null;
  const snapshotScopes = [
    ...(scopes.conversationId ? [{ conversationId: scopes.conversationId }] : []),
    ...(scopes.workItemId ? [{ workItemId: scopes.workItemId }] : []),
  ];
  for (const scope of snapshotScopes) {
    for (const snapshot of repository.listWorkspaceDiffSnapshots(scope)) {
      const reason = snapshot.diff.publish.reason ?? '';
      if (!reason.startsWith(SUPERVISOR_EVIDENCE_REASON_PREFIX)) continue;
      const snapshotTarget = parseGitHubPullRequestUrl(reason.slice(SUPERVISOR_EVIDENCE_REASON_PREFIX.length).replace(/\.$/, ''));
      if (snapshotTarget
        && snapshotTarget.owner.toLowerCase() === target.owner.toLowerCase()
        && snapshotTarget.repository.toLowerCase() === target.repository.toLowerCase()
        && snapshotTarget.number === target.number) return snapshot.diff;
    }
  }
  return null;
}

function storedReviews(repository: WorkItemRepository, scopes: ReviewHarnessScopes, revision: string): DiffHunkReview[] {
  return scopesOf(scopes).flatMap((scope) => repository.listDiffHunkReviews(scope, revision));
}

/**
 * Resolve what this review reads and build its harness. A pull-request URL in
 * the request is authoritative, exactly as the supervisor contract says;
 * otherwise the review reads the checkout the agent runs in.
 */
export async function resolveReviewHarness(
  repository: WorkItemRepository,
  input: { scopes: ReviewHarnessScopes; cwd: string; requestText: string },
): Promise<ReviewHarness> {
  const url = reviewPullRequestUrl(input.requestText);
  if (url) {
    const diff = brokeredPullRequestDiff(repository, input.scopes, url);
    if (!diff) return buildReviewHarness({ source: { kind: 'unavailable', reason: `Workbench has no brokered diff for ${url}.` }, revision: null, files: [], reviews: [] });
    return buildReviewHarness({ source: { kind: 'pull-request', url, baseSha: diff.baseSha ?? null }, revision: diff.revision, files: diff.files, reviews: storedReviews(repository, input.scopes, diff.revision) });
  }
  let diff: WorkspaceDiff;
  try { diff = await getWorkspaceDiff(input.cwd); }
  catch (error) {
    return buildReviewHarness({ source: { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }, revision: null, files: [], reviews: [] });
  }
  return buildReviewHarness({ source: { kind: 'workspace', workspacePath: diff.workspacePath }, revision: diff.revision, files: diff.files, reviews: storedReviews(repository, input.scopes, diff.revision) });
}

export function describeReviewHarness(harness: ReviewHarness): string {
  if (harness.source.kind === 'unavailable') return `Review harness v${harness.version}: diff unavailable (${harness.source.reason}); five passes over the whole change are still required.`;
  return `Review harness v${harness.version}: ${harness.required.length} Review Director decision(s) × 5 passes required; ${harness.settled.length} settled by proof.`;
}

/**
 * Write the accepted review's verdicts into the queue Jeffrey reads, hunk by
 * hunk. A hunk that already carries a human or Director verdict is left alone.
 */
export function recordReviewHarnessVerdicts(
  repository: WorkItemRepository,
  harness: ReviewHarness,
  output: string,
  scopes: ReviewHarnessScopes,
  attribution: string,
): { recorded: number; kept: number } {
  const parsed = parseReviewLedger(output);
  if (!harness.revision || !parsed.ledger) return { recorded: 0, kept: 0 };
  const verdicts = reviewHarnessVerdicts(harness, parsed.ledger, attribution, new Date().toISOString());
  const recordedDecisions = new Set<number>();
  const keptDecisions = new Set<number>();
  for (const scope of scopesOf(scopes)) {
    const current = new Map(buildReviewDecisions(harness.files, repository.listDiffHunkReviews(scope, harness.revision))
      .flatMap((decision) => decision.hunks.map((hunk) => [`${hunk.filePath}\u0000${hunk.hunkRange}`, hunk] as const)));
    for (const verdict of verdicts) {
      for (const target of verdict.hunks) {
        const hunk = current.get(`${target.filePath}\u0000${target.hunkRange}`);
        const merged = hunk ? mergeAgentVerdict(hunk, verdict) : null;
        if (!merged) { keptDecisions.add(verdict.ordinal); continue; }
        repository.upsertDiffHunkReview(scope, { revision: harness.revision, ...target, state: merged.state, note: merged.note });
        recordedDecisions.add(verdict.ordinal);
      }
    }
  }
  if (recordedDecisions.size) publishRealtimeEvent('work-items', 'shared');
  return { recorded: recordedDecisions.size, kept: [...keptDecisions].filter((ordinal) => !recordedDecisions.has(ordinal)).length };
}

const execFileAsync = promisify(execFile);

/** Automatic failure-mode reviews use Codex to avoid provider safeguard refusals. */
export function adversarialLensAgent(correctnessAgent: string): 'claude' | 'codex' {
  void correctnessAgent;
  return 'codex';
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd, timeout: 60_000, maxBuffer: 1_048_576 })).stdout.trim();
}

/**
 * Run the failure-mode lens in a read-only checkout at the
 * merge base, given the diff and the task's requirement and nothing from the
 * correctness lens. The lens never throws: a failure becomes the ledger's
 * error, so it can never fail the review run that owns it.
 */
export async function runAdversarialLens(input: {
  agent: 'claude' | 'codex';
  harness: ReviewHarness;
  cwd: string;
  requirement: string;
  acceptanceCriteria: string[];
  runAgent: (agent: 'claude' | 'codex', cwd: string, prompt: string) => Promise<string>;
}): Promise<ReviewLensLedgers['adversarial']> {
  const { agent, harness } = input;
  const failed = (error: string, baseSha: string | null = null): ReviewLensLedgers['adversarial'] => ({ agent, baseSha, ledger: null, summary: '', error });
  if (!harness.files.length) return failed('There was no diff to evaluate.');
  let checkout: string | null = null;
  let baseSha: string | null = null;
  try {
    // A pull request names its base. A working-tree diff is taken against HEAD, so HEAD is its merge base.
    baseSha = harness.source.kind === 'pull-request' && harness.source.baseSha ? harness.source.baseSha : await git(input.cwd, ['rev-parse', 'HEAD']);
    checkout = await mkdtemp(join(tmpdir(), 'workbench-adversarial-'));
    await git(input.cwd, ['worktree', 'add', '--detach', checkout, baseSha]);
    await execFileAsync('chmod', ['-R', 'a-w', checkout]);
    const output = await input.runAgent(agent, checkout, adversarialLensPrompt({
      requirement: input.requirement,
      acceptanceCriteria: input.acceptanceCriteria,
      baseSha,
      files: harness.files,
    }));
    const parsed = parseAdversarialLedger(output);
    return { agent, baseSha, ledger: parsed.ledger, summary: stripAdversarialLedger(output).slice(0, 4_000), error: parsed.error };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error), baseSha);
  } finally {
    if (checkout) {
      const path = checkout;
      await execFileAsync('chmod', ['-R', 'u+w', path]).catch(() => undefined);
      await git(input.cwd, ['worktree', 'remove', '--force', path]).catch(() => undefined);
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
