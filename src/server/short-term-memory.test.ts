import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from './database.js';
import { collectMemoryDocuments } from './memory-index.js';
import { WorkItemRepository } from './repository.js';

describe('short-term conversation memory', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('shares active memory from disk, removes it on archive, and rebuilds it on restore', () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-short-memory-'));
    roots.push(root);
    const database = openDatabase(':memory:');
    const repository = new WorkItemRepository(database, 'America/New_York', root);
    const current = repository.createConversation('Current work');
    const related = repository.createConversation('Staff promotion evidence');
    const decision = repository.createSharedMessage('jeffrey', 'Remember that I led the connector migration.', 'completed', related.id);
    repository.recordSharedBriefEntry(related.id, decision.id, 'jeffrey', 'decision', decision.body);

    const context = repository.getSharedContext(undefined, { conversationId: current.id, query: 'connector promotion' });
    const structured = repository.getSharedContextWithItems(undefined, { conversationId: current.id, query: 'connector promotion' });
    expect(context).toContain(`on disk at ${root}`);
    expect(context).toContain('Current work');
    expect(context).toContain('Remember that I led the connector migration.');
    expect(structured.items.map((item) => item.title)).toEqual(expect.arrayContaining(['Current work', 'Staff promotion evidence']));
    expect(structured.items.every((item) => item.source === 'active_conversation')).toBe(true);
    expect(existsSync(join(root, `${related.id}.json`))).toBe(true);
    expect(readFileSync(join(root, 'index.md'), 'utf8')).toContain('Staff promotion evidence');

    repository.setConversationArchived(related.id, true);
    expect(existsSync(join(root, `${related.id}.json`))).toBe(false);
    expect(repository.getSharedContext(undefined, { conversationId: current.id, query: 'connector promotion' })).not.toContain('connector migration');
    expect(repository.listAllSharedMessages(related.id).map((message) => message.body)).toContain('Remember that I led the connector migration.');
    collectMemoryDocuments(database, { docRoots: [] });
    expect(database.prepare(`SELECT body FROM memory_documents WHERE source = 'message' AND source_id = ?`).get(decision.id)).toEqual(expect.objectContaining({ body: 'Remember that I led the connector migration.' }));

    repository.setConversationArchived(related.id, false);
    expect(existsSync(join(root, `${related.id}.json`))).toBe(true);
    expect(repository.getSharedContext(undefined, { conversationId: current.id, query: 'connector promotion' })).toContain('connector migration');
    database.close();
  });
});
