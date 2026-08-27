import { createHash } from 'node:crypto';
import { WorkItemRepository } from './repository.js';
import { scanConnectedSources, type SourceSignal } from './source-scanner.js';
import { LinearProvider } from './providers/linear.js';
import { publishRealtimeEvent, publishRealtimeNotification } from './realtime.js';

function fingerprint(signal: SourceSignal): string {
  const identity = signal.url?.trim().toLowerCase() || `${signal.provider}:${signal.title.trim().toLowerCase()}`;
  return createHash('sha256').update(identity).digest('hex');
}

const connectorPattern = /\bconnectors?\b|connector[-_ ]gateway|manage connectors|agent studio/i;
const reviewPattern = /\b(code|pr|pull request|implementation)\s+review\b|\breview(?:ed|ing)?\s+(?:this|my|the)?\s*(?:pr|pull request|code|change)|review-requested|github\.com\/.+\/pull\//i;
const actionablePattern = /\b(?:please|can you|could you|would you|need you to|assigned|action item|follow[- ]?up|todo|to do|blocker|blocked|investigate|fix|implement|prepare|decide|respond|reply|review)\b/i;
export const DISCOVERY_RUN_MAX_AGE_MS = 15 * 60_000;

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
export async function runDiscovery(repository: WorkItemRepository): Promise<void> {
  const recovered = repository.recoverStaleDiscoveryRuns(DISCOVERY_RUN_MAX_AGE_MS);
  for (const staleRun of recovered) {
    repository.logDiagnostic('run_recovery', 'recovery', 'failure', `Recovered stale discovery run ${staleRun.id} started at ${staleRun.startedAt}.`, undefined, 'discovery_stale_run');
  }
  const current = repository.getDiscoveryInbox();
  if (current.running) return;
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
    const rankedSignals = signals.map((signal) => ({ signal, priority: discoveryPriority(signal) }))
      .filter(({ priority }) => priority > 0)
      .sort((left, right) => right.priority - left.priority || String(right.signal.occurredAt ?? '').localeCompare(String(left.signal.occurredAt ?? '')));
    for (const { signal, priority } of rankedSignals) {
      if (!signal.title.trim()) continue;
      if (signal.occurredAt && new Date(signal.occurredAt) < since) continue;
      const candidateFingerprint = fingerprint(signal);
      const inserted = repository.upsertDiscoveryCandidate({ fingerprint: candidateFingerprint, provider: signal.provider, title: signal.title.trim(), description: signal.summary.trim(), sourceUrl: signal.url, occurredAt: signal.occurredAt, runId: run.id, relevance: priority });
      added += Number(inserted);
    }
    repository.finishDiscoveryRun(run.id, added, errors);
    publishRealtimeEvent('discovery', 'work-items');
    if (added > 0) {
      publishRealtimeNotification({
        tone: 'info',
        message: `${added} discovery candidate${added === 1 ? '' : 's'} ready for review.`,
        action: { label: 'Review', route: '/discovery' },
      });
    }
  } catch (error) {
    repository.finishDiscoveryRun(run.id, 0, [error instanceof Error ? error.message : 'Discovery failed.'], true);
    throw error;
  }
}
