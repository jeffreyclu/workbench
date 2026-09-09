import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type WorkbenchDatabase } from './database.js';
import { getMemoryDiagnostics } from './memory-diagnostics.js';
import { collectMemoryDocuments } from './memory-index.js';
import { WorkItemRepository } from './repository.js';

describe('memory diagnostics', () => {
  let database: WorkbenchDatabase;
  let repository: WorkItemRepository;

  beforeEach(() => {
    database = openDatabase(':memory:');
    repository = new WorkItemRepository(database);
  });

  afterEach(() => database.close());

  function createLinkedMemories() {
    const task = repository.create({ title: 'Visible graph proof', description: '', priority: 1, status: 'ready', projectName: 'Workbench', workspacePath: null, dueDate: null });
    const conversation = repository.createConversation('Visible graph proof', task.id);
    const seed = repository.createSharedMessage('jeffrey', 'What did we decide?', 'completed', conversation.id);
    const related = repository.createSharedMessage('claude', 'We decided to expose diagnostics.', 'completed', conversation.id);
    collectMemoryDocuments(database, { docRoots: [] });
    return { conversation, seed, related };
  }

  it('proves projection sync and a live graph traversal', () => {
    createLinkedMemories();

    const result = getMemoryDiagnostics(database);

    expect(result.status).toBe('healthy');
    expect(result.migrationApplied).toBe(true);
    expect(result.graph.triggerCount).toBe(20);
    expect(result.graph.missingNodeCount).toBe(0);
    expect(result.graph.staleNodeCount).toBe(0);
    expect(result.graph.danglingEdgeCount).toBe(0);
    expect(result.traversalCanary.status).toBe('passed');
    expect(result.traversalCanary.path).toEqual(['Matched request', 'Same conversation']);
  });

  it('shows which reply kept a graph-expanded result', () => {
    const { conversation, related } = createLinkedMemories();
    repository.updateSharedMessage(related.id, {
      retrievedMemoryCount: 2,
      retrievedMemoryDetail: {
        query: 'diagnostics decision',
        items: [
          { source: 'message', title: 'Direct', body: 'Direct result', createdAt: '2026-09-09T12:00:00.000Z', retrievalPath: ['Matched request'] },
          { source: 'message', title: 'Related', body: 'Expanded result', createdAt: '2026-09-09T12:00:00.000Z', retrievalPath: ['Matched request', 'Same conversation'] },
        ],
      },
    });

    const result = getMemoryDiagnostics(database);
    const evidence = result.retrievals.recent[0];

    expect(result.retrievals.graphExpandedReplies).toBe(1);
    expect(evidence.conversationId).toBe(conversation.id);
    expect(evidence.directCount).toBe(1);
    expect(evidence.graphExpandedCount).toBe(1);
    expect(evidence.paths).toContainEqual(['Matched request', 'Same conversation']);
  });

  it('reports a missing synchronization trigger as degraded', () => {
    database.exec('DROP TRIGGER knowledge_graph_messages_insert');

    const result = getMemoryDiagnostics(database);

    expect(result.status).toBe('degraded');
    expect(result.graph.triggerCount).toBe(19);
    expect(result.graph.requiredTriggerCount).toBe(20);
  });
});
