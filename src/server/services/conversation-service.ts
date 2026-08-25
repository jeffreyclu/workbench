import { randomUUID } from 'node:crypto';

import type { Activity, SharedConversation, SharedMessage, TaskClassification, WorkItem } from '../../shared/contracts.js';
import type { WorkbenchDatabase } from '../database.js';
import type { ConversationRepository } from '../repositories/conversation-repository.js';
import type { UnitOfWork } from '../unit-of-work.js';

export interface ConversationCollaborators {
  getConversation(id: string): SharedConversation | null;
  getWorkItem(id: string): WorkItem | null;
  getClassification(workItemId: string): TaskClassification | null;
  listAllSharedMessages(conversationId: string): SharedMessage[];
  createConversation(title: string, workItemId: string | null): SharedConversation;
  createSharedMessage(author: SharedMessage['author'], body: string, status: SharedMessage['status'], conversationId: string, attachments: SharedMessage['attachments'], dispatchTarget: 'none'): SharedMessage;
  archiveWorkItem(id: string, completed: boolean, withinTransaction: boolean, context: { actor?: Activity['actor']; reason?: string }): WorkItem | null;
  addActivity(workItemId: string, actor: Activity['actor'], kind: string, body: string): Activity;
}

/** Cross-domain conversation operations: task linking, run-history adoption,
 * archiving a task-backed thread, and forking a thread with its messages. */
export class ConversationService {
  constructor(
    private readonly database: WorkbenchDatabase,
    private readonly unitOfWork: UnitOfWork,
    private readonly conversations: ConversationRepository,
    private readonly collaborators: ConversationCollaborators,
  ) {}

  setWorkItem(id: string, workItemId: string | null): SharedConversation | null {
    const before = this.collaborators.getConversation(id);
    if (!before || (workItemId && !this.collaborators.getWorkItem(workItemId))) return null;
    return this.unitOfWork.transaction(() => {
      if (!this.conversations.updateWorkItemId(id, workItemId)) return null;
      if (before.workItemId && before.workItemId !== workItemId) {
        this.database.prepare('DELETE FROM agent_runs WHERE work_item_id = ? AND adopted_conversation_id = ?').run(before.workItemId, id);
        this.database.prepare('UPDATE agent_handoffs SET work_item_id = NULL WHERE conversation_id = ?').run(id);
        this.database.prepare('UPDATE shared_brief_entries SET work_item_id = NULL WHERE conversation_id = ?').run(id);
        this.collaborators.addActivity(before.workItemId, 'jeffrey', 'conversation_unlinked', `Unlinked conversation “${before.title}” and removed its adopted agent-run history.`);
      }
      if (workItemId) {
        this.database.prepare('UPDATE agent_handoffs SET work_item_id = ? WHERE conversation_id = ?').run(workItemId, id);
        this.database.prepare('UPDATE shared_brief_entries SET work_item_id = ? WHERE conversation_id = ?').run(workItemId, id);
        const adopted = this.adoptRuns(workItemId, id);
        if (before.workItemId !== workItemId || adopted) this.collaborators.addActivity(workItemId, 'jeffrey', 'conversation_linked', `Linked conversation “${before.title}” and adopted ${adopted} agent ${adopted === 1 ? 'run' : 'runs'} as task execution history.`);
      }
      return this.collaborators.getConversation(id);
    });
  }

  adoptRuns(workItemId: string, conversationId: string): number {
    const kind = this.collaborators.getClassification(workItemId)?.kind ?? 'analysis';
    const messages = this.collaborators.listAllSharedMessages(conversationId).filter((message) => message.author === 'codex' || message.author === 'claude');
    const insertRun = this.database.prepare(`INSERT INTO agent_runs (id, work_item_id, kind, requested_target, requested_agent, agent, status, instructions, output, error, started_at, completed_at, created_at, conversation_id, message_id, model, execution_profile, input_tokens, output_tokens, estimated_cost_usd, fallback_from, fallback_reason, adopted_conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let adopted = 0;
    for (const message of messages) {
      if (this.database.prepare('SELECT 1 FROM agent_runs WHERE message_id = ?').get(message.id)) continue;
      insertRun.run(randomUUID(), workItemId, kind, message.author, message.author, message.author, message.status, 'Adopted from linked conversation.', message.body, message.error, message.createdAt, message.completedAt, message.createdAt, conversationId, message.id, message.model, message.executionProfile, message.inputTokens, message.outputTokens, message.estimatedCostUsd, message.fallbackFrom, message.fallbackReason, conversationId);
      adopted += 1;
    }
    return adopted;
  }

  backfillRunAdoptions(): number {
    return this.unitOfWork.transaction(() => this.conversations.listWorkItemLinks().reduce((total, link) => total + this.adoptRuns(link.workItemId, link.id), 0));
  }

  setArchived(id: string, archived: boolean): SharedConversation | null {
    const existing = this.collaborators.getConversation(id);
    if (!existing) return null;
    return this.unitOfWork.transaction(() => {
      if (archived && existing.workItemId) {
        const task = this.collaborators.getWorkItem(existing.workItemId);
        if (task && !task.archivedAt) this.collaborators.archiveWorkItem(task.id, false, true, { actor: 'jeffrey', reason: 'its conversation was archived' });
      }
      // An archived thread cannot accept another turn. Leaving a queued reply
      // behind makes the global release guard see permanent live work, which
      // blocks every preview promotion after this conversation has disappeared
      // from the active rail.
      if (archived) {
        this.database.prepare(`UPDATE shared_messages
          SET status = 'canceled', completed_at = COALESCE(completed_at, ?)
          WHERE conversation_id = ? AND status = 'queued'`).run(new Date().toISOString(), id);
      }
      return this.conversations.setArchived(id, archived) ? this.collaborators.getConversation(id) : null;
    });
  }

  fork(id: string): SharedConversation | null {
    const source = this.collaborators.getConversation(id);
    if (!source) return null;
    return this.unitOfWork.transaction(() => {
      const fork = this.collaborators.createConversation(`${source.title} · fork`, source.workItemId);
      this.conversations.setForkedFrom(fork.id, source.id);
      for (const message of this.collaborators.listAllSharedMessages(source.id)) {
        this.collaborators.createSharedMessage(message.author, message.body, message.status === 'running' || message.status === 'queued' ? 'completed' : message.status, fork.id, message.attachments, 'none');
      }
      if (source.workItemId) this.setWorkItem(source.id, null);
      return this.collaborators.getConversation(fork.id);
    });
  }
}
