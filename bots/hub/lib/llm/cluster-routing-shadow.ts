'use strict';

const { createHash } = require('node:crypto');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const rag = require('../../../../packages/core/lib/rag');

type ClusterRoutingInput = {
  prompt?: string;
  systemPrompt?: string;
  abstractModel?: string;
  taskType?: string;
  agent?: string;
  callerTeam?: string;
};

type HistoryRow = {
  routing_signals?: Record<string, any> | string | null;
  manual_model?: string | null;
  auto_model?: string | null;
  success?: boolean | null;
  latency_ms?: number | string | null;
  cost_usd?: number | string | null;
};

type ClusterRoutingDeps = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  embedText?: (text: string) => Promise<number[] | null>;
  loadHistory?: (limit: number, signatureKey: string) => Promise<HistoryRow[]>;
  embeddingModel?: string;
};

type HistoryQuery = (schema: string, sql: string, params: unknown[]) => Promise<HistoryRow[]>;

type ClusterRoutingHistoryDeps = {
  queryReadonly?: HistoryQuery;
  queryDefault?: HistoryQuery;
  warn?: (message: string) => void;
};

type ClusterRoutingUnavailableFamily =
  | 'embedding'
  | 'history_permission'
  | 'history_connection'
  | 'history_query'
  | 'history_unknown'
  | 'processing';

export type ClusterRoutingRecommendation = {
  version: 'v1';
  cluster_id: string;
  cluster_count: number;
  sample_count: number;
  recommended_model: string | null;
  model_sample_count: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  avg_cost_usd: number | null;
  reason:
    | 'recommended'
    | 'insufficient_samples'
    | `recommendation_unavailable:${ClusterRoutingUnavailableFamily}`;
  embedding_model: string;
  embedding_dimensions: number;
  signature_dimensions: number;
  signature_key: string;
  embedding_signature: number[];
  cluster_algorithm_version: 'kmeans-v1';
  centroid_hash: string | null;
};

const DEFAULT_HISTORY_LIMIT = 500;
const DEFAULT_MIN_SAMPLES = 3;
const MAX_CLUSTERS = 4;
const SIGNATURE_DIMENSIONS = 24;
const SIGNATURE_VERSION = 'v1';
const CLUSTER_ALGORITHM_VERSION = 'kmeans-v1';
const HISTORY_SQL = `
    SELECT
      routing_signals,
      success,
      latency_ms,
      cost_usd
    FROM hub.llm_auto_routing_log
    WHERE mode = 'shadow'
      AND success IS NOT NULL
      AND routing_signals #> '{cluster_recommendation,embedding_signature}' IS NOT NULL
      AND routing_signals #>> '{cluster_recommendation,signature_key}' = $2
      AND NULLIF(routing_signals ->> 'routing_request_id', '') IS NOT NULL
      AND NULLIF(routing_signals #>> '{execution,model}', '') IS NOT NULL
    ORDER BY created_at DESC
    LIMIT $1
  `;
let permissionFallbackWarned = false;

function enabled(env: Record<string, any>): boolean {
  return /^(1|true|yes|on|shadow)$/i.test(String(env.LLM_CLUSTER_ROUTING_SHADOW_ENABLED || '').trim());
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function isClusterRoutingEligible(input: ClusterRoutingInput): boolean {
  const team = String(input.callerTeam || '').trim().toLowerCase();
  const agent = String(input.agent || '').trim().toLowerCase();
  if (team === 'investment' || team === 'luna') return false;
  return !/(^|[._-])luna($|[._-])/.test(agent);
}

function normalize(vector: number[]): number[] | null {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) return null;
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return null;
  return vector.map((value) => value / norm);
}

function buildCentroidHash(vector: number[]): string | null {
  const normalized = normalize(vector);
  if (!normalized) return null;
  const payload = normalized.map((value) => value.toFixed(6)).join(',');
  return createHash('sha256')
    .update(`${CLUSTER_ALGORITHM_VERSION}:${payload}`)
    .digest('hex')
    .slice(0, 16);
}

export function buildEmbeddingSignature(vector: number[], dimensions = SIGNATURE_DIMENSIONS): number[] | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const targetDimensions = Math.min(dimensions, vector.length);
  const sums = new Array(targetDimensions).fill(0);
  const counts = new Array(targetDimensions).fill(0);
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(vector[index]);
    if (!Number.isFinite(value)) return null;
    const bucket = Math.min(targetDimensions - 1, Math.floor(index * targetDimensions / vector.length));
    sums[bucket] += value;
    counts[bucket] += 1;
  }
  const normalized = normalize(sums.map((sum, index) => sum / Math.max(1, counts[index])));
  return normalized?.map((value) => Number(value.toFixed(6))) || null;
}

export function buildEmbeddingSignatureKey(
  embeddingModel: string,
  embeddingDimensions: number,
  signatureDimensions: number,
): string {
  return `${SIGNATURE_VERSION}:${embeddingModel}:${embeddingDimensions}:${signatureDimensions}`;
}

function distance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    sum += delta * delta;
  }
  return sum;
}

function nearestCentroid(point: number[], centroids: number[][]): number {
  let nearest = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  centroids.forEach((centroid, index) => {
    const nextDistance = distance(point, centroid);
    if (nextDistance < nearestDistance) {
      nearest = index;
      nearestDistance = nextDistance;
    }
  });
  return nearest;
}

function clusterPoints(points: number[][]): { assignments: number[]; centroids: number[][] } {
  const clusterCount = Math.min(MAX_CLUSTERS, Math.max(1, Math.floor(Math.sqrt(points.length))));
  const centroids: number[][] = [points[0].slice()];
  while (centroids.length < clusterCount) {
    let candidate = points[0];
    let candidateDistance = -1;
    for (const point of points) {
      const minDistance = Math.min(...centroids.map((centroid) => distance(point, centroid)));
      if (minDistance > candidateDistance) {
        candidate = point;
        candidateDistance = minDistance;
      }
    }
    centroids.push(candidate.slice());
  }

  let assignments = points.map((point) => nearestCentroid(point, centroids));
  for (let iteration = 0; iteration < 6; iteration += 1) {
    for (let cluster = 0; cluster < centroids.length; cluster += 1) {
      const members = points.filter((_point, index) => assignments[index] === cluster);
      if (members.length === 0) continue;
      const mean = centroids[cluster].map((_value, dimension) => (
        members.reduce((sum, point) => sum + point[dimension], 0) / members.length
      ));
      centroids[cluster] = normalize(mean) || centroids[cluster];
    }
    const nextAssignments = points.map((point) => nearestCentroid(point, centroids));
    if (nextAssignments.every((assignment, index) => assignment === assignments[index])) break;
    assignments = nextAssignments;
  }
  return { assignments, centroids };
}

function readSignals(row: HistoryRow): Record<string, any> | null {
  const signals = row.routing_signals;
  let parsedSignals: Record<string, any> | null = null;
  if (typeof signals === 'string') {
    try {
      const parsed = JSON.parse(signals);
      parsedSignals = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  } else if (signals && typeof signals === 'object') {
    parsedSignals = signals;
  }
  return parsedSignals;
}

function readSignature(row: HistoryRow, dimensions: number, signatureKey: string): number[] | null {
  const parsedSignals = readSignals(row);
  const recommendation = parsedSignals?.cluster_recommendation;
  if (String(recommendation?.signature_key || '') !== signatureKey) return null;
  const raw = recommendation?.embedding_signature;
  if (!Array.isArray(raw) || raw.length !== dimensions) return null;
  return normalize(raw.map(Number));
}

function readExecutedModel(row: HistoryRow): string | null {
  const signals = readSignals(row);
  if (!String(signals?.routing_request_id || '').trim()) return null;
  const model = String(signals?.execution?.model || '').trim();
  return model || null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recommendModel(rows: HistoryRow[], minSamples: number) {
  const byModel = new Map<string, { total: number; successes: number; latencies: number[]; costs: number[] }>();
  for (const row of rows) {
    const model = readExecutedModel(row);
    if (!model || typeof row.success !== 'boolean') continue;
    const current = byModel.get(model) || { total: 0, successes: 0, latencies: [], costs: [] };
    current.total += 1;
    if (row.success) current.successes += 1;
    const latency = finiteNumber(row.latency_ms);
    const cost = finiteNumber(row.cost_usd);
    if (latency != null) current.latencies.push(latency);
    if (cost != null) current.costs.push(cost);
    byModel.set(model, current);
  }

  const candidates = [...byModel.entries()]
    .map(([model, stats]) => ({
      model,
      total: stats.total,
      successRate: stats.total ? stats.successes / stats.total : 0,
      avgLatencyMs: average(stats.latencies),
      avgCostUsd: average(stats.costs),
    }))
    .filter((entry) => entry.total >= minSamples && entry.successRate > 0)
    .sort((left, right) => (
      right.successRate - left.successRate
      || (left.avgLatencyMs ?? Number.POSITIVE_INFINITY) - (right.avgLatencyMs ?? Number.POSITIVE_INFINITY)
      || (left.avgCostUsd ?? Number.POSITIVE_INFINITY) - (right.avgCostUsd ?? Number.POSITIVE_INFINITY)
      || left.model.localeCompare(right.model)
    ));
  return candidates[0] || null;
}

async function embedText(text: string): Promise<number[] | null> {
  const embeddings = await rag.createEmbeddingBatch([text]);
  const embedding = embeddings?.[0];
  return Array.isArray(embedding) ? embedding : null;
}

async function queryDefaultHistory(schema: string, sql: string, params: unknown[]): Promise<HistoryRow[]> {
  const result = await pgPool.getPool(schema).query(sql, params);
  return result.rows;
}

export async function loadClusterRoutingHistory(
  limit: number,
  signatureKey: string,
  deps: ClusterRoutingHistoryDeps = {},
): Promise<HistoryRow[]> {
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  const queryDefault = deps.queryDefault || queryDefaultHistory;
  const args: [string, string, unknown[]] = ['public', HISTORY_SQL, [limit, signatureKey]];
  try {
    return await queryReadonly(...args);
  } catch (error: any) {
    if (String(error?.code || '') !== '42501') throw error;
    if (deps.warn) {
      deps.warn('cluster_routing_history:readonly_permission_fallback');
    } else if (!permissionFallbackWarned) {
      console.warn('cluster_routing_history:readonly_permission_fallback');
      permissionFallbackWarned = true;
    }
    return queryDefault(...args);
  }
}

function classifyHistoryError(error: any): ClusterRoutingUnavailableFamily {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  if (code === '42501') return 'history_permission';
  if (
    code.startsWith('08')
    || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', '57P01'].includes(code)
    || /connection (terminated|destroyed|refused)|server closed the connection/.test(message)
  ) return 'history_connection';
  if (/^[A-Z0-9]{5}$/.test(code)) return 'history_query';
  return 'history_unknown';
}

export async function buildClusterRoutingRecommendation(
  input: ClusterRoutingInput,
  deps: ClusterRoutingDeps = {},
): Promise<ClusterRoutingRecommendation | null> {
  const env = deps.env || process.env;
  if (!enabled(env) || !isClusterRoutingEligible(input)) return null;

  const embeddingModel = String(deps.embeddingModel || rag.EMBED_MODEL || 'qwen3-embed-0.6b');
  let evidence = {
    version: SIGNATURE_VERSION,
    embedding_model: embeddingModel,
    embedding_dimensions: 0,
    signature_dimensions: 0,
    signature_key: buildEmbeddingSignatureKey(embeddingModel, 0, 0),
    embedding_signature: [] as number[],
  } as const;
  const unavailable = (family: ClusterRoutingUnavailableFamily): ClusterRoutingRecommendation => ({
    ...evidence,
    cluster_algorithm_version: CLUSTER_ALGORITHM_VERSION,
    centroid_hash: null,
    cluster_id: 'unavailable',
    cluster_count: 0,
    sample_count: 0,
    recommended_model: null,
    model_sample_count: 0,
    success_rate: null,
    avg_latency_ms: null,
    avg_cost_usd: null,
    reason: `recommendation_unavailable:${family}`,
  });

  try {
    const text = `${String(input.systemPrompt || '')}\n${String(input.prompt || '')}`.trim().slice(0, 8000);
    if (!text) return null;
    let embedding: number[] | null;
    try {
      embedding = await (deps.embedText || embedText)(text);
    } catch {
      return unavailable('embedding');
    }
    if (!embedding) return unavailable('embedding');
    const signature = buildEmbeddingSignature(embedding);
    if (!signature) return unavailable('embedding');
    const signatureKey = buildEmbeddingSignatureKey(embeddingModel, embedding.length, signature.length);
    evidence = {
      version: SIGNATURE_VERSION,
      embedding_model: embeddingModel,
      embedding_dimensions: embedding.length,
      signature_dimensions: signature.length,
      signature_key: signatureKey,
      embedding_signature: signature,
    } as const;

    const historyLimit = boundedInt(env.LLM_CLUSTER_ROUTING_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, 10, 2000);
    const minSamples = boundedInt(env.LLM_CLUSTER_ROUTING_MIN_SAMPLES, DEFAULT_MIN_SAMPLES, 1, 100);
    let rawHistory: HistoryRow[];
    try {
      rawHistory = await (deps.loadHistory || loadClusterRoutingHistory)(historyLimit, signatureKey);
    } catch (error) {
      return unavailable(classifyHistoryError(error));
    }

    try {
      const history = rawHistory
        .map((row) => ({ row, signature: readSignature(row, signature.length, signatureKey), model: readExecutedModel(row) }))
        .filter((entry): entry is { row: HistoryRow; signature: number[]; model: string } => Boolean(entry.signature && entry.model));
      const points = [signature, ...history.map((entry) => entry.signature)];
      const clustered = clusterPoints(points);
      const currentCluster = clustered.assignments[0];
      const clusterRows = history
        .filter((_entry, index) => clustered.assignments[index + 1] === currentCluster)
        .map((entry) => entry.row);
      const recommendation = recommendModel(clusterRows, minSamples);

      return {
        ...evidence,
        cluster_algorithm_version: CLUSTER_ALGORITHM_VERSION,
        centroid_hash: buildCentroidHash(clustered.centroids[currentCluster]),
        cluster_id: `cluster-${currentCluster + 1}-of-${clustered.centroids.length}`,
        cluster_count: clustered.centroids.length,
        sample_count: clusterRows.length,
        recommended_model: recommendation?.model || null,
        model_sample_count: recommendation?.total || 0,
        success_rate: recommendation ? Number(recommendation.successRate.toFixed(4)) : null,
        avg_latency_ms: recommendation?.avgLatencyMs == null ? null : Math.round(recommendation.avgLatencyMs),
        avg_cost_usd: recommendation?.avgCostUsd == null ? null : Number(recommendation.avgCostUsd.toFixed(6)),
        reason: recommendation ? 'recommended' : 'insufficient_samples',
      };
    } catch {
      return unavailable('processing');
    }
  } catch {
    return unavailable('processing');
  }
}

module.exports = {
  buildClusterRoutingRecommendation,
  buildCentroidHash,
  buildEmbeddingSignature,
  buildEmbeddingSignatureKey,
  isClusterRoutingEligible,
  loadClusterRoutingHistory,
};
