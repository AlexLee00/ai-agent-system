import { getNeighbors, type GraphEdge } from './intelligent-library.js';

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
