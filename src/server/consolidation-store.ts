import { consolidationApplyResultSchema, consolidationProposalItemSchema, type ConsolidationProposal } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';

/**
 * Read-only lookups over stored consolidation proposals. Kept free of the
 * model and agent-runner imports so the repository can use it for the inbox.
 */

interface ProposalRow { id: string; status: ConsolidationProposal['status']; items_json: string; apply_results_json: string | null; created_at: string; resolved_at: string | null }

function toProposal(row: ProposalRow): ConsolidationProposal {
  return {
    id: row.id,
    status: row.status,
    items: consolidationProposalItemSchema.array().parse(JSON.parse(row.items_json)),
    applyResults: row.apply_results_json === null ? null : consolidationApplyResultSchema.array().parse(JSON.parse(row.apply_results_json)),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

const PROPOSAL_COLUMNS = 'id, status, items_json, apply_results_json, created_at, resolved_at';

export function getConsolidationProposal(database: WorkbenchDatabase, id: string): ConsolidationProposal | null {
  const row = database.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM consolidation_proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
  return row ? toProposal(row) : null;
}

export function getPendingConsolidationProposal(database: WorkbenchDatabase): ConsolidationProposal | null {
  const row = database.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM consolidation_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`).get() as ProposalRow | undefined;
  return row ? toProposal(row) : null;
}

/** Newest proposal of any status; the weekly cadence counts from its created_at. */
export function getLatestConsolidationProposal(database: WorkbenchDatabase): ConsolidationProposal | null {
  const row = database.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM consolidation_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as ProposalRow | undefined;
  return row ? toProposal(row) : null;
}

/** What the card shows: a pending proposal, or the newest one if it stopped partway through applying. */
export function getVisibleConsolidationProposal(database: WorkbenchDatabase): ConsolidationProposal | null {
  const pending = getPendingConsolidationProposal(database);
  if (pending) return pending;
  const latest = getLatestConsolidationProposal(database);
  return latest?.status === 'partially_applied' ? latest : null;
}
