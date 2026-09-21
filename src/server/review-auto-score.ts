import { existsSync } from 'node:fs';
import type { ReviewChangeType } from '../shared/change-type.js';
import { reviewAssistDecisionPayload, type ReviewDecision } from '../shared/review-decisions.js';
import { AUTOMATIC_PROOF_REVIEW_NOTE, createReviewDirectorPlan, DELEGATED_REVIEW_NOTE, routeWithAiRisk, type ReviewDirectorEntry } from '../shared/review-director.js';
import { delegationOutcome, isDelegatedTier } from '../shared/review-delegation.js';
import { parseAiRiskScore } from '../shared/review-risk-score.js';
import { publishRealtimeEvent, publishRealtimeReviewScore } from './realtime.js';
import { lookupReviewAssist, requestCriticalReviewAssist, requestReviewAssist, type ReviewAssistAction, type ReviewAssistTaskIntent } from './review-assist-ai.js';
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
  autoReviewed: number;
  criticalCompleted: number;
  criticalTotal: number;
  entries: ReviewScoreEntry[];
};

/** Two independent Haiku turns keep a large review moving without turning an
 * unbounded diff into an unbounded process storm. Identical task/conversation
 * requests are coalesced again in review-assist-ai. */
const AUTO_SCORE_CONCURRENCY = 2;
const AUTO_SCORE_ATTEMPTS = 3;

/** Compatibility helper retained for callers and tests. Review Director now
 * supplies the real queue order; this fallback keeps production semantics
 * ahead of tests and purely mechanical output. */
const AUTO_SCORE_PRIORITY: Record<ReviewChangeType, number> = {
  deletion: 0,
  replacement: 0,
  behavior_edit: 1,
  new_code: 1,
  refactor_pure: 1,
  extension: 2,
  move_rename: 2,
  config_dep: 3,
  test_only: 4,
  docs_comment: 5,
  generated: 5,
};

export function orderDecisionsForAutoScore(decisions: ReviewDecision[]): ReviewDecision[] {
  return [...decisions].sort((left, right) => {
    const byType = AUTO_SCORE_PRIORITY[left.changeType] - AUTO_SCORE_PRIORITY[right.changeType];
    return byType || left.ordinal - right.ordinal;
  });
}

type ScoreJob = {
  scope: ReviewScoreScope;
  revision: string;
  total: number;
  skipped: number;
  running: boolean;
  completed: number;
  autoReviewed: number;
  criticalCompleted: number;
  criticalTotal: number;
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

function resolveTaskIntent(repository: WorkItemRepository, scope: ReviewScoreScope): ReviewAssistTaskIntent {
  const row = 'workItemId' in scope
    ? repository.database.prepare('SELECT title, description FROM work_items WHERE id = ?').get(scope.workItemId)
    : repository.database.prepare(`SELECT work_items.title, work_items.description
        FROM shared_conversations
        JOIN work_items ON work_items.id = shared_conversations.work_item_id
        WHERE shared_conversations.id = ?`).get(scope.conversationId);
  const item = row as { title?: string; description?: string | null } | undefined;
  return item?.title ? { title: item.title, description: item.description ?? '' } : null;
}

async function requestWithRetry(
  repository: WorkItemRepository,
  action: ReviewAssistAction,
  entry: ReviewDirectorEntry,
  decisions: ReviewDecision[],
  taskIntent: ReviewAssistTaskIntent,
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= AUTO_SCORE_ATTEMPTS; attempt += 1) {
    try {
      return await requestReviewAssist(
        repository.database,
        action,
        reviewAssistDecisionPayload(entry.decision, decisions),
        taskIntent,
        undefined,
        entry.tier,
      );
    } catch (failure) {
      lastError = failure instanceof Error ? failure : new Error('Review Director analysis failed.');
      if (attempt < AUTO_SCORE_ATTEMPTS) await new Promise((resolveRetry) => setTimeout(resolveRetry, attempt * 500));
    }
  }
  throw lastError ?? new Error('Review Director analysis failed.');
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
  const taskIntent = resolveTaskIntent(repository, scope);
  const plan = createReviewDirectorPlan(diff.files, repository.listDiffHunkReviews(scope, diff.revision));
  // Automatic means approved, not merely hidden. Persist the same reviewed
  // verdict the UI buttons write so counts, navigation, reopen, and every
  // other surface agree that proof-settled work is finished.
  for (const entry of plan.entries) {
    if (!entry.routing.autoSettled || entry.decision.state !== null) continue;
    repository.upsertDiffHunkReviews(scope, {
      revision: diff.revision,
      hunks: entry.decision.hunks.map((hunk) => ({ filePath: hunk.filePath, hunkRange: hunk.hunkRange, contentHash: hunk.contentHash })),
      state: 'reviewed',
      note: AUTOMATIC_PROOF_REVIEW_NOTE,
    });
  }
  // T0 is already settled by proof. Spending model turns on it would add cost
  // without changing the queue or producing information Jeffrey needs.
  const reviewable = plan.orderedDecisions
    .map((decision) => plan.byDecisionId.get(decision.id)!)
    .filter((entry) => !entry.routing.autoSettled);
  const job: ScoreJob = {
    scope,
    revision: diff.revision,
    total: reviewable.length,
    skipped: 0,
    running: true,
    completed: 0,
    autoReviewed: 0,
    criticalCompleted: 0,
    criticalTotal: reviewable.filter((entry) => entry.critical).length,
    entries: new Map(),
  };
  jobs.set(key, job);
  try {
    let cursor = 0;
    const scoreNext = async (): Promise<void> => {
      const index = cursor;
      cursor += 1;
      if (index >= reviewable.length) return;
      const entry = reviewable[index];
      const { decision } = entry;
      let answer: string | null = null;
      let delegatedAnswer: string | null = null;
      let error: string | null = null;
      try {
        if (entry.critical) {
          let criticalFailure: Error | null = null;
          for (let attempt = 1; attempt <= AUTO_SCORE_ATTEMPTS; attempt += 1) {
            try {
              const answers = await requestCriticalReviewAssist(
                repository.database,
                reviewAssistDecisionPayload(entry.decision, plan.decisions),
                taskIntent,
              );
              answer = answers.score_risk;
              delegatedAnswer = answers.explain;
              criticalFailure = null;
              break;
            } catch (failure) {
              criticalFailure = failure instanceof Error ? failure : new Error('Review Director analysis failed.');
              if (attempt < AUTO_SCORE_ATTEMPTS) await new Promise((resolveRetry) => setTimeout(resolveRetry, attempt * 500));
            }
          }
          if (criticalFailure) throw criticalFailure;
          job.criticalCompleted += 1;
        } else {
          answer = await requestWithRetry(repository, 'score_risk', entry, plan.decisions, taskIntent);
        }

        const scored = parseAiRiskScore(answer);
        const effectiveRouting = routeWithAiRisk(entry.routing, scored?.score);
        const delegated = isDelegatedTier(effectiveRouting.tier);
        if (delegated && decision.state === null) {
          delegatedAnswer ??= await requestWithRetry(repository, 'explain', { ...entry, tier: effectiveRouting.tier, routing: effectiveRouting }, plan.decisions, taskIntent);
          if (delegationOutcome(effectiveRouting.tier, delegatedAnswer).autoReview) {
            try {
              repository.upsertDiffHunkReviews(scope, {
                revision: diff.revision,
                hunks: decision.hunks.map((hunk) => ({ filePath: hunk.filePath, hunkRange: hunk.hunkRange, contentHash: hunk.contentHash })),
                state: 'reviewed',
                note: DELEGATED_REVIEW_NOTE,
              });
              job.autoReviewed += 1;
              publishRealtimeEvent('workItemId' in scope ? 'work-items' : 'shared');
            } catch {
              // The owning task or conversation can be deleted while a model
              // turn is in flight. Keep the durable analysis; there is no
              // longer a queue row to attach the automatic verdict to.
            }
          }
        }

      } catch (failure) {
        error = failure instanceof Error ? failure.message : 'Review Director analysis failed.';
      }
      job.completed += 1;
      job.entries.set(decision.id, { decisionId: decision.id, ordinal: decision.ordinal, answer, error });
      publishRealtimeReviewScore({
        scope, revision: job.revision, decisionId: decision.id, answer, error, completed: job.completed, total: job.total,
      });
      await scoreNext();
    };
    await Promise.all(Array.from({ length: Math.min(AUTO_SCORE_CONCURRENCY, reviewable.length) }, () => scoreNext()));
  } finally {
    job.running = false;
  }
}

/**
 * Executes the Review Director plan for a scope's current diff in the
 * background and streams each result as it settles. Called when an agent run
 * comes to rest, so delegated verdicts and critical analysis are already
 * populating before the reviewer opens Changes.
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

/** A Changes pane is itself durable evidence that this revision should be
 * scored. This recovers work after restarts and covers manual conversations
 * that did not pass through the task-run completion hook. It never blocks the
 * request and never restarts a completed pass for the same revision. */
export function ensureReviewAutoScore(repository: WorkItemRepository, scope: ReviewScoreScope, revision: string): void {
  const current = jobs.get(scopeKey(scope));
  if (current?.revision === revision && (current.running || (current.completed === current.total && current.skipped === 0))) return;
  void scheduleReviewAutoScore(repository, scope, null);
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
    autoReviewed: job.autoReviewed,
    criticalCompleted: job.criticalCompleted,
    criticalTotal: job.criticalTotal,
    entries: [...job.entries.values()],
  };
}

/**
 * Everything already scored for a scope's current diff, read straight from the
 * durable assist cache without spawning a single model turn.
 *
 * The in-memory job above is process-local: a runtime promotion, a server
 * restart, or simply a pane opened long after a run came to rest leaves it
 * empty, and the panel then reads as "nothing has been scored" for a diff whose
 * every answer is already paid for and on disk. Rebuilding the decisions from
 * the same shared derivation the client uses gives back exactly the answers the
 * cache holds, so revisiting Changes shows existing data instead of buying it
 * again.
 */
async function cachedScoreEntries(repository: WorkItemRepository, scope: ReviewScoreScope, revision: string): Promise<ReviewScoreEntry[]> {
  const workspacePath = resolveScoreWorkspace(repository, scope, null);
  if (!workspacePath) return [];
  const diff = await getWorkspaceDiff(workspacePath);
  // A moved diff is not this pane's diff: replaying answers keyed to other
  // hunks would attach a score to a decision it was never about.
  if (diff.revision !== revision || diff.changedFiles === 0) return [];
  const plan = createReviewDirectorPlan(diff.files, repository.listDiffHunkReviews(scope, diff.revision));
  const entries: ReviewScoreEntry[] = [];
  for (const entry of plan.entries) {
    if (entry.routing.autoSettled) continue;
    const { decision } = entry;
    const answer = lookupReviewAssist(repository.database, 'score_risk', reviewAssistDecisionPayload(decision, plan.decisions), null, entry.tier);
    if (answer) entries.push({ decisionId: decision.id, ordinal: decision.ordinal, answer, error: null });
  }
  return entries;
}

async function cachedDirectorCounts(repository: WorkItemRepository, scope: ReviewScoreScope, revision: string): Promise<{
  autoReviewed: number;
  criticalCompleted: number;
  criticalTotal: number;
}> {
  const workspacePath = resolveScoreWorkspace(repository, scope, null);
  if (!workspacePath) return { autoReviewed: 0, criticalCompleted: 0, criticalTotal: 0 };
  const diff = await getWorkspaceDiff(workspacePath);
  if (diff.revision !== revision || diff.changedFiles === 0) return { autoReviewed: 0, criticalCompleted: 0, criticalTotal: 0 };
  const taskIntent = resolveTaskIntent(repository, scope);
  const plan = createReviewDirectorPlan(diff.files, repository.listDiffHunkReviews(scope, revision));
  const critical = plan.entries.filter((entry) => entry.critical);
  const criticalCompleted = critical.filter((entry) => entry.enrichmentActions
    .filter((action) => action !== 'compare_task_intent' || taskIntent)
    .every((action) => lookupReviewAssist(
      repository.database,
      action,
      reviewAssistDecisionPayload(entry.decision, plan.decisions),
      taskIntent,
      entry.tier,
    ))).length;
  return {
    autoReviewed: plan.decisions.filter((decision) => decision.note === DELEGATED_REVIEW_NOTE).length,
    criticalCompleted,
    criticalTotal: critical.length,
  };
}

/**
 * What a Changes pane should show for one revision: every persisted score, plus
 * the live job's progress and per-decision failures layered on top. Failures are
 * not cacheable state, so they can only come from the running job — and a live
 * result always wins over a cached one, being strictly newer.
 */
export async function reviewAutoScoreView(repository: WorkItemRepository, scope: ReviewScoreScope, revision: string): Promise<ReviewAutoScoreSnapshot | null> {
  const live = reviewAutoScoreSnapshot(scope, revision);
  let cached: ReviewScoreEntry[] = [];
  let counts = { autoReviewed: 0, criticalCompleted: 0, criticalTotal: 0 };
  try {
    cached = await cachedScoreEntries(repository, scope, revision);
    counts = await cachedDirectorCounts(repository, scope, revision);
  } catch {
    // No repository, or git unavailable. The live job, if any, still replays.
  }
  if (!live && cached.length === 0) return null;
  const entries = new Map(cached.map((entry) => [entry.decisionId, entry]));
  for (const entry of live?.entries ?? []) entries.set(entry.decisionId, entry);
  return {
    revision,
    running: live?.running ?? false,
    completed: live?.completed ?? entries.size,
    total: live?.total ?? entries.size,
    skipped: live?.skipped ?? 0,
    autoReviewed: Math.max(live?.autoReviewed ?? 0, counts.autoReviewed),
    criticalCompleted: Math.max(live?.criticalCompleted ?? 0, counts.criticalCompleted),
    criticalTotal: Math.max(live?.criticalTotal ?? 0, counts.criticalTotal),
    entries: [...entries.values()],
  };
}

/** Test seam: job state is process-local, so suites that assert on progress
 * must not inherit a previous test's job. */
export function resetReviewAutoScore(): void {
  jobs.clear();
  inFlight.clear();
  rerunRequested.clear();
}
