import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConsolidationApplyResult, ConsolidationProposal, ConsolidationProposalItem } from '../shared/contracts.js';
import { analyzeMemoryFile } from '../shared/memory-catalogue.js';
import { buildConsolidationProposal, saveConsolidationProposal, type ConsolidationResult } from './consolidation-proposal.js';
import { getConsolidationProposal, getPendingConsolidationProposal } from './consolidation-store.js';
import { DISCARD_LOG_FILE, removeKnowledgeEntries } from './discard-log.js';
import { defaultRecordLearningDirectories, indexedFiles, recordLearning, type RecordLearningDirectories } from './record-learning.js';
import type { WorkItemRepository } from './repository.js';

/**
 * Turns a consolidation proposal into durable state, and only after Jeffrey
 * accepts it. Every write is re-read to confirm it landed before anything that
 * depends on it runs; nothing is removed on intent alone. Rejecting changes
 * only the proposal's status. All of it is recorded on one standing
 * "Knowledge consolidation" task and announced in the shared room.
 */

export const CONSOLIDATION_WORK_ITEM_TITLE = 'Knowledge consolidation';
const CONSOLIDATION_PROJECT = 'Workbench';
const APPLY_ORDER: Record<ConsolidationProposalItem['verdict'], number> = { promote: 0, keep: 1, archive_then_remove: 2 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finds the standing task, creating it pinned on first use. It is never archived. */
export function ensureConsolidationWorkItem(repository: WorkItemRepository): string {
  const existing = repository.database.prepare(`SELECT id FROM work_items
    WHERE title = ? AND project_name = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`)
    .get(CONSOLIDATION_WORK_ITEM_TITLE, CONSOLIDATION_PROJECT) as { id: string } | undefined;
  if (existing) return existing.id;
  return repository.create({
    title: CONSOLIDATION_WORK_ITEM_TITLE,
    description: 'Standing system task. Weekly memory consolidation proposals, their resolutions, and every write applied on accept are recorded in this activity log.',
    priority: 3,
    status: 'pinned',
    projectName: CONSOLIDATION_PROJECT,
    workspacePath: null,
    dueDate: null,
  }).id;
}

function counts(items: ConsolidationProposalItem[]): string {
  const of = (verdict: ConsolidationProposalItem['verdict']) => items.filter((item) => item.verdict === verdict).length;
  return `${of('promote')} promote, ${of('keep')} keep, ${of('archive_then_remove')} archive-then-remove`;
}

export function describeConsolidationItem(item: ConsolidationProposalItem): string {
  if (item.verdict === 'promote') return `promote ${item.provenanceId} -> ${item.targetFile}: ${item.title}`;
  if (item.verdict === 'keep') return `keep ${item.provenanceId}${item.coveredBy ? ` (already covered by ${item.coveredBy})` : ''}`;
  return `archive-then-remove ${item.provenanceId}: ${item.reason}`;
}

export type CreateConsolidationOutcome =
  | { outcome: 'created'; proposal: ConsolidationProposal }
  | { outcome: 'pending'; proposal: ConsolidationProposal }
  | { outcome: 'building'; proposal: null }
  | { outcome: 'empty'; proposal: null };

const building = new WeakSet<object>();

/**
 * Builds and stores a proposal unless one is already pending or being built.
 * The pending check runs again after the model returns, so a proposal created
 * meanwhile is never superseded.
 */
export async function createConsolidationProposal(repository: WorkItemRepository, options: {
  build?: () => Promise<ConsolidationResult>;
  directories?: RecordLearningDirectories;
} = {}): Promise<CreateConsolidationOutcome> {
  const { database } = repository;
  const pending = getPendingConsolidationProposal(database);
  if (pending) return { outcome: 'pending', proposal: pending };
  if (building.has(database)) return { outcome: 'building', proposal: null };
  building.add(database);
  try {
    const result = await (options.build ?? (() => buildConsolidationProposal({
      database,
      shortTermMemory: { conversations: () => repository.listShortTermMemoryConversations() },
      directories: options.directories,
    })))();
    const raced = getPendingConsolidationProposal(database);
    if (raced) return { outcome: 'pending', proposal: raced };
    const workItemId = ensureConsolidationWorkItem(repository);
    if (!result.items.length) {
      repository.addActivity(workItemId, 'system', 'consolidation_empty', `Weekly consolidation pass found nothing to propose${result.dropped.length ? ` (${result.dropped.length} unvalidated verdicts dropped)` : ''}.`);
      return { outcome: 'empty', proposal: null };
    }
    const proposal = saveConsolidationProposal(database, result.items);
    repository.addActivity(workItemId, 'system', 'consolidation_proposed',
      `Proposal ${proposal.id}: ${counts(proposal.items)}.\n${proposal.items.map((item) => `- ${describeConsolidationItem(item)}`).join('\n')}`);
    repository.createSharedMessage('system', `Consolidation proposal ready: ${counts(proposal.items)}. Accept or reject it on the Discoveries page.`);
    return { outcome: 'created', proposal };
  } finally {
    building.delete(database);
  }
}

/** Accepts (applying every item) or rejects a pending proposal. Returns null when it is not pending. */
export function resolveConsolidationProposal(
  repository: WorkItemRepository,
  id: string,
  resolution: 'accepted' | 'rejected',
  directories: RecordLearningDirectories = defaultRecordLearningDirectories(),
): ConsolidationProposal | null {
  const { database } = repository;
  const proposal = getConsolidationProposal(database, id);
  if (!proposal || proposal.status !== 'pending') return null;
  const workItemId = ensureConsolidationWorkItem(repository);
  const resolvedAt = new Date().toISOString();

  if (resolution === 'rejected') {
    database.prepare("UPDATE consolidation_proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'").run(resolvedAt, id);
    repository.addActivity(workItemId, 'jeffrey', 'consolidation_resolved', `Rejected proposal ${id}. Nothing was written or removed.`);
    repository.createSharedMessage('system', 'Consolidation proposal rejected. Nothing was written or removed.');
    return getConsolidationProposal(database, id);
  }

  const results = applyConsolidationItems(repository, proposal, workItemId, directories);
  const failed = results.find((result) => result.status === 'failed');
  const status = failed ? 'partially_applied' : 'accepted';
  database.prepare('UPDATE consolidation_proposals SET status = ?, apply_results_json = ?, resolved_at = ? WHERE id = ?')
    .run(status, JSON.stringify(results), resolvedAt, id);
  const applied = results.filter((result) => result.status === 'applied').length;
  const summary = failed
    ? `Accepted proposal ${id}; partially applied: ${applied} of ${results.length} items applied, stopped at ${failed.provenanceId} (${failed.detail}).`
    : `Accepted proposal ${id}; all ${results.length} items applied.`;
  repository.addActivity(workItemId, 'jeffrey', 'consolidation_resolved', summary);
  repository.createSharedMessage('system', failed
    ? `Consolidation proposal partially applied: ${applied} of ${results.length} items landed. Stopped at ${failed.provenanceId}: ${failed.detail}`
    : `Consolidation proposal accepted: all ${results.length} items applied.`);
  return getConsolidationProposal(database, id);
}

/** Applies promote, then keep, then archive-then-remove, one item at a time, stopping at the first failure. */
function applyConsolidationItems(repository: WorkItemRepository, proposal: ConsolidationProposal, workItemId: string, directories: RecordLearningDirectories): ConsolidationApplyResult[] {
  const ordered = [...proposal.items].sort((a, b) => APPLY_ORDER[a.verdict] - APPLY_ORDER[b.verdict]);
  const results: ConsolidationApplyResult[] = [];
  let stopped = false;
  for (const item of ordered) {
    const base = { provenanceId: item.provenanceId, verdict: item.verdict };
    if (stopped) { results.push({ ...base, status: 'not_attempted', detail: 'Not attempted after an earlier item failed.' }); continue; }
    try {
      const detail = applyItem(repository, proposal, item, directories);
      results.push({ ...base, status: 'applied', detail });
      if (item.verdict !== 'keep') repository.addActivity(workItemId, 'system', 'consolidation_applied', `${item.provenanceId}: ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ ...base, status: 'failed', detail });
      repository.addActivity(workItemId, 'system', 'consolidation_apply_failed', `${item.provenanceId}: ${detail} Remaining items were not attempted.`);
      stopped = true;
    }
  }
  return results;
}

function applyItem(repository: WorkItemRepository, proposal: ConsolidationProposal, item: ConsolidationProposalItem, directories: RecordLearningDirectories): string {
  if (item.verdict === 'keep') return item.coveredBy ? `Kept; already covered by ${item.coveredBy}.` : 'Kept unchanged.';
  if (item.verdict === 'promote') {
    const provenance = UUID.test(item.provenance.id) ? item.provenance.id : proposal.id;
    const recorded = recordLearning({ file: item.targetFile, title: item.title, body: item.text, provenance }, directories);
    const entry = analyzeMemoryFile(readFileSync(recorded.path, 'utf8')).entries.find((candidate) => candidate.id === recorded.id);
    if (!entry || !entry.body.includes(item.text.trim())) throw new Error(`Promoted entry ${recorded.citation} was not found on re-read.`);
    return `Promoted to ${recorded.citation}.`;
  }
  return archiveThenRemove(repository, proposal, item, directories);
}

function archiveThenRemove(repository: WorkItemRepository, proposal: ConsolidationProposal, item: Extract<ConsolidationProposalItem, { verdict: 'archive_then_remove' }>, directories: RecordLearningDirectories): string {
  const { provenance } = item;
  // A numbered entry goes through the discard log's single removal function,
  // which logs, re-reads the log, and only then tombstones the number.
  if (provenance.source === 'memory_entry') {
    const hash = provenance.id.lastIndexOf('#');
    const file = provenance.id.slice(0, hash);
    const number = Number(provenance.id.slice(hash + 1));
    const removed = removeKnowledgeEntries({ file, numbers: [number], reason: item.reason }, directories);
    return `Archived to ${removed.logCitations[0]}; ${file}#${number} tombstoned.`;
  }

  const source = readSource(repository, provenance);
  if (source === null) return 'Source no longer exists; nothing to archive or remove.';
  const removal = provenance.source === 'pinned_message' ? 'unpin (message kept)'
    : provenance.source === 'short_term_memory' ? 'none (rebuildable projection)' : 'none (already in files)';
  const date = new Date().toISOString().slice(0, 10);
  const quoted = source.split('\n').map((line) => `> ${line}`).join('\n');
  const recorded = recordLearning({
    file: DISCARD_LOG_FILE,
    title: `${item.provenanceId} archived ${date}`,
    body: [
      `- Date: ${date}`,
      `- Source: ${item.provenanceId}`,
      `- Reason: ${item.reason.replace(/\s+/g, ' ').trim()}`,
      `- Proposal: ${proposal.id}`,
      `- Removal: ${removal}`,
      '',
      quoted,
    ].join('\n'),
  }, directories);

  // Confirm the log entry landed with the full text before touching the source.
  const catalogue = indexedFiles(directories).get(DISCARD_LOG_FILE);
  const logged = catalogue && analyzeMemoryFile(readFileSync(join(catalogue.directory, DISCARD_LOG_FILE), 'utf8')).entries.find((entry) => entry.id === recorded.id);
  if (!logged || !logged.body.includes(`- Proposal: ${proposal.id}`) || !logged.body.includes(quoted)) {
    throw new Error(`Discard-log entry ${recorded.citation} did not confirm on re-read; ${item.provenanceId} left in place.`);
  }

  if (provenance.source === 'pinned_message') {
    repository.updateSharedMessage(provenance.id, { pinned: false });
    return `Archived to ${recorded.citation}; message unpinned.`;
  }
  return `Archived to ${recorded.citation}; ${provenance.source === 'short_term_memory' ? 'short-term memory rebuilds itself, nothing to remove' : 'run learnings already live in files, nothing to remove'}.`;
}

function readSource(repository: WorkItemRepository, provenance: ConsolidationProposalItem['provenance']): string | null {
  if (provenance.source === 'pinned_message') {
    const row = repository.database.prepare('SELECT body FROM shared_messages WHERE id = ?').get(provenance.id) as { body: string } | undefined;
    return row?.body ?? null;
  }
  if (provenance.source === 'short_term_memory') {
    return repository.listShortTermMemoryConversations().find((conversation) => conversation.id === provenance.id)?.body ?? null;
  }
  const row = repository.database.prepare('SELECT learnings_json FROM agent_run_review_handoffs WHERE agent_run_id = ?').get(provenance.id) as { learnings_json: string } | undefined;
  const learning = row ? (JSON.parse(row.learnings_json) as unknown[])[provenance.learningIndex ?? 0] : undefined;
  return typeof learning === 'string' && learning.trim() ? learning.trim() : null;
}
