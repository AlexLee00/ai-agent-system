import { getNeighbors, type GraphEdge } from './intelligent-library.js';
import { collectLibraryRecords, type LibraryRecord } from './library-data-source.js';
import { createTeamMemory } from './team-memory-adapter.js';

export interface HydePlan {
  query: string;
  hypotheticalDocument: string;
  enabled: boolean;
  providerCallRequired: false;
}

export interface MultiHopPlan {
  query: string;
  seedEntity: string;
  hops: number;
  traversal: string[];
  collections: string[];
  enabled: boolean;
}

export interface SelfRagAssessment {
  retrievalNeeded: boolean;
  contextPrecision: 'high' | 'medium' | 'low';
  faithfulnessRisk: 'low' | 'medium' | 'high';
  answerPolicy: 'answer' | 'retrieve_more' | 'abstain';
  reasons: string[];
}

export interface SelfRagEvidence {
  source: 'record' | 'graph' | 'memory';
  id: string;
  team?: string;
  text: string;
  score: number;
}

export interface SelfRagPipelineResult {
  ok: boolean;
  query: string;
  policy: 'answer' | 'retrieve_more' | 'abstain';
  hyde: HydePlan;
  multiHop: MultiHopPlan | null;
  evidence: SelfRagEvidence[];
  assessment: SelfRagAssessment;
  warnings: string[];
}

const DEFAULT_COLLECTIONS = [
  'rag_operations',
  'rag_trades',
  'rag_tech',
  'rag_system_docs',
  'rag_reservations',
  'rag_market_data',
  'rag_schedule',
  'rag_work_docs',
  'rag_blog',
  'rag_research',
  'rag_experience',
  'rag_legal',
];

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').toLowerCase());
}

export function buildHydePlan(query: string, opts: { enabled?: boolean } = {}): HydePlan {
  const normalized = query.trim();
  return {
    query: normalized,
    hypotheticalDocument: [
      `This document answers: ${normalized}`,
      'It summarizes relevant team events, memory, lineage, graph neighbors, and prior reflexions.',
      'It includes enough concrete entities for vector retrieval without exposing private data.',
    ].join(' '),
    enabled: opts.enabled ?? boolEnv('SIGMA_HYDE_ENABLED'),
    providerCallRequired: false,
  };
}

export function buildMultiHopPlan(input: {
  query: string;
  seedEntity: string;
  edges: GraphEdge[];
  hops?: number;
  collections?: string[];
  enabled?: boolean;
}): MultiHopPlan {
  const hops = Math.max(1, Math.min(3, input.hops ?? 2));
  const traversal = getNeighbors(input.seedEntity, input.edges, hops);
  return {
    query: input.query,
    seedEntity: input.seedEntity.toLowerCase(),
    hops,
    traversal,
    collections: input.collections ?? DEFAULT_COLLECTIONS,
    enabled: input.enabled ?? boolEnv('SIGMA_MULTI_HOP_RAG_ENABLED'),
  };
}

export function assessSelfRag(input: {
  query: string;
  retrievedContexts: string[];
  answerDraft?: string;
  enabled?: boolean;
}): SelfRagAssessment {
  const enabled = input.enabled ?? boolEnv('SIGMA_SELF_RAG_ENABLED');
  const queryTerms = new Set(input.query.toLowerCase().split(/\s+/).filter(Boolean));
  const contextText = input.retrievedContexts.join(' ').toLowerCase();
  const matched = [...queryTerms].filter((term) => contextText.includes(term)).length;
  const precisionRatio = queryTerms.size === 0 ? 0 : matched / queryTerms.size;
  const contextPrecision = precisionRatio >= 0.7 ? 'high' : precisionRatio >= 0.35 ? 'medium' : 'low';
  const retrievalNeeded = enabled && (input.retrievedContexts.length === 0 || contextPrecision === 'low');
  const answerText = String(input.answerDraft ?? '').toLowerCase();
  const unsupportedAnswer = Boolean(answerText) && input.retrievedContexts.length > 0 && !input.retrievedContexts.some((ctx) => answerText.includes(ctx.slice(0, 20).toLowerCase()));
  const faithfulnessRisk = enabled && unsupportedAnswer ? 'high' : enabled && contextPrecision === 'low' ? 'medium' : 'low';
  const answerPolicy = retrievalNeeded ? 'retrieve_more' : faithfulnessRisk === 'high' ? 'abstain' : 'answer';

  return {
    retrievalNeeded,
    contextPrecision,
    faithfulnessRisk,
    answerPolicy,
    reasons: [
      enabled ? 'self_rag_enabled' : 'self_rag_disabled',
      `matched_terms:${matched}/${queryTerms.size}`,
      `contexts:${input.retrievedContexts.length}`,
      ...(unsupportedAnswer ? ['answer_draft_not_grounded'] : []),
    ],
  };
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9가-힣/.-]+/).filter((term) => term.length >= 2))];
}

function scoreText(text: string, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  const matched = terms.filter((term) => lower.includes(term)).length;
  return matched / terms.length;
}

export function buildSelfRagEvidenceBundle(input: {
  query: string;
  records?: readonly LibraryRecord[];
  graphEdges?: readonly GraphEdge[];
  memoryPrefix?: string;
  limit?: number;
}): SelfRagEvidence[] {
  const terms = queryTerms(input.query);
  const limit = Math.max(1, Math.min(20, input.limit ?? 8));
  const evidence: SelfRagEvidence[] = [];

  for (const record of input.records ?? []) {
    const score = scoreText(record.piiRedactedText, terms);
    if (score <= 0) continue;
    evidence.push({
      source: 'record',
      id: record.sourceId,
      team: record.team,
      text: record.piiRedactedText.slice(0, 800),
      score,
    });
  }

  for (const edge of input.graphEdges ?? []) {
    const graphText = `${edge.source} ${edge.relationship} ${edge.target}`;
    const score = scoreText(graphText, terms);
    if (score <= 0) continue;
    evidence.push({
      source: 'graph',
      id: `${edge.source}->${edge.target}:${edge.relationship}`,
      text: graphText,
      score: Math.max(score, edge.confidence * 0.5),
    });
  }

  if (input.memoryPrefix) {
    const score = scoreText(input.memoryPrefix, terms);
    if (score > 0) {
      evidence.push({
        source: 'memory',
        id: 'team-memory-prefix',
        text: input.memoryPrefix.slice(0, 1_200),
        score,
      });
    }
  }

  return evidence
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export async function runSelfRagPipeline(input: {
  query: string;
  team?: string;
  agent?: string;
  records?: readonly LibraryRecord[];
  graphEdges?: readonly GraphEdge[];
  includeMemory?: boolean;
  enabled?: boolean;
}): Promise<SelfRagPipelineResult> {
  const warnings: string[] = [];
  const records = input.records ?? (await collectLibraryRecords({ limitPerSource: 50 }).then((report) => {
    warnings.push(...report.warnings);
    return report.records;
  }));
  let memoryPrefix = '';
  if (input.includeMemory && input.team && input.agent) {
    try {
      const memory = createTeamMemory(input.team, input.agent);
      memoryPrefix = (await memory.getFullPrefix({ query: input.query, maxChars: 1_500 })).prefix;
    } catch (error) {
      warnings.push(`team_memory:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const hyde = buildHydePlan(input.query, { enabled: input.enabled });
  const graphEdges = input.graphEdges ?? [];
  const seedEntity = queryTerms(input.query)[0] ?? '';
  const multiHop = seedEntity
    ? buildMultiHopPlan({
      query: input.query,
      seedEntity,
      edges: graphEdges,
      enabled: input.enabled,
    })
    : null;
  const evidence = buildSelfRagEvidenceBundle({
    query: input.query,
    records,
    graphEdges,
    memoryPrefix,
  });
  const assessment = assessSelfRag({
    query: input.query,
    retrievedContexts: evidence.map((item) => item.text),
    enabled: input.enabled,
  });
  const policy = evidence.length === 0
    ? 'abstain'
    : assessment.answerPolicy === 'answer'
      ? 'answer'
      : assessment.answerPolicy;

  return {
    ok: policy !== 'abstain' || evidence.length === 0,
    query: input.query,
    policy,
    hyde,
    multiHop,
    evidence,
    assessment: {
      ...assessment,
      answerPolicy: policy,
      reasons: [
        ...assessment.reasons,
        `evidence:${evidence.length}`,
        ...(evidence.length === 0 ? ['no_evidence_abstain'] : []),
      ],
    },
    warnings,
  };
}
