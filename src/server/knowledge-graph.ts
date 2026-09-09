import type { WorkbenchDatabase } from './database.js';

export interface KnowledgeGraphSeed {
  source: string;
  sourceId: string;
  score: number;
}

export interface KnowledgeGraphMemoryResult {
  source: string;
  sourceId: string;
  title: string;
  snippet: string;
  createdAt: string;
  conversationId: string | null;
  workItemId: string | null;
  actor: string | null;
  score: number;
  retrievalPath: string[];
}

const MAX_SEEDS = 8;
const MAX_GRAPH_NODES = 120;
const MAX_HOPS = 2;
const MAX_EDGES_PER_HOP = 2_000;
const GRAPH_HOP_DECAY = 0.96;

const RELATION_WEIGHTS: Readonly<Record<string, number>> = {
  evidence_for_task: 0.95,
  published_from_conversation: 0.93,
  in_conversation: 0.92,
  linked_to_task: 0.88,
  about_task: 0.86,
  executes_task: 0.82,
  belongs_to_project: 0.7,
};

const RELATION_LABELS: Record<string, string> = {
  belongs_to_project: 'Same project',
  linked_to_task: 'Linked task',
  in_conversation: 'Same conversation',
  about_task: 'Same task',
  executes_task: 'Task execution',
  evidence_for_task: 'Task evidence',
  published_from_conversation: 'Published from conversation',
};

function graphNodeId(source: string, sourceId: string): string | null {
  if (source === 'message') return `message:${sourceId}`;
  if (source === 'conversation') return `conversation:${sourceId}`;
  if (source === 'activity') return `activity:${sourceId}`;
  if (source === 'work_item') return `work_item:${sourceId}`;
  if (source === 'audit') return `audit:${sourceId}`;
  if (source === 'artifact') return `artifact:${sourceId}`;
  if (source === 'run_instructions' || source === 'run_output' || source === 'run_error') {
    return `agent_run:${sourceId.replace(/:(?:instructions|output|error)$/, '')}`;
  }
  return null;
}

type WalkState = {
  nodeId: string;
  depth: number;
  score: number;
  retrievalPath: string[];
};

type EdgeRow = { from_node_id: string; to_node_id: string; relation: string; created_at: string };

/**
 * Expands already-ranked hybrid-search seeds through source-backed SQLite
 * relationships. It returns memory documents, never copied graph content.
 * Missing or stale graph state is a soft failure so hybrid RAG remains usable.
 */
export function expandKnowledgeGraph(
  database: WorkbenchDatabase,
  seeds: KnowledgeGraphSeed[],
  options: { limit?: number; sources?: string[]; projectKey?: string; conversationId?: string; workItemId?: string } = {},
): KnowledgeGraphMemoryResult[] {
  const limit = Math.max(0, Math.min(50, options.limit ?? 12));
  if (!limit || !seeds.length) return [];

  try {
    const visited = new Map<string, WalkState>();
    const seedNodeIds = new Set<string>();
    for (const seed of seeds.slice(0, MAX_SEEDS)) {
      const nodeId = graphNodeId(seed.source, seed.sourceId);
      if (!nodeId || visited.has(nodeId)) continue;
      seedNodeIds.add(nodeId);
      visited.set(nodeId, { nodeId, depth: 0, score: seed.score, retrievalPath: ['Matched request'] });
    }
    if (!visited.size) return [];

    let frontier = [...visited.values()];
    for (let depth = 1; depth <= MAX_HOPS && frontier.length && visited.size < MAX_GRAPH_NODES; depth += 1) {
      const ids = frontier.map(({ nodeId }) => nodeId);
      const placeholders = ids.map(() => '?').join(',');
      const edges = database.prepare(`
        SELECT from_node_id, to_node_id, relation, created_at FROM knowledge_graph_edges
        WHERE from_node_id IN (${placeholders}) OR to_node_id IN (${placeholders})
        ORDER BY CASE relation
          WHEN 'evidence_for_task' THEN 1
          WHEN 'published_from_conversation' THEN 2
          WHEN 'in_conversation' THEN 3
          WHEN 'linked_to_task' THEN 4
          WHEN 'about_task' THEN 5
          WHEN 'executes_task' THEN 6
          WHEN 'belongs_to_project' THEN 7
          ELSE 8 END,
          created_at DESC, from_node_id, relation, to_node_id
        LIMIT ${MAX_EDGES_PER_HOP}
      `).all(...ids, ...ids) as EdgeRow[];
      const frontierById = new Map(frontier.map((state) => [state.nodeId, state]));
      const candidates = new Map<string, WalkState>();
      for (const edge of edges) {
        const traversals: Array<[WalkState | undefined, string]> = [
          [frontierById.get(edge.from_node_id), edge.to_node_id],
          [frontierById.get(edge.to_node_id), edge.from_node_id],
        ];
        for (const [state, nodeId] of traversals) {
          if (!state || visited.has(nodeId)) continue;
          const relationLabel = RELATION_LABELS[edge.relation] ?? edge.relation;
          const discovered: WalkState = {
            nodeId,
            depth,
            score: state.score * GRAPH_HOP_DECAY * (RELATION_WEIGHTS[edge.relation] ?? 0.75),
            retrievalPath: state.retrievalPath.at(-1) === relationLabel ? state.retrievalPath : [...state.retrievalPath, relationLabel],
          };
          const previous = candidates.get(nodeId);
          if (!previous || discovered.score > previous.score) candidates.set(nodeId, discovered);
        }
      }
      const next = [...candidates.values()]
        .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
        .slice(0, MAX_GRAPH_NODES - visited.size);
      for (const state of next) visited.set(state.nodeId, state);
      frontier = next;
    }

    const states = [...visited.values()].filter(({ nodeId }) => !seedNodeIds.has(nodeId));
    if (!states.length) return [];
    const stateByNode = new Map(states.map((state) => [state.nodeId, state]));
    const nodeIds = states.map(({ nodeId }) => nodeId);
    const placeholders = nodeIds.map(() => '?').join(',');
    const nodes = database.prepare(`SELECT id, entity_type, source_id FROM knowledge_graph_nodes WHERE id IN (${placeholders})`)
      .all(...nodeIds) as Array<{ id: string; entity_type: string; source_id: string }>;
    const allowedSources = options.sources?.length ? new Set(options.sources) : null;
    const getDocument = database.prepare(`SELECT source, source_id, title, body, created_at, conversation_id, work_item_id, actor
      FROM memory_documents
      WHERE source = ? AND source_id = ?
        AND (? IS NULL OR work_item_id IN (SELECT id FROM work_items WHERE project_key = ? AND deleted_at IS NULL))
        AND (? IS NULL OR conversation_id = ?)
        AND (? IS NULL OR work_item_id = ?)`);
    const documentsForNode = (node: { id: string; entity_type: string; source_id: string }) => {
      const sourceIds: Array<[string, string]> = node.entity_type === 'agent_run'
        ? [
            ['run_instructions', `${node.source_id}:instructions`],
            ['run_output', `${node.source_id}:output`],
            ['run_error', `${node.source_id}:error`],
          ]
        : node.entity_type === 'message' || node.entity_type === 'conversation' || node.entity_type === 'activity'
          || node.entity_type === 'work_item' || node.entity_type === 'audit' || node.entity_type === 'artifact'
          ? [[node.entity_type, node.source_id]]
          : [];
      return sourceIds
        .filter(([source]) => !allowedSources || allowedSources.has(source))
        .flatMap(([source, sourceId]) => {
          const row = getDocument.get(
            source, sourceId,
            options.projectKey ?? null, options.projectKey ?? null,
            options.conversationId ?? null, options.conversationId ?? null,
            options.workItemId ?? null, options.workItemId ?? null,
          ) as {
            source: string; source_id: string; title: string; body: string; created_at: string;
            conversation_id: string | null; work_item_id: string | null; actor: string | null;
          } | undefined;
          return row ? [{ node_id: node.id, ...row }] : [];
        });
    };
    // Resolve at most 120 graph nodes through the indexed (source, source_id)
    // memory key. A single OR-heavy join made SQLite scan the full memory table
    // and added seconds to every graph-assisted turn on a mature database.
    const rows = nodes.flatMap(documentsForNode);

    return rows.map((row) => {
      const state = stateByNode.get(row.node_id)!;
      return {
        source: row.source,
        sourceId: row.source_id,
        title: row.title,
        snippet: row.body.slice(0, 1_200),
        createdAt: row.created_at,
        conversationId: row.conversation_id,
        workItemId: row.work_item_id,
        actor: row.actor,
        score: state.score,
        retrievalPath: state.retrievalPath,
      };
    }).sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt)).slice(0, limit);
  } catch (error) {
    console.error('[knowledge-graph] expansion unavailable; using hybrid retrieval only', error);
    return [];
  }
}
