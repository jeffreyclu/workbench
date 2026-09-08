import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { WorkbenchDatabase } from './database.js';

interface ShortTermEntry {
  author: string;
  kind: string;
  facts: string;
  decisions: string;
  blockers: string;
  evidence: string;
  createdAt: string;
}

interface ShortTermConversation {
  version: 1;
  id: string;
  title: string;
  workItemId: string | null;
  projectName: string | null;
  updatedAt: string;
  sharedBrief: string;
  entries: ShortTermEntry[];
}

const WORD = /[a-z0-9][a-z0-9_-]{2,}/g;

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(WORD) ?? []);
}

function renderConversation(memory: ShortTermConversation): string {
  const entries = memory.entries.map((entry) => [
    `- ${entry.kind} from ${entry.author}:`,
    entry.facts ? `  Facts: ${entry.facts}` : '',
    entry.decisions ? `  Decisions: ${entry.decisions}` : '',
    entry.blockers ? `  Blockers: ${entry.blockers}` : '',
    entry.evidence ? `  Evidence: ${entry.evidence}` : '',
  ].filter(Boolean).join('\n'));
  return [
    `### ${memory.title}`,
    `Conversation: ${memory.id}`,
    memory.projectName ? `Project: ${memory.projectName}` : '',
    memory.sharedBrief ? `Jeffrey's maintained brief:\n${memory.sharedBrief}` : '',
    ...entries,
  ].filter(Boolean).join('\n');
}

/**
 * A rebuildable, on-disk projection of active conversation briefs. SQLite
 * remains the durable record; this tier is intentionally deleted when a
 * conversation is archived and rebuilt from SQLite when it is restored.
 */
export class ShortTermMemoryStore {
  readonly root: string | null;

  constructor(private readonly database: WorkbenchDatabase, root: string | null) {
    this.root = root ? resolve(root) : null;
    if (this.root) this.syncAll();
  }

  private file(id: string): string {
    if (!this.root) throw new Error('Short-term memory is disabled.');
    return resolve(this.root, `${id}.json`);
  }

  private snapshot(id: string): ShortTermConversation | null {
    const conversation = this.database.prepare(`SELECT c.id, c.title, c.work_item_id, c.shared_brief, c.updated_at,
      w.project_name FROM shared_conversations c LEFT JOIN work_items w ON w.id = c.work_item_id
      WHERE c.id = ? AND c.archived_at IS NULL AND c.deleted_at IS NULL`).get(id) as {
        id: string; title: string; work_item_id: string | null; shared_brief: string; updated_at: string; project_name: string | null;
      } | undefined;
    if (!conversation) return null;
    const rows = this.database.prepare(`SELECT author, kind, facts, decisions, blockers, evidence, created_at
      FROM shared_brief_entries WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 12`).all(id) as Array<{
        author: string; kind: string; facts: string; decisions: string; blockers: string; evidence: string; created_at: string;
      }>;
    return {
      version: 1,
      id: conversation.id,
      title: conversation.title,
      workItemId: conversation.work_item_id,
      projectName: conversation.project_name,
      updatedAt: conversation.updated_at,
      sharedBrief: conversation.shared_brief ?? '',
      entries: rows.reverse().map((row) => ({
        author: row.author,
        kind: row.kind,
        facts: row.facts,
        decisions: row.decisions,
        blockers: row.blockers,
        evidence: row.evidence,
        createdAt: row.created_at,
      })),
    };
  }

  syncConversation(id: string): void {
    if (!this.root) return;
    mkdirSync(this.root, { recursive: true });
    const snapshot = this.snapshot(id);
    const file = this.file(id);
    if (!snapshot) {
      rmSync(file, { force: true });
      this.writeIndex();
      return;
    }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
    this.writeIndex();
  }

  syncAll(): void {
    if (!this.root) return;
    mkdirSync(this.root, { recursive: true });
    const activeIds = new Set((this.database.prepare(`SELECT id FROM shared_conversations
      WHERE archived_at IS NULL AND deleted_at IS NULL`).all() as Array<{ id: string }>).map((row) => row.id));
    for (const entry of readdirSync(this.root)) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      if (!activeIds.has(id)) rmSync(resolve(this.root, entry), { force: true });
    }
    for (const id of activeIds) {
      const snapshot = this.snapshot(id);
      if (!snapshot) continue;
      const file = this.file(id);
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      renameSync(temporary, file);
    }
    this.writeIndex();
  }

  private memories(): ShortTermConversation[] {
    if (!this.root) return [];
    const memories: ShortTermConversation[] = [];
    for (const entry of readdirSync(this.root)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const value = JSON.parse(readFileSync(resolve(this.root, entry), 'utf8')) as ShortTermConversation;
        if (value?.version === 1 && value.id && Array.isArray(value.entries)) memories.push(value);
      } catch {
        // One interrupted or manually edited snapshot must not hide the rest.
      }
    }
    return memories;
  }

  context(scope: { conversationId?: string; workItemId?: string; query?: string } = {}, budget = 2_400): string {
    if (!this.root) return '';
    const queryWords = words(scope.query ?? '');
    const scored = this.memories().map((memory) => {
      const haystack = words(`${memory.title} ${memory.projectName ?? ''} ${memory.sharedBrief} ${memory.entries.map((entry) => `${entry.facts} ${entry.decisions} ${entry.blockers} ${entry.evidence}`).join(' ')}`);
      let score = memory.id === scope.conversationId ? 10_000 : memory.workItemId && memory.workItemId === scope.workItemId ? 5_000 : 0;
      for (const word of queryWords) if (haystack.has(word)) score += 1;
      return { memory, score };
    }).sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
    const prefix = `Short-term memory from active conversations (on disk at ${this.root}; use this before long-term recall):\n`;
    let output = prefix;
    for (const [index, { memory }] of scored.slice(0, 5).entries()) {
      const complete = renderConversation(memory);
      const perConversationBudget = memory.id === scope.conversationId ? 1_100 : index === 0 ? 900 : 600;
      const section = complete.length <= perConversationBudget ? complete : `${complete.slice(0, perConversationBudget - 1)}…`;
      const rendered = `${output === prefix ? '' : '\n\n'}${section}`;
      if (output.length + rendered.length > budget) {
        const remaining = budget - output.length;
        if (remaining > 200) output += `${rendered.slice(0, remaining - 1)}…`;
        break;
      }
      output += rendered;
    }
    return output === prefix ? `${prefix}No active conversation memory yet.` : output;
  }

  private writeIndex(): void {
    if (!this.root) return;
    const lines = this.memories()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((memory) => `- ${memory.title} — ${memory.id}.json${memory.projectName ? ` — ${memory.projectName}` : ''}`);
    const file = resolve(this.root, 'index.md');
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `# Active conversation memory\n\n${lines.join('\n') || 'No active conversations.'}\n`, 'utf8');
    renameSync(temporary, file);
  }
}
