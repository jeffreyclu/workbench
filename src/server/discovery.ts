import { createHash } from 'node:crypto';
import { WorkItemRepository } from './repository.js';
import { scanConnectedSources, type SourceSignal } from './source-scanner.js';
import { LinearProvider } from './providers/linear.js';
import { createAgentDailyProposal } from './daily-planner.js';
import { publishRealtimeEvent, publishRealtimeNotification } from './realtime.js';
import { AUTONOMOUS_MODEL_ALLOWLIST } from './autonomy-governor.js';
import { currentUsageCalibration } from './usage-meter.js';
import { resolveProviderBudgetWindow } from './autonomy-governor.js';

function fingerprint(signal: SourceSignal): string {
  const identity = signal.url?.trim().toLowerCase() || `${signal.provider}:${signal.title.trim().toLowerCase()}`;
  return createHash('sha256').update(identity).digest('hex');
}

const connectorPattern = /\bconnectors?\b|connector[-_ ]gateway|manage connectors|agent studio/i;
const reviewPattern = /\b(code|pr|pull request|implementation)\s+review\b|\breview(?:ed|ing)?\s+(?:this|my|the)?\s*(?:pr|pull request|code|change)|review-requested|github\.com\/.+\/pull\//i;
const actionablePattern = /\b(?:please|can you|could you|would you|need you to|assigned|action item|follow[- ]?up|todo|to do|blocker|blocked|investigate|fix|implement|prepare|decide|respond|reply|review)\b/i;

export function discoveryPriority(signal: SourceSignal): number {
  const text = `${signal.title}\n${signal.summary}\n${signal.url ?? ''}`;
  if (connectorPattern.test(text) || reviewPattern.test(text)) return 2;
  if (signal.provider === 'linear' || actionablePattern.test(text)) return 1;
  return 0;
}

/**
 * Discovery fills the review queue, not the backlog: every candidate stays a
 * `pending` discovery_candidates row until someone (or an agent acting on
 * explicit instruction) converts it, so a run can never execute what it just
 * proposed. This cap bounds how many *new* proposals one run cycle can add —
 * refreshing an already-pending candidate's relevance doesn't count against it,
 * since that candidate was already surfaced for review in an earlier cycle.
 */
export const NEW_CANDIDATES_PER_RUN = 3;

export interface DiscoveryRunOptions {
  /** The scheduled autonomous path supplies its model so this module fails
   * closed before it can produce proposals from a disallowed tier. */
  autonomousModel?: string;
}

function proposalDescription(signal: SourceSignal): string {
  const source = signal.summary.trim();
  return `${source || `Discovery found a ${signal.provider} item that needs attention.`}\n\nOutcome:\nReview the source context, decide the smallest useful next action, and leave the work item ready for Jeffrey's approval.`;
}

function proposalRationale(signal: SourceSignal, priority: number, position: number): string {
  const reason = priority === 2 ? 'direct request, code-review, or connector signal' : 'actionable source signal';
  return `Suggested priority ${priority} and queue position ${position} because discovery found a ${reason} in ${signal.provider}.`;
}

export async function runDiscovery(repository: WorkItemRepository, options: DiscoveryRunOptions = {}): Promise<void> {
  let autonomousWindowStart: string | null = null;
  if (options.autonomousModel && !AUTONOMOUS_MODEL_ALLOWLIST.includes(options.autonomousModel as typeof AUTONOMOUS_MODEL_ALLOWLIST[number])) {
    throw new Error(`Discovery model '${options.autonomousModel}' is not on the autonomous allowlist (haiku, sonnet only).`);
  }
  if (options.autonomousModel) {
    const policy = repository.getAutonomyPolicy();
    if (!policy.globalEnabled || !policy.providers.claude?.enabled) {
      throw new Error('Autonomous discovery requires runtime approval: enable the global and Claude autonomy policies first.');
    }
    const calibration = currentUsageCalibration(repository, 'claude', new Date());
    const window = calibration ? resolveProviderBudgetWindow(calibration, new Date()) : null;
    if (!window) throw new Error('Autonomous discovery requires a current Claude calibration with a valid weekly reset window.');
    autonomousWindowStart = window.start.toISOString();
  }
  const current = repository.getDiscoveryInbox();
  if (current.running) return;
  // A discovery pass may create its first queue items. Do not immediately run
  // the separate queue-planning agent over those unreviewed proposals.
  const hadQueuedWorkAtStart = repository.list().length > 0;
  const since = current.lastRun?.completedAt
    ? new Date(current.lastRun.completedAt)
    : new Date(Date.now() - 36 * 60 * 60 * 1000);
  const run = repository.startDiscoveryRun();
  try {
    const scanned = await scanConnectedSources(repository);
    const signals = [...scanned.signals]; const errors = [...scanned.errors];
    if (process.env.LINEAR_API_KEY) {
      try {
        const config = repository.getLinearConfig();
        const issues = await new LinearProvider(process.env.LINEAR_API_KEY, config.teamIds, config.projectIds).fetchOpenIssues();
        signals.push(...issues.map((issue) => ({ provider: 'linear', title: issue.title, summary: `${issue.projectName ?? ''}\n${issue.labels.join(', ')}\n${issue.description}`, url: issue.sourceUrl, occurredAt: issue.providerUpdatedAt })));
      } catch (error) { errors.push(`linear: ${error instanceof Error ? error.message : 'Scan failed.'}`); }
    }
    let added = 0;
    let newCandidates = 0;
    let proposals = 0;
    const proposalTitles: string[] = [];
    const rankedSignals = signals.map((signal) => ({ signal, priority: discoveryPriority(signal) }))
      .filter(({ priority }) => priority > 0)
      .sort((left, right) => right.priority - left.priority || String(right.signal.occurredAt ?? '').localeCompare(String(left.signal.occurredAt ?? '')));
    for (const { signal, priority } of rankedSignals) {
      if (!signal.title.trim()) continue;
      if (signal.occurredAt && new Date(signal.occurredAt) < since) continue;
      const candidateFingerprint = fingerprint(signal);
      // Highest-priority signals are ranked first, so the cap keeps the top-scored proposals.
      if (proposals >= NEW_CANDIDATES_PER_RUN && !repository.discoveryCandidateExists(candidateFingerprint)) continue;
      const inserted = repository.upsertDiscoveryCandidate({ fingerprint: candidateFingerprint, provider: signal.provider, title: signal.title.trim(), description: signal.summary.trim(), sourceUrl: signal.url, occurredAt: signal.occurredAt, runId: run.id, relevance: priority });
      if (inserted) {
        newCandidates += 1;
        const duplicate = repository.findOpenWorkItemNearTitle(signal.title);
        if (!duplicate && proposals < NEW_CANDIDATES_PER_RUN) {
          const position = proposals + 1;
          repository.createMachineProposal({
            title: signal.title.trim(), description: proposalDescription(signal), suggestedPriority: priority === 2 ? 1 : 2,
            suggestedQueuePosition: position, rationale: proposalRationale(signal, priority === 2 ? 1 : 2, position),
            runId: run.id, windowStart: autonomousWindowStart ?? run.startedAt, sourceUrl: signal.url,
          });
          proposals += 1;
          proposalTitles.push(signal.title.trim());
        }
      }
      added += Number(inserted);
    }
    if (hadQueuedWorkAtStart && proposals === 0) {
      try { await createAgentDailyProposal(repository, rankedSignals.map(({ signal }) => signal), errors); }
      catch (error) { errors.push(`reorder: ${error instanceof Error ? error.message : 'Could not prepare the morning stack proposal.'}`); }
    }
    repository.finishDiscoveryRun(run.id, added, errors);
    publishRealtimeEvent('discovery', 'work-items');
    if (proposals > 0) {
      const remainder = proposals - Math.min(2, proposalTitles.length);
      publishRealtimeNotification({
        tone: 'info',
        message: `${proposals} machine proposal${proposals === 1 ? '' : 's'} ready for review.`,
        description: `${proposalTitles.slice(0, 2).join(' · ')}${remainder > 0 ? ` · +${remainder} more` : ''}` || undefined,
        action: { label: 'Review queue', route: '/' },
      });
    }
  } catch (error) {
    repository.finishDiscoveryRun(run.id, 0, [error instanceof Error ? error.message : 'Discovery failed.'], true);
    throw error;
  }
}

export function shouldRunDiscoveryCatchUp(lastRun: string | null, now = new Date()): boolean {
  const localCutoff = new Date(now); localCutoff.setHours(5, 0, 0, 0);
  if (now < localCutoff) localCutoff.setDate(localCutoff.getDate() - 1);
  return !lastRun || new Date(lastRun) < localCutoff;
}
