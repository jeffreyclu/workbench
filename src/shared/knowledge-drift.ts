export type KnowledgeDriftStatus = 'healthy' | 'degraded' | 'failed';

/** What the client and the morning proposal read from a stored drift report. */
export interface KnowledgeDriftSummary {
  checkedAt: string;
  status: KnowledgeDriftStatus;
  checks: Record<string, { status: KnowledgeDriftStatus; reason: string }>;
}

export const KNOWLEDGE_DRIFT_CHECK_LABELS: Record<string, string> = {
  indexRows: 'Index rows',
  entryCounts: 'Entry counts',
  duplicateEntryNumbers: 'Duplicate entry numbers',
  danglingCitations: 'Dangling citations',
  asymmetricCrossRefs: 'Cross-references',
  tierHeaders: 'Tier headers',
  consolidation: 'Consolidation',
  oversizedFiles: 'File size',
  tierWrites: 'Tier writes',
};

const severity: Record<KnowledgeDriftStatus, number> = { healthy: 0, degraded: 1, failed: 2 };

export function knowledgeDriftCheckLabel(key: string): string {
  return KNOWLEDGE_DRIFT_CHECK_LABELS[key] ?? key;
}

/** The most severe non-healthy check; the first one wins a tie. */
export function worstKnowledgeDriftCheck(report: KnowledgeDriftSummary): { key: string; status: KnowledgeDriftStatus; reason: string } | null {
  let worst: { key: string; status: KnowledgeDriftStatus; reason: string } | null = null;
  for (const [key, entry] of Object.entries(report.checks)) {
    if (severity[entry.status] > (worst ? severity[worst.status] : 0)) worst = { key, ...entry };
  }
  return worst;
}

/** One sentence for the morning proposal, or null when knowledge is healthy. */
export function knowledgeDriftProposalSentence(report: KnowledgeDriftSummary | null | undefined): string | null {
  if (!report || report.status === 'healthy') return null;
  const worst = worstKnowledgeDriftCheck(report);
  if (!worst) return null;
  return `Knowledge drift is ${report.status}; the worst check is ${knowledgeDriftCheckLabel(worst.key)}: ${worst.reason.replace(/\.+$/, '')}.`;
}
