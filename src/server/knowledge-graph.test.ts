import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { expandKnowledgeGraph } from './knowledge-graph.js';
import { collectMemoryDocuments } from './memory-index.js';
import { WorkItemRepository } from './repository.js';

describe('knowledge graph', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

  it('writes canonical records and deterministic graph edges in the same transaction', () => {
    const task = repository.create({ title: 'Graph transaction', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Graph transaction', task.id);
    const messageId = '00000000-0000-4000-8000-000000000078';

    database.exec('BEGIN IMMEDIATE;');
    database.prepare(`INSERT INTO shared_messages (id, conversation_id, author, body, status, dispatch_target, created_at)
      VALUES (?, ?, 'jeffrey', 'Transactional graph write.', 'completed', 'none', ?)`)
      .run(messageId, conversation.id, '2026-09-09T12:00:00.000Z');
    expect(database.prepare('SELECT source_table, source_id FROM knowledge_graph_nodes WHERE id = ?').get(`message:${messageId}`))
      .toEqual({ source_table: 'shared_messages', source_id: messageId });
    database.exec('ROLLBACK;');

    expect(database.prepare('SELECT id FROM shared_messages WHERE id = ?').get(messageId)).toBeUndefined();
    expect(database.prepare('SELECT id FROM knowledge_graph_nodes WHERE id = ?').get(`message:${messageId}`)).toBeUndefined();
  });

  it('expands a text match to source-backed memories in the same conversation', () => {
    const task = repository.create({ title: 'Graph retrieval', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Graph retrieval', task.id);
    const seed = repository.createSharedMessage('jeffrey', 'Investigate nebulafalcon failures.', 'completed', conversation.id);
    const related = repository.createSharedMessage('claude', 'The durable decision was to use cursor pagination.', 'completed', conversation.id);
    collectMemoryDocuments(database, { docRoots: [] });

    const results = expandKnowledgeGraph(database, [{ source: 'message', sourceId: seed.id, score: 1 }], { sources: ['message'], limit: 10 });
    const match = results.find((result) => result.sourceId === related.id);

    expect(match?.snippet).toContain('cursor pagination');
    expect(match?.retrievalPath).toEqual(['Matched request', 'Same conversation']);
    expect(results.some((result) => result.sourceId === seed.id)).toBe(false);
  });

  it('ranks task evidence above a generic task relationship', () => {
    const task = repository.create({ title: 'Weighted graph retrieval', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const activity = repository.addActivity(task.id, 'jeffrey', 'progress', 'Implemented the rollout.');
    database.prepare(`
      INSERT INTO published_artifacts (id, source_path, work_item_id, title, public_url, published_at)
      VALUES ('weighted-artifact', '/tmp/evidence.md', ?, 'Verified rollout evidence', 'https://example.test/evidence', ?)
    `).run(task.id, '2026-09-09T12:00:00.000Z');
    collectMemoryDocuments(database, { docRoots: [] });

    const results = expandKnowledgeGraph(database, [{ source: 'work_item', sourceId: task.id, score: 1 }], {
      sources: ['activity', 'artifact'], limit: 20,
    });
    const artifact = results.find((result) => result.sourceId === 'weighted-artifact');
    const genericActivity = results.find((result) => result.sourceId === activity.id);

    expect(artifact?.retrievalPath).toEqual(['Matched request', 'Task evidence']);
    expect(artifact!.score).toBeGreaterThan(genericActivity!.score);
  });

  it('rewires graph scope when a conversation is linked to a different task', () => {
    const first = repository.create({ title: 'First task', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const second = repository.create({ title: 'Second task', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Move me', first.id);

    database.prepare('UPDATE shared_conversations SET work_item_id = ? WHERE id = ?').run(second.id, conversation.id);

    expect(database.prepare("SELECT to_node_id FROM knowledge_graph_edges WHERE from_node_id = ? AND relation = 'linked_to_task'").all(`conversation:${conversation.id}`))
      .toEqual([{ to_node_id: `work_item:${second.id}` }]);
  });

  it('restores task relationships when a canonical project is recreated', () => {
    const task = repository.create({ title: 'Project replay', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const project = database.prepare("SELECT id, name, key, created_at, updated_at FROM projects WHERE key = 'workbench'").get() as {
      id: string; name: string; key: string; created_at: string; updated_at: string;
    };

    database.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    expect(database.prepare("SELECT relation FROM knowledge_graph_edges WHERE from_node_id = ? AND relation = 'belongs_to_project'").get(`work_item:${task.id}`)).toBeUndefined();

    database.prepare('INSERT INTO projects (id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.key, project.created_at, project.updated_at);

    expect(database.prepare("SELECT to_node_id FROM knowledge_graph_edges WHERE from_node_id = ? AND relation = 'belongs_to_project'").get(`work_item:${task.id}`))
      .toEqual({ to_node_id: `project:${project.id}` });
  });
});
