import { randomUUID } from 'node:crypto';

import type { SharedConversation } from '../../shared/contracts.js';
import type { UnitOfWork } from '../unit-of-work.js';

function mapConversationRow(row: Record<string, string | number | null>): SharedConversation {
  return {
    id: String(row.id), title: String(row.title), workItemId: row.work_item_id ? String(row.work_item_id) : null,
    linkedProjectName: row.linked_project_name ? String(row.linked_project_name) : null, forkedFromConversationId: row.forked_from_conversation_id ? String(row.forked_from_conversation_id) : null, archivedAt: row.archived_at ? String(row.archived_at) : null, sharedBrief: String(row.shared_brief ?? ''), preferredExecutionProfile: row.preferred_execution_profile as SharedConversation['preferredExecutionProfile'] ?? null, preferredAccountProfile: row.preferred_account_profile ? String(row.preferred_account_profile) : null, preferredDispatchTarget: row.preferred_dispatch_target as SharedConversation['preferredDispatchTarget'] ?? null, isUnread: Boolean(row.is_unread), linkedWorkItemPinned: Boolean(row.linked_work_item_pinned), createdAt: String(row.created_at), updatedAt: String(row.updated_at), isActive: Boolean(row.is_active),
  };
}

/**
 * Owns the `shared_conversations` table's row-level CRUD and query
 * primitives. Deriving a conversation's live `state` (working /
 * needs_attention / waiting_approval / ...) reaches into execution plans,
 * which are a work-item concern, so every method here returns the base
 * conversation shape *without* `state` populated — `WorkItemRepository`
 * decorates it after the fact. Likewise, linking/unlinking a work item,
 * forking (which copies shared messages), and archive cascades reach into
 * other tables and activity logging, so that composition stays in
 * `WorkItemRepository`, calling back into the primitives here inside its own
 * `UnitOfWork` transaction.
 */
export class ConversationRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  private get database() { return this.unitOfWork; }

  list(view: 'active' | 'archive' | 'all' = 'active'): SharedConversation[] {
    return (this.database.prepare(`
      SELECT shared_conversations.*,
        EXISTS (
          SELECT 1 FROM shared_messages
          WHERE shared_messages.conversation_id = shared_conversations.id
            AND shared_messages.status = 'running'
        ) AS is_active,
        EXISTS (
          SELECT 1 FROM shared_messages
          WHERE shared_messages.conversation_id = shared_conversations.id
            AND shared_messages.status IN ('queued', 'running')
        ) AS is_working,
        EXISTS (
          SELECT 1 FROM shared_messages
          WHERE shared_messages.conversation_id = shared_conversations.id
            AND shared_messages.author IN ('codex', 'claude')
            AND shared_messages.created_at > COALESCE(shared_conversations.last_read_at, '')
        ) AS is_unread,
        CASE WHEN (
          SELECT status FROM work_items WHERE work_items.id = shared_conversations.work_item_id
        ) = 'pinned' THEN 1 ELSE 0 END AS linked_work_item_pinned,
        (SELECT project_name FROM work_items WHERE work_items.id = shared_conversations.work_item_id) AS linked_project_name
      FROM shared_conversations
      WHERE deleted_at IS NULL AND (? = 'all' OR (? = 'active' AND archived_at IS NULL) OR (? = 'archive' AND archived_at IS NOT NULL))
      ORDER BY linked_work_item_pinned DESC, is_working DESC, updated_at DESC
    `).all(view, view, view) as Array<Record<string, string | number | null>>).map(mapConversationRow);
  }

  /**
   * Cursor-paginated version of `list`, restricted to the active/archive
   * split. Returns the base (un-decorated) conversations plus `hasMore` and
   * `totalCount`; the caller builds the opaque `nextCursor` because it needs
   * each conversation's decorated `state` to do so.
   */
  listPage(limit: number, cursor: string | null, view: 'active' | 'archive' = 'active'): { conversations: SharedConversation[]; hasMore: boolean; totalCount: number } {
    const safeLimit = Math.max(1, Math.min(100, limit));
    let cursorValues: { isPinned: boolean; isWorking: boolean; updatedAt: string; id: string } | null = null;
    if (cursor) {
      try { cursorValues = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { isPinned: boolean; isWorking: boolean; updatedAt: string; id: string }; }
      catch { throw new Error('Invalid conversation cursor.'); }
      if (!cursorValues?.updatedAt || !cursorValues.id || typeof cursorValues.isPinned !== 'boolean' || typeof cursorValues.isWorking !== 'boolean') throw new Error('Invalid conversation cursor.');
    }
    const rows = this.database.prepare(`
      WITH conversations AS (
        SELECT shared_conversations.*,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.status = 'running') AS is_active,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.status IN ('queued', 'running')) AS is_working,
        EXISTS (SELECT 1 FROM shared_messages WHERE shared_messages.conversation_id = shared_conversations.id AND shared_messages.author IN ('codex', 'claude') AND shared_messages.created_at > COALESCE(shared_conversations.last_read_at, '')) AS is_unread,
        CASE WHEN (SELECT status FROM work_items WHERE work_items.id = shared_conversations.work_item_id) = 'pinned' THEN 1 ELSE 0 END AS linked_work_item_pinned,
        (SELECT project_name FROM work_items WHERE work_items.id = shared_conversations.work_item_id) AS linked_project_name
        FROM shared_conversations
      )
      SELECT * FROM conversations
      WHERE deleted_at IS NULL AND ((? = 'active' AND archived_at IS NULL) OR (? = 'archive' AND archived_at IS NOT NULL))
        AND (? IS NULL OR linked_work_item_pinned < ? OR (linked_work_item_pinned = ? AND (is_working < ? OR (is_working = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))))
      ORDER BY linked_work_item_pinned DESC, is_working DESC, updated_at DESC, id DESC LIMIT ?
    `).all(view, view, cursorValues?.id ?? null, Number(cursorValues?.isPinned ?? false), Number(cursorValues?.isPinned ?? false), Number(cursorValues?.isWorking ?? false), Number(cursorValues?.isWorking ?? false), cursorValues?.updatedAt ?? null, cursorValues?.updatedAt ?? null, cursorValues?.id ?? null, safeLimit + 1) as Array<Record<string, string | number | null>>;
    const hasMore = rows.length > safeLimit;
    const conversations = rows.slice(0, safeLimit).map(mapConversationRow);
    const totalCount = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM shared_conversations WHERE deleted_at IS NULL AND (${view === 'active' ? 'archived_at IS NULL' : 'archived_at IS NOT NULL'})`).get() as { count: number }).count);
    return { conversations, hasMore, totalCount };
  }

  create(title = 'New conversation', workItemId: string | null = null): SharedConversation {
    const id = randomUUID(); const now = new Date().toISOString();
    this.database.prepare('INSERT INTO shared_conversations (id, title, work_item_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, title, workItemId, now, now);
    return { id, title, workItemId, forkedFromConversationId: null, archivedAt: null, sharedBrief: '', preferredExecutionProfile: null, preferredAccountProfile: null, preferredDispatchTarget: null, isUnread: false, createdAt: now, updatedAt: now, isActive: false };
  }

  markRead(id: string): boolean {
    return Number(this.database.prepare('UPDATE shared_conversations SET last_read_at = ? WHERE id = ?').run(new Date().toISOString(), id).changes) > 0;
  }

  setSharedBrief(id: string, brief: string): boolean {
    return Number(this.database.prepare('UPDATE shared_conversations SET shared_brief = ?, updated_at = ? WHERE id = ?').run(brief, new Date().toISOString(), id).changes) > 0;
  }

  countActive(): number {
    return Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM shared_conversations WHERE archived_at IS NULL AND deleted_at IS NULL
    `).get() as { count: number }).count);
  }

  countUnread(): number {
    return Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM shared_conversations
      WHERE archived_at IS NULL AND deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM shared_messages
        WHERE shared_messages.conversation_id = shared_conversations.id
          AND shared_messages.author IN ('codex', 'claude')
          AND shared_messages.created_at > COALESCE(shared_conversations.last_read_at, '')
      )
    `).get() as { count: number }).count);
  }

  setExecutionProfile(id: string, profile: SharedConversation['preferredExecutionProfile']): boolean {
    return Number(this.database.prepare('UPDATE shared_conversations SET preferred_execution_profile = ?, updated_at = ? WHERE id = ?').run(profile ?? null, new Date().toISOString(), id).changes) > 0;
  }

  setComposerPreferences(id: string, preferences: Pick<SharedConversation, 'preferredExecutionProfile' | 'preferredAccountProfile' | 'preferredDispatchTarget'>): boolean {
    return Number(this.database.prepare(`UPDATE shared_conversations
      SET preferred_execution_profile = ?, preferred_account_profile = ?, preferred_dispatch_target = ?, updated_at = ?
      WHERE id = ?`).run(preferences.preferredExecutionProfile ?? null, preferences.preferredAccountProfile ?? null, preferences.preferredDispatchTarget ?? null, new Date().toISOString(), id).changes) > 0;
  }

  updateWorkItemId(id: string, workItemId: string | null): boolean {
    return Number(this.database.prepare('UPDATE shared_conversations SET work_item_id = ?, updated_at = ? WHERE id = ?').run(workItemId, new Date().toISOString(), id).changes) > 0;
  }

  setArchived(id: string, archived: boolean): boolean {
    const now = new Date().toISOString();
    return Number(this.database.prepare('UPDATE shared_conversations SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? now : null, now, id).changes) > 0;
  }

  setForkedFrom(forkId: string, sourceConversationId: string): void {
    this.database.prepare('UPDATE shared_conversations SET forked_from_conversation_id = ? WHERE id = ?').run(sourceConversationId, forkId);
  }

  /** Non-deleted conversations linked to a non-deleted work item, for the run-adoption backfill. */
  listWorkItemLinks(): Array<{ id: string; workItemId: string }> {
    return (this.database.prepare(`SELECT shared_conversations.id, shared_conversations.work_item_id
      FROM shared_conversations
      INNER JOIN work_items ON work_items.id = shared_conversations.work_item_id
      WHERE shared_conversations.deleted_at IS NULL AND work_items.deleted_at IS NULL`).all() as Array<{ id: string; work_item_id: string }>)
      .map((row) => ({ id: row.id, workItemId: row.work_item_id }));
  }

  /** Soft delete: flags the conversation row so it drops out of every list/get query but stays recoverable in the database. Messages are left in place for the same reason. */
  delete(id: string): boolean {
    return Number(this.database.prepare('UPDATE shared_conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND work_item_id IS NULL').run(new Date().toISOString(), id).changes) > 0;
  }

  /** Reverses `delete`: clears deleted_at so the conversation reappears in every list/get query. */
  undelete(id: string): boolean {
    return Number(this.database.prepare('UPDATE shared_conversations SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL').run(new Date().toISOString(), id).changes) > 0;
  }
}
