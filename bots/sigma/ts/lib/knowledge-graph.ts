import {
  buildKnowledgeGraphFromTexts,
  getBacklinks,
  getNeighbors,
  type GraphEdge,
  type GraphNode,
} from './intelligent-library.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const pgPool = require('../../../../packages/core/lib/pg-pool.js') as {
  run: (schema: string, sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;
  query: <T = unknown>(schema: string, sql: string, params?: unknown[]) => Promise<T[]>;
};

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
    metadata?: Record<string, unknown>;
  }>;
  ddl: string[];
}

export interface KnowledgeGraphPersistResult {
  ok: boolean;
  dryRun: boolean;
  insertedOrUpdated: number;
  skipped: number;
  warnings: string[];
}

export const ENTITY_RELATIONSHIPS_DDL = [
  `CREATE SCHEMA IF NOT EXISTS sigma`,
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
      metadata: { source: 'sigma_knowledge_graph' },
    })),
  };
}

export async function ensureKnowledgeGraphTables(): Promise<void> {
  for (const ddl of ENTITY_RELATIONSHIPS_DDL) {
    await pgPool.run('sigma', ddl);
  }
}

export async function persistKnowledgeGraphPlan(
  plan: KnowledgeGraphPersistPlan,
  opts: { confirm?: string } = {},
): Promise<KnowledgeGraphPersistResult> {
  if (plan.dryRun || opts.confirm !== 'sigma-knowledge-graph-apply') {
    return {
      ok: true,
      dryRun: true,
      insertedOrUpdated: 0,
      skipped: plan.rows.length,
      warnings: plan.dryRun ? [] : ['confirm_required:sigma-knowledge-graph-apply'],
    };
  }

  const warnings: string[] = [];
  await ensureKnowledgeGraphTables();
  let insertedOrUpdated = 0;
  for (const row of plan.rows) {
    try {
      const result = await pgPool.run('sigma', `
        INSERT INTO sigma.entity_relationships
          (source_entity, target_entity, relationship_type, confidence, evidence_event_ids, metadata)
        VALUES ($1, $2, $3, $4, $5::bigint[], $6::jsonb)
        ON CONFLICT (source_entity, target_entity, relationship_type) DO UPDATE
          SET confidence = GREATEST(sigma.entity_relationships.confidence, EXCLUDED.confidence),
              evidence_event_ids = (
                SELECT ARRAY(
                  SELECT DISTINCT unnest(sigma.entity_relationships.evidence_event_ids || EXCLUDED.evidence_event_ids)
                  ORDER BY 1
                )
              ),
              metadata = sigma.entity_relationships.metadata || EXCLUDED.metadata,
              updated_at = NOW()
      `, [
        row.source_entity,
        row.target_entity,
        row.relationship_type,
        row.confidence,
        row.evidence_event_ids,
        JSON.stringify(row.metadata ?? {}),
      ]);
      insertedOrUpdated += result.rowCount ?? 0;
    } catch (error) {
      warnings.push(`${row.source_entity}->${row.target_entity}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: warnings.length === 0,
    dryRun: false,
    insertedOrUpdated,
    skipped: plan.rows.length - insertedOrUpdated,
    warnings,
  };
}

export async function readEntityRelationships(entity: string, opts: { limit?: number } = {}): Promise<GraphEdge[]> {
  await ensureKnowledgeGraphTables();
  const limit = Math.max(1, Math.min(100, opts.limit ?? 25));
  type Row = {
    source_entity: string;
    target_entity: string;
    relationship_type: string;
    confidence: string | number;
    evidence_event_ids: number[];
  };
  const rows = await pgPool.query<Row>('sigma', `
    SELECT source_entity, target_entity, relationship_type, confidence, evidence_event_ids
      FROM sigma.entity_relationships
     WHERE source_entity = $1 OR target_entity = $1
     ORDER BY confidence DESC, updated_at DESC
     LIMIT $2
  `, [entity.toLowerCase(), limit]);
  return rows.map((row) => ({
    source: row.source_entity,
    target: row.target_entity,
    relationship: row.relationship_type,
    confidence: Number(row.confidence),
    evidenceEventIds: row.evidence_event_ids ?? [],
  }));
}
