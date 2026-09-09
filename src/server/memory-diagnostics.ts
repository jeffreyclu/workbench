import type { MemoryDiagnostics, MemoryDiagnosticsRecentRetrieval } from '../shared/contracts.js';
import type { WorkbenchDatabase } from './database.js';
import { expandKnowledgeGraph } from './knowledge-graph.js';

const REQUIRED_TRIGGERS = [
  'knowledge_graph_projects_insert',
  'knowledge_graph_projects_delete',
  'knowledge_graph_work_items_insert',
  'knowledge_graph_work_items_project_update',
  'knowledge_graph_work_items_delete',
  'knowledge_graph_conversations_insert',
  'knowledge_graph_conversations_task_update',
  'knowledge_graph_conversations_delete',
  'knowledge_graph_messages_insert',
  'knowledge_graph_messages_delete',
  'knowledge_graph_activities_insert',
  'knowledge_graph_activities_delete',
  'knowledge_graph_agent_runs_insert',
  'knowledge_graph_agent_runs_conversation_update',
  'knowledge_graph_agent_runs_delete',
  'knowledge_graph_audit_insert',
  'knowledge_graph_audit_delete',
  'knowledge_graph_artifacts_insert',
  'knowledge_graph_artifacts_scope_update',
  'knowledge_graph_artifacts_delete',
] as const;

type RetrievalDetail = {
  query?: unknown;
  items?: Array<{ retrievalPath?: unknown }>;
};

type RetrievalRow = {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  author: string;
  created_at: string;
  retrieved_memory_count: number;
  retrieved_memory_detail_json: string | null;
};

function pathsFromDetail(raw: string | null): { query: string; paths: string[][]; graphExpandedCount: number } {
  if (!raw) return { query: '', paths: [], graphExpandedCount: 0 };
  try {
    const detail = JSON.parse(raw) as RetrievalDetail;
    const paths = (Array.isArray(detail.items) ? detail.items : [])
      .map((item) => Array.isArray(item.retrievalPath) ? item.retrievalPath.filter((part): part is string => typeof part === 'string') : [])
      .filter((path) => path.length > 0);
    const uniquePaths = [...new Map(paths.map((path) => [path.join('\u0000'), path])).values()];
    return {
      query: typeof detail.query === 'string' ? detail.query : '',
      paths: uniquePaths,
      graphExpandedCount: paths.filter((path) => path.length > 1).length,
    };
  } catch {
    return { query: '', paths: [], graphExpandedCount: 0 };
  }
}

function emptyDiagnostics(error: unknown): MemoryDiagnostics {
  return {
    status: 'degraded',
    summary: 'Memory diagnostics could not read the knowledge graph.',
    checkedAt: new Date().toISOString(),
    migrationApplied: false,
    graph: { nodeCount: 0, edgeCount: 0, canonicalNodeCount: 0, missingNodeCount: 0, staleNodeCount: 0, danglingEdgeCount: 0, triggerCount: 0, requiredTriggerCount: REQUIRED_TRIGGERS.length },
    traversalCanary: { status: 'failed', path: [], detail: error instanceof Error ? error.message : 'Unknown database error.' },
    retrievals: { totalReplies: 0, graphExpandedReplies: 0, lastRetrievedAt: null, recent: [] },
  };
}

/** Read-only proof that the graph projection, live traversal, and reply retrieval ledger are usable. */
export function getMemoryDiagnostics(database: WorkbenchDatabase): MemoryDiagnostics {
  try {
    const migrationApplied = Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE id = '078_knowledge_graph'").get());
    const graphCounts = database.prepare(`SELECT
      (SELECT COUNT(*) FROM knowledge_graph_nodes) AS node_count,
      (SELECT COUNT(*) FROM knowledge_graph_edges) AS edge_count`).get() as { node_count: number; edge_count: number };
    const projection = database.prepare(`SELECT SUM(canonical_count) AS canonical_count, SUM(missing_count) AS missing_count FROM (
      SELECT COUNT(*) AS canonical_count, COUNT(*) FILTER (WHERE graph.id IS NULL) AS missing_count FROM projects source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'project:' || source.id
      UNION ALL SELECT COUNT(*), COUNT(*) FILTER (WHERE graph.id IS NULL) FROM work_items source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'work_item:' || source.id
      UNION ALL SELECT COUNT(*), COUNT(*) FILTER (WHERE graph.id IS NULL) FROM shared_conversations source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'conversation:' || source.id
      UNION ALL SELECT COUNT(*), COUNT(*) FILTER (WHERE graph.id IS NULL) FROM shared_messages source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'message:' || source.id
      UNION ALL SELECT COUNT(*), COUNT(*) FILTER (WHERE graph.id IS NULL) FROM activities source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'activity:' || source.id
      UNION ALL SELECT COUNT(*), COUNT(*) FILTER (WHERE graph.id IS NULL) FROM agent_runs source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'agent_run:' || source.id
      UNION ALL SELECT COUNT(*), COUNT(*) FILTER (WHERE graph.id IS NULL) FROM audit_log source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'audit:' || source.id
      UNION ALL SELECT COUNT(*), COUNT(*) FILTER (WHERE graph.id IS NULL) FROM published_artifacts source LEFT JOIN knowledge_graph_nodes graph ON graph.id = 'artifact:' || source.id
    )`).get() as { canonical_count: number; missing_count: number };
    const staleCount = Math.max(0, graphCounts.node_count - (projection.canonical_count - projection.missing_count));
    const dangling = database.prepare(`SELECT COUNT(*) AS count FROM knowledge_graph_edges e
      LEFT JOIN knowledge_graph_nodes source ON source.id = e.from_node_id
      LEFT JOIN knowledge_graph_nodes target ON target.id = e.to_node_id
      WHERE source.id IS NULL OR target.id IS NULL`).get() as { count: number };
    const installedTriggers = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'knowledge_graph_%'").all() as Array<{ name: string }>).map(({ name }) => name));
    const triggerCount = REQUIRED_TRIGGERS.filter((name) => installedTriggers.has(name)).length;

    const seed = database.prepare(`SELECT message.id AS source_id
      FROM shared_messages message INDEXED BY idx_shared_messages_created
      JOIN memory_documents md ON md.source = 'message' AND md.source_id = message.id
      WHERE EXISTS (
        SELECT 1 FROM shared_messages sibling
        JOIN memory_documents sibling_document ON sibling_document.source = 'message' AND sibling_document.source_id = sibling.id
        WHERE sibling.conversation_id = message.conversation_id AND sibling.id <> message.id
      )
      ORDER BY message.created_at DESC LIMIT 1`).get() as { source_id: string } | undefined;
    const traversal = seed
      ? expandKnowledgeGraph(database, [{ source: 'message', sourceId: seed.source_id, score: 1 }], { sources: ['message'], limit: 10 })
      : [];
    const expanded = traversal.find((result) => result.retrievalPath.length > 1);
    const traversalCanary: MemoryDiagnostics['traversalCanary'] = !seed
      ? { status: 'no_data', path: [], detail: 'No indexed conversation has two memories yet.' }
      : expanded
        ? { status: 'passed', path: expanded.retrievalPath, detail: 'A live read followed the graph to a related memory.' }
        : { status: 'failed', path: [], detail: 'An indexed linked memory exists, but graph traversal did not return it.' };

    const recentRows = database.prepare(`SELECT message.id AS message_id, message.conversation_id,
        conversation.title AS conversation_title, message.author, message.created_at,
        message.retrieved_memory_count, message.retrieved_memory_detail_json
      FROM shared_messages message
      JOIN shared_conversations conversation ON conversation.id = message.conversation_id
      WHERE message.retrieved_memory_count > 0
      ORDER BY message.created_at DESC LIMIT 10`).all() as RetrievalRow[];
    const recent: MemoryDiagnosticsRecentRetrieval[] = recentRows.map((row) => {
      const detail = pathsFromDetail(row.retrieved_memory_detail_json);
      const graphExpandedCount = detail.graphExpandedCount;
      return {
        messageId: row.message_id,
        conversationId: row.conversation_id,
        conversationTitle: row.conversation_title,
        author: row.author,
        createdAt: row.created_at,
        query: detail.query,
        retrievedCount: row.retrieved_memory_count,
        directCount: Math.max(0, row.retrieved_memory_count - graphExpandedCount),
        graphExpandedCount,
        paths: detail.paths,
      };
    });
    const retrievalTotals = database.prepare(`SELECT COUNT(*) AS total_replies,
        COALESCE(SUM(CASE WHEN retrieved_memory_detail_json IS NOT NULL
          AND json_valid(retrieved_memory_detail_json)
          AND EXISTS (
            SELECT 1 FROM json_each(retrieved_memory_detail_json, '$.items') item
            WHERE json_array_length(json_extract(item.value, '$.retrievalPath')) > 1
          ) THEN 1 ELSE 0 END), 0) AS graph_expanded_replies,
        MAX(created_at) AS last_retrieved_at
      FROM shared_messages WHERE retrieved_memory_count > 0`).get() as {
        total_replies: number; graph_expanded_replies: number; last_retrieved_at: string | null;
      };

    const graph = {
      nodeCount: graphCounts.node_count,
      edgeCount: graphCounts.edge_count,
      canonicalNodeCount: projection.canonical_count,
      missingNodeCount: projection.missing_count,
      staleNodeCount: staleCount,
      danglingEdgeCount: dangling.count,
      triggerCount,
      requiredTriggerCount: REQUIRED_TRIGGERS.length,
    };
    const structureHealthy = migrationApplied && graph.missingNodeCount === 0 && graph.staleNodeCount === 0
      && graph.danglingEdgeCount === 0 && graph.triggerCount === graph.requiredTriggerCount;
    const status: MemoryDiagnostics['status'] = !structureHealthy || traversalCanary.status === 'failed'
      ? 'degraded'
      : traversalCanary.status === 'no_data' ? 'ready' : 'healthy';
    const summary = status === 'healthy'
      ? 'The memory graph is synced and live traversal passed.'
      : status === 'ready'
        ? 'The memory graph is synced and waiting for enough linked memories to test traversal.'
        : 'The memory graph needs attention. See the failed checks below.';

    return {
      status,
      summary,
      checkedAt: new Date().toISOString(),
      migrationApplied,
      graph,
      traversalCanary,
      retrievals: {
        totalReplies: retrievalTotals.total_replies,
        graphExpandedReplies: retrievalTotals.graph_expanded_replies,
        lastRetrievedAt: retrievalTotals.last_retrieved_at,
        recent,
      },
    };
  } catch (error) {
    return emptyDiagnostics(error);
  }
}
