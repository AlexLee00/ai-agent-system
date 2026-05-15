// @ts-nocheck
/**
 * Luna autonomous weight feedback.
 *
 * Produces conservative, shadow-only weight adjustments from recent evidence.
 * This does not mutate live trading state; runtime callers decide whether to
 * persist the derived weight vector as shadow evidence.
 */

import * as db from './db/core.ts';
import { fetchLunaCommunitySourceQualityAudit } from './luna-community-source-quality.ts';

export const DEFAULT_LUNA_WEIGHT_POLICY = Object.freeze({
  candidate: 0.20,
  backtest: 0.35,
  predictive: 0.25,
  community: 0.20,
});

const COMPONENTS = ['candidate', 'backtest', 'predictive', 'community'];
const FLOOR_WEIGHT = 0.08;
const CEILING_WEIGHT = 0.48;

function n(value: any, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: any, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, n(value, fallback)));
}

function round(value: any, digits = 4) {
  return Number(n(value, 0).toFixed(digits));
}

function normalizeMarket(value: any = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'all') return null;
  if (raw === 'binance') return 'crypto';
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  return ['crypto', 'domestic', 'overseas'].includes(raw) ? raw : null;
}

export function normalizeLunaWeightPolicy(weights: any = {}, fallback: any = DEFAULT_LUNA_WEIGHT_POLICY) {
  const raw = {};
  for (const key of COMPONENTS) {
    raw[key] = Math.max(0, n(weights?.[key], fallback?.[key] ?? DEFAULT_LUNA_WEIGHT_POLICY[key]));
  }
  const total = COMPONENTS.reduce((sum, key) => sum + raw[key], 0);
  if (!(total > 0)) return { ...DEFAULT_LUNA_WEIGHT_POLICY };
  const normalized = {};
  for (const key of COMPONENTS) normalized[key] = raw[key] / total;
  return normalized;
}

function normalizeBoundedWeights(weights: any = {}, baseWeights: any = DEFAULT_LUNA_WEIGHT_POLICY) {
  const bounded = {};
  for (const key of COMPONENTS) {
    bounded[key] = clamp(weights?.[key], FLOOR_WEIGHT, CEILING_WEIGHT, baseWeights[key]);
  }
  return normalizeLunaWeightPolicy(bounded, baseWeights);
}

function capDelta(delta: number, maxDelta: number) {
  return clamp(delta, -Math.abs(maxDelta), Math.abs(maxDelta), 0);
}

function applyDelta(base: any, deltas: any, maxDelta: number) {
  const next = {};
  for (const key of COMPONENTS) next[key] = base[key] + capDelta(deltas[key] || 0, maxDelta);
  return normalizeBoundedWeights(next, base);
}

function metricHasSamples(metrics: any = {}) {
  return n(metrics?.candidate?.activeCount, 0) > 0
    || n(metrics?.backtest?.sample, 0) > 0
    || n(metrics?.predictive?.sample, 0) > 0
    || n(metrics?.community?.sample, 0) > 0;
}

function deriveCommunityMetrics(report: any = {}) {
  const sources = Array.isArray(report.sources) ? report.sources : [];
  const sample = sources.length;
  const ready = sources.filter((source) => ['observe', 'boost'].includes(source.status)).length;
  const blocked = sources.filter((source) => source.status === 'block_candidate').length;
  const downweighted = sources.filter((source) => source.status === 'downweight').length;
  const avgQuality = sources.reduce((sum, source) => sum + n(source.recommendedQuality, 0), 0) / Math.max(1, sample);
  return {
    sample,
    readyRatio: sample ? ready / sample : 0,
    blockedRatio: sample ? blocked / sample : 0,
    downweightedRatio: sample ? downweighted / sample : 0,
    avgQuality: sample ? avgQuality : 0,
    warnings: report.warnings || [],
    blockers: report.blockers || [],
  };
}

export function buildLunaAutonomousWeightFeedback(input: any = {}) {
  const baseWeights = normalizeLunaWeightPolicy(input.baseWeights || DEFAULT_LUNA_WEIGHT_POLICY);
  const metrics = input.metrics || {};
  const maxDelta = clamp(input.maxDelta, 0.01, 0.12, 0.07);
  const mode = input.mode || 'shadow';
  const reasons = [];
  const deltas = { candidate: 0, backtest: 0, predictive: 0, community: 0 };

  if (!metricHasSamples(metrics)) {
    return {
      ok: true,
      status: 'insufficient_feedback_static_weights',
      source: 'luna_autonomous_feedback',
      mode,
      shadowOnly: true,
      liveMutation: false,
      generatedAt: new Date().toISOString(),
      baseWeights,
      weights: baseWeights,
      deltas: { candidate: 0, backtest: 0, predictive: 0, community: 0 },
      metrics,
      reasons: ['insufficient_feedback_samples'],
    };
  }

  const backtestSample = n(metrics?.backtest?.sample, 0);
  const backtestFreshRate = clamp(metrics?.backtest?.freshRate, 0, 1, 0);
  const backtestHealthyRate = clamp(metrics?.backtest?.healthyRate, 0, 1, 0);
  const backtestPassRate = clamp(metrics?.backtest?.passRate, 0, 1, 0);
  if (backtestSample > 0 && (backtestFreshRate < 0.55 || backtestHealthyRate < 0.45 || backtestPassRate < 0.30)) {
    const pressure = Math.max(0.30 - backtestPassRate, 0.55 - backtestFreshRate, 0.45 - backtestHealthyRate);
    const delta = Math.min(maxDelta, 0.025 + pressure * 0.06);
    deltas.backtest -= delta;
    deltas.candidate += delta * 0.45;
    deltas.predictive += delta * 0.35;
    deltas.community += delta * 0.20;
    reasons.push('backtest_feedback_weak_downweight');
  } else if (backtestSample >= 5 && backtestFreshRate >= 0.80 && backtestHealthyRate >= 0.65 && backtestPassRate >= 0.45) {
    const delta = Math.min(maxDelta * 0.55, 0.025 + (backtestPassRate - 0.45) * 0.04);
    deltas.backtest += delta;
    deltas.candidate -= delta * 0.45;
    deltas.community -= delta * 0.35;
    deltas.predictive -= delta * 0.20;
    reasons.push('backtest_feedback_strong_boost');
  }

  const predictiveSample = n(metrics?.predictive?.sample, 0);
  const predictivePassRate = clamp(metrics?.predictive?.passRate, 0, 1, 0);
  const predictiveCoverage = clamp(metrics?.predictive?.coverageAvg, 0, 1, 0);
  const predictiveBlockRate = clamp(metrics?.predictive?.blockRate, 0, 1, 0);
  if (predictiveSample > 0 && (predictiveCoverage < 0.75 || predictivePassRate < 0.25 || predictiveBlockRate > 0.70)) {
    const pressure = Math.max(0.75 - predictiveCoverage, 0.25 - predictivePassRate, predictiveBlockRate - 0.70);
    const delta = Math.min(maxDelta, 0.02 + pressure * 0.05);
    deltas.predictive -= delta;
    deltas.backtest += delta * 0.45;
    deltas.candidate += delta * 0.35;
    deltas.community += delta * 0.20;
    reasons.push('predictive_feedback_weak_downweight');
  } else if (predictiveSample >= 5 && predictiveCoverage >= 0.82 && predictivePassRate >= 0.35 && predictiveBlockRate <= 0.55) {
    const delta = Math.min(maxDelta * 0.55, 0.02 + (predictivePassRate - 0.35) * 0.035);
    deltas.predictive += delta;
    deltas.candidate -= delta * 0.35;
    deltas.backtest -= delta * 0.35;
    deltas.community -= delta * 0.30;
    reasons.push('predictive_feedback_strong_boost');
  }

  const communitySample = n(metrics?.community?.sample, 0);
  const communityReadyRatio = clamp(metrics?.community?.readyRatio, 0, 1, 0);
  const communityBlockedRatio = clamp(metrics?.community?.blockedRatio, 0, 1, 0);
  const communityDownweightedRatio = clamp(metrics?.community?.downweightedRatio, 0, 1, 0);
  const communityAvgQuality = clamp(metrics?.community?.avgQuality, 0, 1, 0);
  if (communitySample > 0 && (communityReadyRatio < 0.55 || communityBlockedRatio > 0.20 || communityDownweightedRatio > 0.45 || communityAvgQuality < 0.28)) {
    const pressure = Math.max(0.55 - communityReadyRatio, communityBlockedRatio - 0.20, communityDownweightedRatio - 0.45, 0.28 - communityAvgQuality);
    const delta = Math.min(maxDelta, 0.02 + pressure * 0.06);
    deltas.community -= delta;
    deltas.backtest += delta * 0.45;
    deltas.predictive += delta * 0.35;
    deltas.candidate += delta * 0.20;
    reasons.push('community_source_quality_weak_downweight');
  } else if (communitySample >= 5 && communityReadyRatio >= 0.75 && communityBlockedRatio <= 0.10 && communityAvgQuality >= 0.38) {
    const delta = Math.min(maxDelta * 0.45, 0.015 + (communityReadyRatio - 0.75) * 0.035);
    deltas.community += delta;
    deltas.candidate -= delta * 0.45;
    deltas.backtest -= delta * 0.35;
    deltas.predictive -= delta * 0.20;
    reasons.push('community_source_quality_strong_boost');
  }

  const weights = applyDelta(baseWeights, deltas, maxDelta);
  const appliedDeltas = {};
  for (const key of COMPONENTS) appliedDeltas[key] = round(weights[key] - baseWeights[key]);
  if (reasons.length === 0) reasons.push('feedback_within_control_band');

  return {
    ok: true,
    status: 'shadow_weight_feedback_ready',
    source: 'luna_autonomous_feedback',
    mode,
    shadowOnly: true,
    liveMutation: false,
    generatedAt: new Date().toISOString(),
    baseWeights,
    weights,
    deltas: appliedDeltas,
    maxDelta,
    metrics,
    reasons,
  };
}

async function safeGet(sql: string, params: any[] = [], fallback: any = {}, errors: any[] = [], source = 'query') {
  try {
    return await db.get(sql, params) || fallback;
  } catch (error) {
    errors.push({ source, error: String(error?.message || error) });
    return fallback;
  }
}

export async function fetchLunaAutonomousWeightFeedback(options: any = {}) {
  const days = Math.max(1, n(options.days, 7));
  const market = normalizeMarket(options.market);
  const errors = [];
  const params = [days, market];
  const backtestRow = await safeGet(`
    SELECT COUNT(*)::int AS sample,
           AVG(CASE WHEN fresh IS TRUE THEN 1.0 ELSE 0.0 END)::double precision AS fresh_rate,
           AVG(CASE WHEN healthy IS TRUE THEN 1.0 ELSE 0.0 END)::double precision AS healthy_rate,
           AVG(CASE WHEN gate_status = 'pass' AND fresh IS TRUE AND healthy IS TRUE AND COALESCE(would_block, false) IS FALSE THEN 1.0 ELSE 0.0 END)::double precision AS pass_rate
      FROM candidate_backtest_status
     WHERE updated_at >= NOW() - (($1::int + 7) * INTERVAL '1 day')
       AND ($2::text IS NULL OR market = $2::text)
  `, params, { sample: 0 }, errors, 'candidate_backtest_status');

  const predictiveRow = await safeGet(`
    SELECT COUNT(*)::int AS sample,
           AVG(component_coverage)::double precision AS coverage_avg,
           AVG(CASE WHEN decision IN ('fire', 'pass', 'pass_prediction', 'pass_backtest') THEN 1.0 ELSE 0.0 END)::double precision AS pass_rate,
           AVG(CASE WHEN decision = 'fire' THEN 1.0 ELSE 0.0 END)::double precision AS fire_rate,
           AVG(CASE WHEN decision LIKE '%block%' OR blocked_reason IS NOT NULL THEN 1.0 ELSE 0.0 END)::double precision AS block_rate
      FROM predictive_validation_log
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
       AND ($2::text IS NULL OR market = $2::text)
  `, params, { sample: 0 }, errors, 'predictive_validation_log');

  const candidateRow = await safeGet(`
    SELECT COUNT(*)::int AS active_count,
           AVG(score)::double precision AS avg_score
      FROM candidate_universe
     WHERE expires_at > NOW()
       AND ($1::text IS NULL OR market = $1::text)
  `, [market], { active_count: 0 }, errors, 'candidate_universe');

  let communityReport = null;
  try {
    communityReport = await fetchLunaCommunitySourceQualityAudit({
      days,
      minEvents: options.minEvents || 3,
      market,
    });
  } catch (error) {
    errors.push({ source: 'community_source_quality', error: String(error?.message || error) });
  }

  const metrics = {
    days,
    market: market || 'all',
    candidate: {
      activeCount: n(candidateRow.active_count, 0),
      avgScore: round(candidateRow.avg_score, 4),
    },
    backtest: {
      sample: n(backtestRow.sample, 0),
      freshRate: round(backtestRow.fresh_rate, 4),
      healthyRate: round(backtestRow.healthy_rate, 4),
      passRate: round(backtestRow.pass_rate, 4),
    },
    predictive: {
      sample: n(predictiveRow.sample, 0),
      coverageAvg: round(predictiveRow.coverage_avg, 4),
      passRate: round(predictiveRow.pass_rate, 4),
      fireRate: round(predictiveRow.fire_rate, 4),
      blockRate: round(predictiveRow.block_rate, 4),
    },
    community: deriveCommunityMetrics(communityReport || {}),
    errors,
  };

  return buildLunaAutonomousWeightFeedback({
    baseWeights: options.baseWeights || DEFAULT_LUNA_WEIGHT_POLICY,
    metrics,
    maxDelta: options.maxDelta || 0.07,
    mode: options.mode || 'shadow',
  });
}

export default {
  DEFAULT_LUNA_WEIGHT_POLICY,
  normalizeLunaWeightPolicy,
  buildLunaAutonomousWeightFeedback,
  fetchLunaAutonomousWeightFeedback,
};
