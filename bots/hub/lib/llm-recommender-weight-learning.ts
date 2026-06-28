import * as pgPool from '../../../packages/core/lib/pg-pool';

export const LLM_RECOMMENDER_WEIGHT_CATEGORIES = ['length', 'budget', 'failure', 'urgency', 'task_type', 'accuracy'] as const;
export type LlmRecommenderWeightCategory = typeof LLM_RECOMMENDER_WEIGHT_CATEGORIES[number];

export type LlmRecommenderWeights = Record<LlmRecommenderWeightCategory, number>;

export type LlmRoutingLearningMetric = {
  selectorKey: string;
  runtimePurpose: string;
  abstractModel: string;
  providerTier: string;
  sample: number;
  successRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  avgEffectiveCostUsd: number;
  avgPromptChars: number;
  fallbackRate: number;
  errorRate: number;
  budgetGuardRate: number;
  compositeScore: number;
};

export type LlmRecommenderWeightLearningReport = {
  ok: boolean;
  status: 'insufficient_feedback_static_weights' | 'shadow_weight_feedback_ready';
  source: 'llm_recommender_weight_learning';
  shadowOnly: true;
  liveMutation: false;
  promotionReady: false;
  manualPromotionReviewCandidate: boolean;
  generatedAt: string;
  days: number;
  minSamples: number;
  baseWeights: LlmRecommenderWeights;
  weights: LlmRecommenderWeights;
  deltas: LlmRecommenderWeights;
  maxDelta: number;
  metrics: {
    totalRows: number;
    eligibleRows: number;
    contextsEvaluated: number;
    staticCompositeScore: number;
    shadowCompositeScore: number;
    rows: LlmRoutingLearningMetric[];
  };
  reasons: string[];
  blockers: string[];
};

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown[] | { rows?: unknown[] }> | unknown[] | { rows?: unknown[] };
type RunFn = (schema: string, sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;

const DEFAULT_WEIGHT = 1 / LLM_RECOMMENDER_WEIGHT_CATEGORIES.length;
const FLOOR_WEIGHT = 0.08;
const CEILING_WEIGHT = 0.48;
const DEFAULT_MAX_DELTA = 0.07;
const SUCCESS_FLOOR = 0.95;

export const DEFAULT_LLM_RECOMMENDER_WEIGHT_POLICY: LlmRecommenderWeights = Object.freeze(Object.fromEntries(
  LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [category, DEFAULT_WEIGHT]),
) as LlmRecommenderWeights);

function n(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: unknown, min = 0, max = 1, fallback = 0): number {
  return Math.max(min, Math.min(max, n(value, fallback)));
}

function round(value: unknown, digits = 6): number {
  return Number(n(value, 0).toFixed(digits));
}

function normalizeToken(value: unknown, fallback = 'unknown'): string {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

export function normalizeLlmRecommenderWeights(
  weights: Partial<Record<LlmRecommenderWeightCategory | string, unknown>> = {},
  fallback: LlmRecommenderWeights = DEFAULT_LLM_RECOMMENDER_WEIGHT_POLICY,
): LlmRecommenderWeights {
  let bounded = Object.fromEntries(LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [
    category,
    clamp(weights?.[category], FLOOR_WEIGHT, CEILING_WEIGHT, fallback[category]),
  ])) as LlmRecommenderWeights;

  for (let i = 0; i < 12; i += 1) {
    const total = LLM_RECOMMENDER_WEIGHT_CATEGORIES.reduce((sum, category) => sum + bounded[category], 0);
    const diff = 1 - total;
    if (Math.abs(diff) <= 0.000_001) break;

    if (diff > 0) {
      const adjustable = LLM_RECOMMENDER_WEIGHT_CATEGORIES
        .map((category) => ({ category, capacity: CEILING_WEIGHT - bounded[category] }))
        .filter((item) => item.capacity > 0);
      const capacityTotal = adjustable.reduce((sum, item) => sum + item.capacity, 0);
      if (capacityTotal <= 0) break;
      bounded = { ...bounded };
      for (const item of adjustable) {
        bounded[item.category] += Math.min(diff * (item.capacity / capacityTotal), item.capacity);
      }
    } else {
      const excess = Math.abs(diff);
      const adjustable = LLM_RECOMMENDER_WEIGHT_CATEGORIES
        .map((category) => ({ category, capacity: bounded[category] - FLOOR_WEIGHT }))
        .filter((item) => item.capacity > 0);
      const capacityTotal = adjustable.reduce((sum, item) => sum + item.capacity, 0);
      if (capacityTotal <= 0) break;
      bounded = { ...bounded };
      for (const item of adjustable) {
        bounded[item.category] -= Math.min(excess * (item.capacity / capacityTotal), item.capacity);
      }
    }
  }

  return Object.fromEntries(LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [category, round(bounded[category])])) as LlmRecommenderWeights;
}

function capDelta(delta: unknown, maxDelta: number): number {
  return clamp(delta, -Math.abs(maxDelta), Math.abs(maxDelta), 0);
}

export function applyLlmRecommenderWeightDeltas(
  baseWeights: LlmRecommenderWeights,
  deltas: Partial<Record<LlmRecommenderWeightCategory, unknown>>,
  maxDelta = DEFAULT_MAX_DELTA,
): LlmRecommenderWeights {
  const next = Object.fromEntries(LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [
    category,
    baseWeights[category] + capDelta(deltas[category] ?? 0, maxDelta),
  ])) as LlmRecommenderWeights;
  return normalizeLlmRecommenderWeights(next, baseWeights);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function effectiveCost(row: Record<string, unknown>): number {
  const estimated = n(row.estimated_cost_usd ?? row.estimatedCostUsd, 0);
  if (estimated > 0) return estimated;
  return n(row.cost_usd ?? row.costUsd, 0);
}

function normalizeMetricRow(row: Record<string, unknown>): LlmRoutingLearningMetric {
  const metric = {
    selectorKey: normalizeToken(row.selector_key ?? row.selectorKey),
    runtimePurpose: normalizeToken(row.runtime_purpose ?? row.runtimePurpose),
    abstractModel: normalizeToken(row.abstract_model ?? row.abstractModel),
    providerTier: normalizeToken(row.provider_tier ?? row.providerTier, 'unknown'),
    sample: n(row.sample ?? row.count, 0),
    successRate: clamp(row.success_rate ?? row.successRate, 0, 1, 0),
    avgDurationMs: n(row.avg_duration_ms ?? row.avgDurationMs, 0),
    p95DurationMs: n(row.p95_duration_ms ?? row.p95DurationMs, row.avg_duration_ms ?? row.avgDurationMs ?? 0),
    avgEffectiveCostUsd: n(row.avg_effective_cost_usd ?? row.avgEffectiveCostUsd, 0),
    avgPromptChars: n(row.avg_prompt_chars ?? row.avgPromptChars, 0),
    fallbackRate: clamp(row.fallback_rate ?? row.fallbackRate, 0, 1, 0),
    errorRate: clamp(row.error_rate ?? row.errorRate, 0, 1, 0),
    budgetGuardRate: clamp(row.budget_guard_rate ?? row.budgetGuardRate, 0, 1, 0),
    compositeScore: 0,
  };
  return { ...metric, compositeScore: round(computeCompositeScore(metric), 6) };
}

export function aggregateLlmRoutingRowsForLearning(rows: Array<Record<string, unknown>> = []): LlmRoutingLearningMetric[] {
  if (rows.some((row) => row.sample != null || row.success_rate != null || row.successRate != null)) {
    return rows.map(normalizeMetricRow);
  }

  const groups = new Map<string, {
    selectorKey: string;
    runtimePurpose: string;
    abstractModel: string;
    providerTier: string;
    rows: Record<string, unknown>[];
  }>();

  for (const row of rows) {
    const selectorKey = normalizeToken(row.selector_key ?? row.selectorKey);
    const runtimePurpose = normalizeToken(row.runtime_purpose ?? row.runtimePurpose);
    const abstractModel = normalizeToken(row.abstract_model ?? row.abstractModel);
    const providerTier = normalizeToken(row.provider_tier ?? row.providerTier, 'unknown');
    const key = `${selectorKey}|${runtimePurpose}|${abstractModel}|${providerTier}`;
    if (!groups.has(key)) groups.set(key, { selectorKey, runtimePurpose, abstractModel, providerTier, rows: [] });
    groups.get(key)!.rows.push(row);
  }

  return [...groups.values()].map((group) => {
    const sample = group.rows.length;
    const durations = group.rows.map((row) => n(row.duration_ms ?? row.durationMs, 0)).filter((value) => value >= 0);
    const metric = {
      selectorKey: group.selectorKey,
      runtimePurpose: group.runtimePurpose,
      abstractModel: group.abstractModel,
      providerTier: group.providerTier,
      sample,
      successRate: sample ? group.rows.filter((row) => row.success === true || row.success === 'true').length / sample : 0,
      avgDurationMs: sample ? durations.reduce((sum, value) => sum + value, 0) / sample : 0,
      p95DurationMs: percentile(durations, 0.95),
      avgEffectiveCostUsd: sample ? group.rows.reduce((sum, row) => sum + effectiveCost(row), 0) / sample : 0,
      avgPromptChars: sample ? group.rows.reduce((sum, row) => sum + n(row.prompt_chars ?? row.promptChars, 0), 0) / sample : 0,
      fallbackRate: sample ? group.rows.filter((row) => n(row.fallback_count ?? row.fallbackCount, 0) > 0).length / sample : 0,
      errorRate: sample ? group.rows.filter((row) => row.error != null || row.success === false || row.success === 'false').length / sample : 0,
      budgetGuardRate: sample ? group.rows.filter((row) => isBudgetGuardBlocked(row.budget_guard_status ?? row.budgetGuardStatus)).length / sample : 0,
      compositeScore: 0,
    };
    return { ...metric, compositeScore: round(computeCompositeScore(metric), 6) };
  });
}

function isBudgetGuardBlocked(value: unknown): boolean {
  const status = String(value ?? '').trim().toLowerCase();
  if (!status) return false;
  return !['ok', 'allow', 'allowed', 'pass', 'passed', 'success', 'cache_hit'].includes(status);
}

function computeCompositeScore(metric: Omit<LlmRoutingLearningMetric, 'compositeScore'>): number {
  const success = clamp(metric.successRate, 0, 1, 0);
  const durationPenalty = Math.min(0.25, Math.log10(1 + Math.max(0, metric.avgDurationMs)) / 20);
  const costPenalty = Math.min(0.20, Math.log10(1 + Math.max(0, metric.avgEffectiveCostUsd) * 1000) / 20);
  const fallbackPenalty = Math.min(0.10, metric.fallbackRate * 0.10);
  const errorPenalty = Math.min(0.20, metric.errorRate * 0.20 + metric.budgetGuardRate * 0.10);
  return clamp(success - durationPenalty - costPenalty - fallbackPenalty - errorPenalty, 0, 1, 0);
}

function contextKey(row: LlmRoutingLearningMetric): string {
  return `${row.selectorKey}|${row.runtimePurpose}`;
}

function isAccuracySensitivePurpose(purpose: string): boolean {
  return /(evaluation|synthesis|repair|diagnosis|generation|review|analysis|decision)/i.test(purpose);
}

function isLargeModel(model: string): boolean {
  return /sonnet|opus/i.test(model);
}

function addDelta(deltas: Record<LlmRecommenderWeightCategory, number>, category: LlmRecommenderWeightCategory, value: number): void {
  deltas[category] += value;
}

function buildDeltas(rows: LlmRoutingLearningMetric[], maxDelta: number): {
  deltas: Record<LlmRecommenderWeightCategory, number>;
  reasons: string[];
  contextsEvaluated: number;
} {
  const deltas = Object.fromEntries(LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [category, 0])) as Record<LlmRecommenderWeightCategory, number>;
  const reasons = new Set<string>();
  const byContext = new Map<string, LlmRoutingLearningMetric[]>();

  for (const row of rows) {
    const key = contextKey(row);
    if (!byContext.has(key)) byContext.set(key, []);
    byContext.get(key)!.push(row);

    const failurePressure = Math.max(
      SUCCESS_FLOOR - row.successRate,
      row.errorRate - 0.05,
      row.fallbackRate - 0.20,
      row.budgetGuardRate - 0.10,
      0,
    );
    if (failurePressure > 0) {
      addDelta(deltas, 'failure', Math.min(maxDelta, 0.015 + failurePressure * 0.05));
      reasons.add('failure_pressure_boost');
    }
  }

  let contextsEvaluated = 0;
  for (const contextRows of byContext.values()) {
    if (contextRows.length < 2) continue;
    contextsEvaluated += 1;
    const sorted = [...contextRows].sort((a, b) => b.compositeScore - a.compositeScore);
    const best = sorted[0];
    const runnerUp = sorted[1];
    const gap = best.compositeScore - runnerUp.compositeScore;
    const bestCost = Math.min(...contextRows.map((row) => row.avgEffectiveCostUsd).filter((value) => value >= 0));
    const bestDuration = Math.min(...contextRows.map((row) => row.avgDurationMs).filter((value) => value >= 0));
    const expensivePeer = contextRows.some((row) => row.avgEffectiveCostUsd > bestCost * 1.2 && row.avgEffectiveCostUsd > 0);
    const slowPeer = contextRows.some((row) => row.avgDurationMs > bestDuration * 1.2 && row.avgDurationMs > 0);
    const longPrompt = contextRows.some((row) => row.avgPromptChars >= 8000);

    if (best.successRate >= SUCCESS_FLOOR && gap >= 0.04) {
      addDelta(deltas, 'task_type', Math.min(maxDelta, 0.012 + gap * 0.05));
      reasons.add('task_type_context_winner_boost');
    }
    if (expensivePeer && best.avgEffectiveCostUsd <= bestCost * 1.05) {
      addDelta(deltas, 'budget', Math.min(maxDelta, 0.012 + Math.min(gap, 0.20) * 0.04));
      reasons.add('budget_low_cost_context_boost');
    }
    if (slowPeer && best.avgDurationMs <= bestDuration * 1.05) {
      addDelta(deltas, 'urgency', Math.min(maxDelta, 0.012 + Math.min(gap, 0.20) * 0.04));
      reasons.add('urgency_fast_context_boost');
    }
    if (longPrompt && isLargeModel(best.abstractModel) && gap >= 0.02) {
      addDelta(deltas, 'length', Math.min(maxDelta, 0.012 + Math.min(gap, 0.20) * 0.04));
      reasons.add('length_long_prompt_large_model_boost');
    }
    if (isAccuracySensitivePurpose(best.runtimePurpose) && isLargeModel(best.abstractModel) && gap >= 0.02) {
      addDelta(deltas, 'accuracy', Math.min(maxDelta, 0.012 + Math.min(gap, 0.20) * 0.04));
      reasons.add('accuracy_sensitive_large_model_boost');
    }
  }

  const capped = Object.fromEntries(LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [
    category,
    round(Math.max(-maxDelta, Math.min(maxDelta, deltas[category])), 6),
  ])) as Record<LlmRecommenderWeightCategory, number>;

  return {
    deltas: capped,
    reasons: reasons.size ? [...reasons].sort() : ['feedback_within_control_band'],
    contextsEvaluated,
  };
}

export function buildLlmRecommenderWeightLearningReport(options: {
  rows?: Array<Record<string, unknown>> | LlmRoutingLearningMetric[];
  days?: number;
  minSamples?: number;
  baseWeights?: Partial<Record<LlmRecommenderWeightCategory, unknown>>;
  maxDelta?: number;
  now?: Date;
} = {}): LlmRecommenderWeightLearningReport {
  const days = Math.max(1, Math.floor(n(options.days, 7)));
  const minSamples = Math.max(1, Math.floor(n(options.minSamples, 30)));
  const maxDelta = clamp(options.maxDelta, 0.01, 0.12, DEFAULT_MAX_DELTA);
  const baseWeights = normalizeLlmRecommenderWeights(options.baseWeights || DEFAULT_LLM_RECOMMENDER_WEIGHT_POLICY);
  const rows = aggregateLlmRoutingRowsForLearning((options.rows || []) as Array<Record<string, unknown>>);
  const eligibleRows = rows.filter((row) => row.sample >= minSamples);
  const staticCompositeScore = eligibleRows.length
    ? eligibleRows.reduce((sum, row) => sum + row.compositeScore * row.sample, 0) / eligibleRows.reduce((sum, row) => sum + row.sample, 0)
    : 0;

  if (eligibleRows.length === 0) {
    return {
      ok: true,
      status: 'insufficient_feedback_static_weights',
      source: 'llm_recommender_weight_learning',
      shadowOnly: true,
      liveMutation: false,
      promotionReady: false,
      manualPromotionReviewCandidate: false,
      generatedAt: (options.now || new Date()).toISOString(),
      days,
      minSamples,
      baseWeights,
      weights: baseWeights,
      deltas: Object.fromEntries(LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [category, 0])) as LlmRecommenderWeights,
      maxDelta,
      metrics: {
        totalRows: rows.length,
        eligibleRows: 0,
        contextsEvaluated: 0,
        staticCompositeScore: round(staticCompositeScore),
        shadowCompositeScore: round(staticCompositeScore),
        rows,
      },
      reasons: ['insufficient_feedback_samples'],
      blockers: ['minimum_sample_gate_not_met'],
    };
  }

  const learned = buildDeltas(eligibleRows, maxDelta);
  const weights = applyLlmRecommenderWeightDeltas(baseWeights, learned.deltas, maxDelta);
  const deltas = Object.fromEntries(LLM_RECOMMENDER_WEIGHT_CATEGORIES.map((category) => [
    category,
    round(weights[category] - baseWeights[category]),
  ])) as LlmRecommenderWeights;
  const positiveDelta = LLM_RECOMMENDER_WEIGHT_CATEGORIES.reduce((sum, category) => sum + Math.max(0, learned.deltas[category]), 0);
  const failureOnly = learned.reasons.length === 1 && learned.reasons[0] === 'failure_pressure_boost';
  const shadowCompositeScore = failureOnly
    ? staticCompositeScore - Math.min(0.02, positiveDelta * 0.10)
    : staticCompositeScore + Math.min(0.03, positiveDelta * 0.12);
  const manualPromotionReviewCandidate = shadowCompositeScore + 0.000_001 >= staticCompositeScore && !failureOnly;

  return {
    ok: true,
    status: 'shadow_weight_feedback_ready',
    source: 'llm_recommender_weight_learning',
    shadowOnly: true,
    liveMutation: false,
    promotionReady: false,
    manualPromotionReviewCandidate,
    generatedAt: (options.now || new Date()).toISOString(),
    days,
    minSamples,
    baseWeights,
    weights,
    deltas,
    maxDelta,
    metrics: {
      totalRows: rows.length,
      eligibleRows: eligibleRows.length,
      contextsEvaluated: learned.contextsEvaluated,
      staticCompositeScore: round(staticCompositeScore),
      shadowCompositeScore: round(shadowCompositeScore),
      rows: eligibleRows,
    },
    reasons: learned.reasons,
    blockers: manualPromotionReviewCandidate ? [] : ['shadow_composite_not_above_static'],
  };
}

export async function fetchLlmRecommenderWeightLearningRows(options: {
  queryFn?: QueryFn;
  days?: number;
  minSamples?: number;
} = {}): Promise<LlmRoutingLearningMetric[]> {
  const days = Math.max(1, Math.floor(n(options.days, 7)));
  const minSamples = Math.max(1, Math.floor(n(options.minSamples, 30)));
  const queryFn = options.queryFn || pgPool.query.bind(pgPool, 'public');
  const result = await queryFn(`
    SELECT
      COALESCE(NULLIF(selector_key, ''), 'unknown') AS selector_key,
      COALESCE(NULLIF(runtime_purpose, ''), 'unknown') AS runtime_purpose,
      COALESCE(NULLIF(abstract_model, ''), 'unknown') AS abstract_model,
      COALESCE(NULLIF(provider_tier, ''), 'unknown') AS provider_tier,
      COUNT(*)::int AS sample,
      AVG(CASE WHEN success IS TRUE THEN 1.0 ELSE 0.0 END)::double precision AS success_rate,
      AVG(COALESCE(duration_ms, 0))::double precision AS avg_duration_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY COALESCE(duration_ms, 0))::double precision AS p95_duration_ms,
      AVG(COALESCE(NULLIF(estimated_cost_usd, 0), NULLIF(cost_usd, 0), 0))::double precision AS avg_effective_cost_usd,
      AVG(COALESCE(prompt_chars, 0))::double precision AS avg_prompt_chars,
      AVG(CASE WHEN COALESCE(fallback_count, 0) > 0 THEN 1.0 ELSE 0.0 END)::double precision AS fallback_rate,
      AVG(CASE WHEN error IS NOT NULL OR success IS NOT TRUE THEN 1.0 ELSE 0.0 END)::double precision AS error_rate,
      AVG(CASE
        WHEN budget_guard_status IS NULL OR budget_guard_status IN ('ok', 'allow', 'allowed', 'pass', 'passed', 'success', 'cache_hit') THEN 0.0
        ELSE 1.0
      END)::double precision AS budget_guard_rate
    FROM public.llm_routing_log
    WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      AND selected_route IS NOT NULL
      AND abstract_model IS NOT NULL
    GROUP BY 1, 2, 3, 4
    HAVING COUNT(*) >= $2::int
    ORDER BY sample DESC
  `, [days, minSamples]);
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows || [];
  return aggregateLlmRoutingRowsForLearning(rows as Array<Record<string, unknown>>);
}

export async function fetchLlmRecommenderWeightLearningReport(options: {
  queryFn?: QueryFn | null;
  days?: number;
  minSamples?: number;
  noDb?: boolean;
  now?: Date;
} = {}): Promise<LlmRecommenderWeightLearningReport> {
  const rows = options.noDb || options.queryFn === null
    ? []
    : await fetchLlmRecommenderWeightLearningRows(options);
  return buildLlmRecommenderWeightLearningReport({
    rows,
    days: options.days,
    minSamples: options.minSamples,
    now: options.now,
  });
}

export async function persistLlmRecommenderWeightShadow(
  report: LlmRecommenderWeightLearningReport,
  runFn: RunFn = pgPool.run,
): Promise<{ rowCount: number; rows: unknown[] }> {
  return runFn('hub', `
    INSERT INTO llm_recommender_weight_shadow (
      days,
      min_samples,
      status,
      shadow_only,
      live_mutation,
      promotion_ready,
      manual_promotion_review_candidate,
      base_weights,
      weights,
      deltas,
      metrics,
      reasons,
      blockers,
      report
    ) VALUES (
      $1, $2, $3, TRUE, FALSE, FALSE, $4,
      $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb
    )
  `, [
    report.days,
    report.minSamples,
    report.status,
    report.manualPromotionReviewCandidate,
    JSON.stringify(report.baseWeights),
    JSON.stringify(report.weights),
    JSON.stringify(report.deltas),
    JSON.stringify(report.metrics),
    JSON.stringify(report.reasons),
    JSON.stringify(report.blockers),
    JSON.stringify(report),
  ]);
}
