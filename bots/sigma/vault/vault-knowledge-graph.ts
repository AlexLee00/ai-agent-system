import { KNOWLEDGE_TYPES, resolveVaultTier } from './vault-tiering.js';

export type VaultKnowledgeNodeType = 'team_agent' | 'record' | 'topic_theme' | 'entity';

export interface VaultKnowledgeNode {
  id: string;
  type: VaultKnowledgeNodeType;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface VaultKnowledgeEdge {
  source: string;
  target: string;
  relationship: 'belongs_to' | 'produced_by' | 'member_of' | 'about' | 'mentions';
  confidence: number;
  evidence: 'meta' | 'tag' | 'source_ref';
}

export interface VaultGraphEntry {
  id: string | number;
  title?: string;
  type?: string;
  source?: string;
  tags?: string[] | string | null;
  meta?: Record<string, unknown> | string | null;
  created_at?: string | Date;
}

export interface VaultGraphRecord {
  id: string;
  nodeId: string;
  title: string;
  type: string;
  team: string | null;
  agent: string | null;
}

export interface VaultKnowledgeGraph {
  nodes: VaultKnowledgeNode[];
  edges: VaultKnowledgeEdge[];
  records: VaultGraphRecord[];
  nodeCounts: Record<VaultKnowledgeNodeType, number>;
}

export interface VaultGraphRelatedRecord {
  record: VaultGraphRecord;
  hop: number;
  confidence: number;
}

type ReportOptions = {
  env?: Record<string, string | undefined>;
  entity?: string;
  limit?: number;
  queryReadonly?: (schema: string, sql: string, params?: unknown[]) => Promise<VaultGraphEntry[]>;
};

const REPORT_ENV = 'SIGMA_VAULT_KNOWLEDGE_GRAPH_REPORT_ENABLED';
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 5000;
const IGNORED_TAGS = new Set(['sigma-library', 'sigma-vault', 'knowledge', 'library']);
const TOPIC_PREFIXES = new Set(['action', 'category', 'genre', 'stage', 'status', 'theme', 'topic']);

function parseMeta(value: VaultGraphEntry['meta']): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseTags(value: VaultGraphEntry['tags']): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  if (value.startsWith('{') && value.endsWith('}')) {
    return value.slice(1, -1).split(',').map((tag) => tag.replace(/^"|"$/g, ''));
  }
  return value.split(',');
}

function slug(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return null;
}

function stringValues(...values: unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const normalized = String(candidate || '').trim();
      if (normalized) output.push(normalized);
    }
  }
  return output;
}

function addNode(nodes: Map<string, VaultKnowledgeNode>, node: VaultKnowledgeNode): void {
  if (!nodes.has(node.id)) nodes.set(node.id, node);
}

function addEdge(edges: Map<string, VaultKnowledgeEdge>, edge: VaultKnowledgeEdge): void {
  const key = `${edge.source}|${edge.relationship}|${edge.target}`;
  const existing = edges.get(key);
  if (!existing || edge.confidence > existing.confidence) edges.set(key, edge);
}

function addTopic(
  nodes: Map<string, VaultKnowledgeNode>,
  edges: Map<string, VaultKnowledgeEdge>,
  recordNodeId: string,
  label: string,
  evidence: 'meta' | 'tag',
): void {
  const key = slug(label);
  if (!key) return;
  const id = `topic:${key}`;
  addNode(nodes, { id, type: 'topic_theme', label });
  addEdge(edges, { source: recordNodeId, target: id, relationship: 'about', confidence: evidence === 'meta' ? 0.9 : 0.8, evidence });
}

function addEntity(
  nodes: Map<string, VaultKnowledgeNode>,
  edges: Map<string, VaultKnowledgeEdge>,
  recordNodeId: string,
  label: string,
  evidence: 'meta' | 'tag' | 'source_ref',
): void {
  const key = slug(label);
  if (!key) return;
  const id = `entity:${key}`;
  addNode(nodes, { id, type: 'entity', label });
  const confidence = evidence === 'meta' ? 0.9 : evidence === 'source_ref' ? 0.75 : 0.8;
  addEdge(edges, { source: recordNodeId, target: id, relationship: 'mentions', confidence, evidence });
}

function extractTagRelations(
  entry: VaultGraphEntry,
  team: string | null,
  nodes: Map<string, VaultKnowledgeNode>,
  edges: Map<string, VaultKnowledgeEdge>,
  recordNodeId: string,
): void {
  const ignored = new Set([slug(team), slug(entry.source), slug(entry.type)]);
  for (const rawTag of parseTags(entry.tags)) {
    const tag = rawTag.trim();
    const tagKey = slug(tag);
    if (!tagKey || IGNORED_TAGS.has(tagKey) || ignored.has(tagKey)) continue;
    const separator = tag.indexOf(':');
    if (separator > 0) {
      const prefix = tag.slice(0, separator).trim().toLowerCase();
      const value = tag.slice(separator + 1).trim();
      if (!value || prefix === 'success' || prefix === 'team' || prefix === 'agent') continue;
      if (prefix === 'entity' || prefix === 'source') addEntity(nodes, edges, recordNodeId, value, 'tag');
      else if (TOPIC_PREFIXES.has(prefix)) addTopic(nodes, edges, recordNodeId, value, 'tag');
      continue;
    }
    addTopic(nodes, edges, recordNodeId, tag, 'tag');
  }
}

export function buildVaultKnowledgeGraph(entries: VaultGraphEntry[]): VaultKnowledgeGraph {
  const nodes = new Map<string, VaultKnowledgeNode>();
  const edges = new Map<string, VaultKnowledgeEdge>();
  const records: VaultGraphRecord[] = [];

  for (const entry of entries) {
    const recordId = String(entry.id || '').trim();
    if (!recordId) continue;
    const meta = parseMeta(entry.meta);
    const sourceRefs = [
      ...(meta.source_ref && typeof meta.source_ref === 'object' ? [meta.source_ref] : []),
      ...(Array.isArray(meta.source_refs) ? meta.source_refs.filter((ref) => ref && typeof ref === 'object') : []),
    ];
    const sourceRef = sourceRefs[0] || {};
    const team = firstString(meta.team, sourceRef.team, entry.source);
    const agent = firstString(meta.agent);
    const recordNodeId = `record:${slug(recordId)}`;
    if (recordNodeId === 'record:') continue;

    const record: VaultGraphRecord = {
      id: recordId,
      nodeId: recordNodeId,
      title: String(entry.title || recordId),
      type: String(entry.type || 'unknown'),
      team,
      agent,
    };
    records.push(record);
    addNode(nodes, {
      id: recordNodeId,
      type: 'record',
      label: record.title,
      metadata: { recordId, recordType: record.type, team, agent },
    });

    let teamNodeId: string | null = null;
    if (team) {
      teamNodeId = `team:${slug(team)}`;
      addNode(nodes, { id: teamNodeId, type: 'team_agent', label: team, metadata: { kind: 'team' } });
      addEdge(edges, { source: recordNodeId, target: teamNodeId, relationship: 'belongs_to', confidence: 0.95, evidence: 'meta' });
    }
    if (agent) {
      const agentNodeId = `agent:${slug(team || 'unknown')}:${slug(agent)}`;
      addNode(nodes, { id: agentNodeId, type: 'team_agent', label: agent, metadata: { kind: 'agent', team } });
      addEdge(edges, { source: recordNodeId, target: agentNodeId, relationship: 'produced_by', confidence: 0.95, evidence: 'meta' });
      if (teamNodeId) addEdge(edges, { source: agentNodeId, target: teamNodeId, relationship: 'member_of', confidence: 0.95, evidence: 'meta' });
    }

    extractTagRelations(entry, team, nodes, edges, recordNodeId);
    for (const topic of stringValues(meta.topic, meta.topics, meta.theme, meta.themes, meta.category, meta.genre, meta.actionType)) {
      addTopic(nodes, edges, recordNodeId, topic, 'meta');
    }
    for (const entity of stringValues(meta.entity, meta.entities, meta.subject, meta.subjects, meta.technologies)) {
      addEntity(nodes, edges, recordNodeId, entity, 'meta');
    }
    for (const sourceTable of new Set(stringValues(sourceRefs.map((ref) => ref.table), meta.sourceTable))) {
      addEntity(nodes, edges, recordNodeId, sourceTable, 'source_ref');
    }
  }

  const graphNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const graphEdges = [...edges.values()].sort((left, right) => (
    left.source.localeCompare(right.source) || left.target.localeCompare(right.target)
  ));
  const nodeCounts: Record<VaultKnowledgeNodeType, number> = {
    team_agent: 0,
    record: 0,
    topic_theme: 0,
    entity: 0,
  };
  for (const node of graphNodes) nodeCounts[node.type] += 1;
  return { nodes: graphNodes, edges: graphEdges, records, nodeCounts };
}

export function queryRecordsByEntity(
  graph: VaultKnowledgeGraph,
  entity: string,
  limit = 50,
): VaultGraphRecord[] {
  const entityKey = slug(entity);
  if (!entityKey) return [];
  const matchingNodeIds = new Set(graph.nodes
    .filter((node) => node.type === 'entity' && (node.id === `entity:${entityKey}` || slug(node.label) === entityKey))
    .map((node) => node.id));
  if (matchingNodeIds.size === 0) return [];
  const recordNodeIds = new Set(graph.edges
    .filter((edge) => edge.relationship === 'mentions' && matchingNodeIds.has(edge.target))
    .map((edge) => edge.source));
  return graph.records
    .filter((record) => recordNodeIds.has(record.nodeId))
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(200, limit)));
}

export function queryRelatedRecords(
  graph: VaultKnowledgeGraph,
  query: string,
  maxHops = 2,
  limit = 5,
): { matchedNodes: VaultKnowledgeNode[]; records: VaultGraphRelatedRecord[] } {
  const queryKey = slug(query);
  if (!queryKey) return { matchedNodes: [], records: [] };

  const matchedNodes = graph.nodes.filter((node) => {
    if (node.type === 'record') return false;
    const labelKey = slug(node.label);
    return labelKey.length >= 2 && queryKey.includes(labelKey);
  });
  if (matchedNodes.length === 0) return { matchedNodes: [], records: [] };

  const adjacency = new Map<string, Array<{ nodeId: string; confidence: number }>>();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, []);
    adjacency.get(edge.source)?.push({ nodeId: edge.target, confidence: edge.confidence });
    adjacency.get(edge.target)?.push({ nodeId: edge.source, confidence: edge.confidence });
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const recordByNodeId = new Map(graph.records.map((record) => [record.nodeId, record]));
  const seenConcepts = new Set(matchedNodes.map((node) => node.id));
  const related = new Map<string, VaultGraphRelatedRecord>();
  let frontier = new Map([...seenConcepts].map((nodeId) => [nodeId, 1]));
  const safeMaxHops = Math.max(1, Math.min(2, Math.floor(Number(maxHops) || 1)));

  for (let hop = 1; hop <= safeMaxHops && frontier.size > 0; hop += 1) {
    const recordNodes = new Map<string, number>();
    for (const [conceptNode, pathConfidence] of frontier) {
      for (const edge of adjacency.get(conceptNode) || []) {
        if (!recordByNodeId.has(edge.nodeId)) continue;
        const confidence = pathConfidence * edge.confidence;
        recordNodes.set(edge.nodeId, Math.max(recordNodes.get(edge.nodeId) || 0, confidence));
      }
    }
    for (const [recordNode, confidence] of recordNodes) {
      const record = recordByNodeId.get(recordNode);
      const existing = record ? related.get(record.id) : null;
      if (record && (!existing || hop < existing.hop || (hop === existing.hop && confidence > existing.confidence))) {
        related.set(record.id, { record, hop, confidence: Number(confidence.toFixed(4)) });
      }
    }

    const nextFrontier = new Map<string, number>();
    for (const [recordNode, pathConfidence] of recordNodes) {
      for (const edge of adjacency.get(recordNode) || []) {
        const node = nodeById.get(edge.nodeId);
        if (!node || !['entity', 'topic_theme'].includes(node.type) || seenConcepts.has(node.id)) continue;
        const confidence = pathConfidence * edge.confidence;
        nextFrontier.set(node.id, Math.max(nextFrontier.get(node.id) || 0, confidence));
      }
    }
    for (const nodeId of nextFrontier.keys()) seenConcepts.add(nodeId);
    frontier = nextFrontier;
  }

  const safeLimit = Math.max(1, Math.min(5, Math.floor(Number(limit) || 5)));
  return {
    matchedNodes,
    records: [...related.values()]
      .sort((left, right) => left.hop - right.hop
        || right.confidence - left.confidence
        || left.record.title.localeCompare(right.record.title)
        || left.record.id.localeCompare(right.record.id))
      .slice(0, safeLimit),
  };
}

export function isVaultKnowledgeGraphReportEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return String(env[REPORT_ENV] || '').trim().toLowerCase() === 'true';
}

export async function fetchVaultKnowledgeGraphReport(options: ReportOptions = {}) {
  const env = options.env || process.env;
  const safety = {
    reportOnly: true,
    writes: false,
    ddlRequired: false,
    envGate: `${REPORT_ENV}=true`,
    relationExtraction: 'tags_meta_rules_only',
    llmCalls: 0,
  };
  if (!isVaultKnowledgeGraphReportEnabled(env)) {
    return {
      enabled: false,
      skipped: true,
      reason: `${REPORT_ENV}_not_true`,
      mode: 'report_only',
      graph: null,
      query: null,
      safety,
    };
  }
  if (typeof options.queryReadonly !== 'function') throw new Error('queryReadonly_required');

  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(Number(options.limit) || DEFAULT_LIMIT)));
  const knowledgeTypes = [...KNOWLEDGE_TYPES];
  const rows = await options.queryReadonly('sigma', `
    SELECT id::text, title, type, source, tags, meta, created_at
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'captured') <> 'archived'
      AND (meta->>'merged_into') IS NULL
      AND (
        type = ANY($1::text[])
        OR LOWER(COALESCE(meta->>'vaultTier', meta->>'vault_tier', '')) = 'knowledge'
      )
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `, [knowledgeTypes, limit]);
  const knowledgeRows = rows.filter((row) => resolveVaultTier(row).tier === 'knowledge');
  const graph = buildVaultKnowledgeGraph(knowledgeRows);
  const entityRecords = options.entity ? queryRecordsByEntity(graph, options.entity) : [];

  return {
    enabled: true,
    skipped: false,
    mode: 'report_only',
    generatedAt: new Date().toISOString(),
    selectedRecords: knowledgeRows.length,
    graph: {
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      nodeCounts: graph.nodeCounts,
    },
    query: options.entity ? { entity: options.entity, records: entityRecords } : null,
    safety,
  };
}

export default {
  buildVaultKnowledgeGraph,
  fetchVaultKnowledgeGraphReport,
  isVaultKnowledgeGraphReportEnabled,
  queryRelatedRecords,
  queryRecordsByEntity,
};
