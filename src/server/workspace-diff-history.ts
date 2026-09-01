import type { WorkItemRepository } from './repository.js';
import { getWorkspaceCommitDiff, snapshotsForRepository } from './workspace-diff.js';

type WorkspaceDiffScope = { workItemId: string } | { conversationId: string };

const COMMIT_REFERENCE = /\b[0-9a-f]{7,40}\b/gi;
const MAX_REFERENCED_COMMITS = 30;

/**
 * Backfill a timeline only from commit IDs already written into the owning
 * conversation. We never infer ownership from commit time or branch order.
 */
export async function captureRecordedWorkspaceDiffSnapshots(
  repository: WorkItemRepository,
  scope: WorkspaceDiffScope,
  workspacePath: string,
  conversationIds: string[],
) {
  // Scoped to this checkout's repository: a record captured in a different
  // repository must not suppress backfilling this one's timeline.
  const recorded = await snapshotsForRepository(repository.listWorkspaceDiffSnapshots(scope), workspacePath);
  if (recorded.some((snapshot) => snapshot.diff.changedFiles > 0)) return;

  const references = new Set<string>();
  for (const conversationId of conversationIds) {
    for (const message of repository.listAllSharedMessages(conversationId)) {
      for (const match of message.body.matchAll(COMMIT_REFERENCE)) {
        references.add(match[0]);
        if (references.size >= MAX_REFERENCED_COMMITS) break;
      }
      if (references.size >= MAX_REFERENCED_COMMITS) break;
    }
    if (references.size >= MAX_REFERENCED_COMMITS) break;
  }

  for (const reference of references) {
    try {
      const diff = await getWorkspaceCommitDiff(workspacePath, reference);
      if (diff.changedFiles > 0) repository.captureWorkspaceDiffSnapshot(scope, diff, { commitHash: diff.revision.slice('commit:'.length) });
    } catch {
      // Message bodies contain many hex-looking IDs. Only Git-resolvable commit
      // IDs become records; invalid or unrelated values are ignored.
    }
  }
}
