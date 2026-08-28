import { existsSync } from 'node:fs';
import { buildReviewDecisions, reviewAssistDecisionPayload } from '../shared/review-decisions.js';
import { publishRealtimeReviewScore } from './realtime.js';
import { requestReviewAssist } from './review-assist-ai.js';
import type { WorkItemRepository } from './repository.js';
import { getWorkspaceDiff } from './workspace-diff.js';

export type ReviewScoreScope = { workItemId: string } | { conversationId: string };

export type ReviewScoreEntry = { decisionId: string; ordinal: number; answer: string | null; error: string | null };

export type ReviewAutoScoreSnapshot = {
  revision: string;
  running: boolean;
  completed: number;
  total: number;
  /** Decisions past the cap that were deliberately not auto-scored. Reported
   * rather than hidden: silent truncation reads as "everything was scored". */
  skipped: number;
  entries: ReviewScoreEntry[];
};

/** A diff large enough to exceed this is one no reviewer reads in a sitting,
 * and scoring all of it would hold the assist pool for minutes. The remainder
 * stays available on demand from each decision's own Score risk button. */
const MAX_AUTO_SCORED_DECISIONS = 40;

type ScoreJob = {
  scope: ReviewScoreScope;
  revision: string;
  total: number;
  skipped: number;
  running: boolean;
  completed: number;
  entries: Map<string, ReviewScoreEntry>;
};

const jobs = new Map<string, ScoreJob>();
const inFlight = new Map<string, Promise<void>>();
const rerunRequested = new Set<string>();

function scopeKey(scope: ReviewScoreScope): string {
  return 'workItemId' in scope ? `work-item:${scope.workItemId}` : `conversation:${scope.conversationId}`;
}

/** The reviewer's own repository selection wins, because that is the checkout
 * the Changes pane renders: scoring a different one would produce decisions
 * whose ids never match anything on screen. The agent's working directory is
 * only the fallback for a scope nobody has explicitly pointed at a repo yet. */
function resolveScoreWorkspace(repository: WorkItemRepository, scope: ReviewScoreScope, fallback: string | null): string | null {
  const row = 'workItemId' in scope
    ? repository.database.prepare('SELECT workspace_path FROM work_item_workspace_selection WHERE work_item_id = ?').get(scope.workItemId)
    : repository.database.prepare('SELECT workspace_path FROM shared_conversation_workspace_selection WHERE conversation_id = ?').get(scope.conversationId);
  const selected = (row as { workspace_path?: string } | undefined)?.workspace_path;
  if (selected && existsSync(selected)) return selected;
  return fallback && existsSync(fallback) ? fallback : null;
}

async function runScoreJob(repository: WorkItemRepository, scope: ReviewScoreScope, fallbackWorkspace: string | null): Promise<void> {
  const key = scopeKey(scope);
  const workspacePath = resolveScoreWorkspace(repository, scope, fallbackWorkspace);
  if (!workspacePath) return;
  const diff = await getWorkspaceDiff(workspacePath);
  if (diff.changedFiles === 0) {
    jobs.delete(key);
    return;
  }
  const decisions = buildReviewDecisions(diff.files, repository.listDiffHunkReviews(scope, diff.revision));
  const scoreable = decisions.slice(0, MAX_AUTO_SCORED_DECISIONS);
  const job: ScoreJob = {
    scope,
    revision: diff.revision,
    total: scoreable.length,
    skipped: decisions.length - scoreable.length,
    running: true,
    completed: 0,
    entries: new Map(),
  };
  jobs.set(key, job);
  try {
    // Serial on purpose. The warm assist pool holds two sessions; taking both
    // for background work would make a reviewer's own click pay a cold start,
    // which is the exact cost the pool exists to avoid.
    for (const decision of scoreable) {
      let answer: string | null = null;
      let error: string | null = null;
      try {
        answer = await requestReviewAssist(repository.database, 'score_risk', reviewAssistDecisionPayload(decision), null);
      } catch (failure) {
        // A failed turn is reported as a failure the reviewer can retry from
        // the panel, never as an absent or neutral score.
        error = failure instanceof Error ? failure.message : 'Background risk scoring failed.';
      }
      job.completed += 1;
      job.entries.set(decision.id, { decisionId: decision.id, ordinal: decision.ordinal, answer, error });
      publishRealtimeReviewScore({
        scope, revision: job.revision, decisionId: decision.id, answer, error, completed: job.completed, total: job.total,
      });
    }
  } finally {
    job.running = false;
  }
}

/**
 * Scores every decision in a scope's current diff in the background and streams
 * each result as it settles. Called when an agent run comes to rest, so the
 * reviewer opens Changes to panels that are already populating rather than to a
 * queue that only scores what they happen to dwell on.
 *
 * Answers land in the same durable assist cache the on-demand buttons read, so
 * a decision scored here costs nothing when the reviewer opens it, and a
 * decision already scored costs nothing here.
 */
export function scheduleReviewAutoScore(repository: WorkItemRepository, scope: ReviewScoreScope, fallbackWorkspace: string | null): Promise<void> {
  const key = scopeKey(scope);
  const active = inFlight.get(key);
  // A second run finishing mid-job means the diff moved under us; queue exactly
  // one rerun rather than racing two jobs over the same scope.
  if (active) {
    rerunRequested.add(key);
    return active;
  }
  const promise = runScoreJob(repository, scope, fallbackWorkspace)
    .catch(() => {
      // Whole-job failures (no repo, git unavailable) stay silent: nobody asked
      // for this pass, and every decision still scores on demand.
    })
    .finally(() => {
      inFlight.delete(key);
      if (rerunRequested.delete(key)) void scheduleReviewAutoScore(repository, scope, fallbackWorkspace);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Replay for a pane that opened after — or in the middle of — a job, since
 * realtime frames are ephemeral and a late client would otherwise see nothing
 * until the next agent run. */
export function reviewAutoScoreSnapshot(scope: ReviewScoreScope, revision: string): ReviewAutoScoreSnapshot | null {
  const job = jobs.get(scopeKey(scope));
  if (!job || job.revision !== revision) return null;
  return {
    revision: job.revision,
    running: job.running,
    completed: job.completed,
    total: job.total,
    skipped: job.skipped,
    entries: [...job.entries.values()],
  };
}

/** Test seam: job state is process-local, so suites that assert on progress
 * must not inherit a previous test's job. */
export function resetReviewAutoScore(): void {
  jobs.clear();
  inFlight.clear();
  rerunRequested.clear();
}
