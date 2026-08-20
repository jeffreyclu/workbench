import { createHash } from 'node:crypto';
import { WorkItemRepository } from './repository.js';
import { scanConnectedSources, type SourceSignal } from './source-scanner.js';
import { LinearProvider } from './providers/linear.js';

function fingerprint(signal: SourceSignal): string {
  const identity = signal.url?.trim().toLowerCase() || `${signal.provider}:${signal.title.trim().toLowerCase()}`;
  return createHash('sha256').update(identity).digest('hex');
}

export async function runDiscovery(repository: WorkItemRepository): Promise<void> {
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
        signals.push(...issues.map((issue) => ({ provider: 'linear', title: issue.title, summary: issue.description, url: issue.sourceUrl, occurredAt: issue.providerUpdatedAt })));
      } catch (error) { errors.push(`linear: ${error instanceof Error ? error.message : 'Scan failed.'}`); }
    }
    let added = 0;
    for (const signal of signals) {
      if (!signal.title.trim()) continue;
      if (signal.occurredAt && new Date(signal.occurredAt) < since) continue;
      added += Number(repository.upsertDiscoveryCandidate({ fingerprint: fingerprint(signal), provider: signal.provider, title: signal.title.trim(), description: signal.summary.trim(), sourceUrl: signal.url, occurredAt: signal.occurredAt, runId: run.id }));
    }
    repository.finishDiscoveryRun(run.id, added, errors);
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
