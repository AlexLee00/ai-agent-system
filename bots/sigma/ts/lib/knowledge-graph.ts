import {
  buildKnowledgeGraphFromTexts,
  getBacklinks,
  getNeighbors,
  type GraphEdge,
  type GraphNode,
} from './intelligent-library.js';

export interface KnowledgeGraphSnapshot {
  ok: boolean;
  status: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  backlinks: Record<string, GraphEdge[]>;
  communities: Array<{ id: string; members: string[] }>;
}

export interface KnowledgeGraphPersistPlan {
  dryRun: boolean;
  rows: Array<{
    source_entity: string;
    target_entity: string;
    relationship_type: string;
    confidence: number;
    evidence_event_ids: number[];
  }>;
  ddl: string[];
}

export const ENTITY_RELATIONSHIPS_DDL = [
  `CREATE TABLE IF NOT EXISTS sigma.entity_relationships (
    id BIGSERIAL PRIMARY KEY,
    source_entity TEXT NOT NULL,
    target_entity TEXT NOT NULL,
    relationship_type TEXT NOT NULL,
    confidence NUMERIC(4,3) NOT NULL DEFAULT 0.650,
    evidence_event_ids BIGINT[] NOT NULL DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_entity, target_entity, relationship_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sigma_entity_rel_source
    ON sigma.entity_relationships (source_entity, confidence DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sigma_entity_rel_target
    ON sigma.entity_relationships (target_entity, confidence DESC)`,
];

export function buildKnowledgeGraphSnapshot(texts: string[]): KnowledgeGraphSnapshot {
  const graph = buildKnowledgeGraphFromTexts(texts);
  const backlinks: Record<string, GraphEdge[]> = {};
  for (const node of graph.nodes) {
    const links = getBacklinks(node.id, graph.edges);
    if (links.length > 0) backlinks[node.id] = links;
  }
  return {
    ok: true,
    status: 'knowledge_graph_snapshot_ready',
    nodes: graph.nodes,
    edges: graph.edges,
    backlinks,
    communities: findCommunities(graph.nodes, graph.edges),
  };
}

export function findCommunities(nodes: GraphNode[], edges: GraphEdge[]): Array<{ id: string; members: string[] }> {
  const remaining = new Set(nodes.map((node) => node.id));
  const communities: Array<{ id: string; members: string[] }> = [];
  while (remaining.size > 0) {
    const start = [...remaining][0];
    const members = [start, ...getNeighbors(start, edges, 2)]
      .filter((member, index, arr) => arr.indexOf(member) === index)
      .filter((member) => remaining.has(member));
    for (const member of members) remaining.delete(member);
    communities.push({ id: `community_${communities.length + 1}`, members: members.sort() });
  }
  return communities;
}

export function buildKnowledgeGraphPersistPlan(snapshot: KnowledgeGraphSnapshot, opts: { dryRun?: boolean } = {}): KnowledgeGraphPersistPlan {
  return {
    dryRun: opts.dryRun !== false,
    ddl: ENTITY_RELATIONSHIPS_DDL,
    rows: snapshot.edges.map((edge) => ({
      source_entity: edge.source,
      target_entity: edge.target,
      relationship_type: edge.relationship,
      confidence: edge.confidence,
      evidence_event_ids: edge.evidenceEventIds,
    })),
  };
}
