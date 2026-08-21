import type { AuditLogEntry } from '../shared/contracts.js';

/**
 * Outbound-call sites (providers/linear.ts, slack-mcp.ts, source-scanner.ts,
 * artifact-publisher.ts) have no repository/database reference of their own —
 * threading one through every provider constructor and helper would spread
 * persistence concerns across modules that should stay call-site-focused.
 * createApp wires the one real sink (repository.addAuditEntry) at startup;
 * tests can install their own sink or leave calls as safe no-ops.
 */
type AuditSink = (category: AuditLogEntry['category'], source: string, detail: string, workItemId?: string | null) => void;

let sink: AuditSink | null = null;

export function setAuditSink(next: AuditSink | null): void {
  sink = next;
}

export function recordAudit(category: AuditLogEntry['category'], source: string, detail: string, workItemId: string | null = null): void {
  sink?.(category, source, detail, workItemId);
}
