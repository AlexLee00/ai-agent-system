// @ts-nocheck
/**
 * Pure Luna decision policy helpers.
 *
 * Luna's orchestration file is still the runtime owner, but confidence,
 * debate, analyst-weight, and signal-fusion policy live here so they can be
 * smoke-tested without pulling every orchestration side effect into scope.
 */

import { ACTIONS, ANALYST_TYPES } from './signal.ts';
import { isPaperMode } from './secrets.ts';
import { getLunaRuntimeConfig, getLunaStockStrategyProfile } from './runtime-config.ts';
import { BASE_LUNA_ANALYST_WEIGHTS, buildLunaAnalystWeights } from './luna-analyst-weight-policy.ts';

const LUNA_RUNTIME = getLunaRuntimeConfig();
const LUNA_STOCK_PROFILE = getLunaStockStrategyProfile();
const MIN_CONFIDENCE = LUNA_RUNTIME.minConfidence.live;
const PAPER_MIN_CONFIDENCE = LUNA_RUNTIME.minConfidence.paper;
const MAX_DEBATE_SYMBOLS = LUNA_RUNTIME.maxDebateSymbols;

export const ANALYST_WEIGHTS = BASE_LUNA_ANALYST_WEIGHTS;
export const DIRECTION_MAP = { BUY: 1, SELL: -1, HOLD: 0 };

export function buildAnalystWeights(exchange = 'binance', options = {}) {
  return buildLunaAnalystWeights(exchange, options);
}

export function getMinConfidence(exchange) {
  if (exchange === 'kis' || exchange === 'kis_overseas') {
    return isPaperMode()
      ? LUNA_STOCK_PROFILE.minConfidence.paper
      : LUNA_STOCK_PROFILE.minConfidence.live;
  }
  if (isPaperMode()) return PAPER_MIN_CONFIDENCE[exchange] ?? MIN_CONFIDENCE[exchange] ?? 0.60;
  return MIN_CONFIDENCE[exchange] ?? 0.60;
}

export function getDebateLimit(exchange, symbolCount = 0) {
  if (!isPaperMode()) {
    if (exchange === 'binance') {
      const count = Math.max(0, Number(symbolCount || 0));
      const rules = Array.isArray(LUNA_RUNTIME.dynamicDebateLimits?.cryptoLive)
        ? [...LUNA_RUNTIME.dynamicDebateLimits.cryptoLive]
            .map((rule) => ({
              minSymbols: Math.max(0, Number(rule?.minSymbols || 0)),
              limit: Math.max(1, Number(rule?.limit || MAX_DEBATE_SYMBOLS)),
            }))
            .sort((a, b) => a.minSymbols - b.minSymbols)
        : [];
      let limit = MAX_DEBATE_SYMBOLS;
      for (const rule of rules) {
        if (count >= rule.minSymbols) {
          limit = Math.max(limit, rule.limit);
        }
      }
      return limit;
    }
    return MAX_DEBATE_SYMBOLS;
  }
  if (exchange === 'kis' || exchange === 'kis_overseas') return 1;
  return MAX_DEBATE_SYMBOLS;
}

function getSentinelFusionProfile(analysis = {}) {
  const metadata = analysis?.metadata && typeof analysis.metadata === 'object' ? analysis.metadata : {};
  const quality = metadata?.quality && typeof metadata.quality === 'object' ? metadata.quality : {};
  const sourceBreakdown = metadata?.sourceBreakdown && typeof metadata.sourceBreakdown === 'object'
    ? metadata.sourceBreakdown
    : {};
  const tierWeights = metadata?.sourceTierWeights && typeof metadata.sourceTierWeights === 'object'
    ? metadata.sourceTierWeights
    : { tier2: 0.65, tier3: 0.35 };

  const newsConfidence = Number(sourceBreakdown?.news?.confidence || metadata?.news?.confidence || 0);
  const communityConfidence = Number(sourceBreakdown?.community?.confidence || metadata?.community?.confidence || 0);
  const newsSignal = String(sourceBreakdown?.news?.signal || metadata?.news?.signal || '').trim().toUpperCase();
  const communitySignal = String(sourceBreakdown?.community?.signal || metadata?.community?.signal || '').trim().toUpperCase();
  const weightedConfidenceBase =
    (newsConfidence * Number(tierWeights?.tier2 || 0.65))
    + (communityConfidence * Number(tierWeights?.tier3 || 0.35));

  let confidenceMultiplier = 1;
  let weightMultiplier = 1;

  if (quality?.status === 'degraded') {
    confidenceMultiplier *= 0.82;
    weightMultiplier *= 0.9;
  } else if (quality?.status === 'insufficient') {
    confidenceMultiplier *= 0.6;
    weightMultiplier *= 0.7;
  }

  if (
    newsSignal
    && communitySignal
    && newsSignal !== ACTIONS.HOLD
    && communitySignal !== ACTIONS.HOLD
    && newsSignal !== communitySignal
  ) {
    confidenceMultiplier *= 0.88;
    weightMultiplier *= 0.92;
  }

  const effectiveConfidence = Math.max(
    0,
    Math.min(
      1,
      Number(((weightedConfidenceBase || Number(analysis?.confidence || 0.5)) * confidenceMultiplier).toFixed(4)),
    ),
  );

  return {
    effectiveConfidence,
    weightMultiplier: Number(weightMultiplier.toFixed(4)),
    qualityStatus: quality?.status || 'unknown',
  };
}

function getFusionInput(type, analysis, weights) {
  const baseWeight = Number(weights[type] ?? 0.05);
  const direction = DIRECTION_MAP[analysis.signal] ?? 0;
  let confidence = Math.max(0, Math.min(1, analysis.confidence || 0.5));
  let weight = baseWeight;

  if (type === ANALYST_TYPES.SENTINEL) {
    const sentinelProfile = getSentinelFusionProfile(analysis);
    confidence = sentinelProfile.effectiveConfidence;
    weight = Number((baseWeight * sentinelProfile.weightMultiplier).toFixed(4));
  }

  return { weight, direction, confidence };
}

export function fuseSignals(analyses, weights = ANALYST_WEIGHTS) {
  const byType = new Map();
  for (const analysis of analyses || []) {
    if (!byType.has(analysis.analyst)) byType.set(analysis.analyst, analysis);
  }

  let weightedScore = 0;
  let totalWeight = 0;
  const directions = [];
  for (const [type, analysis] of byType) {
    const { weight, direction, confidence } = getFusionInput(type, analysis, weights);
    weightedScore += direction * confidence * weight;
    totalWeight += weight;
    if (direction !== 0) directions.push(direction);
  }

  const fusedScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const averageConfidence = byType.size > 0
    ? [...byType.entries()].reduce((sum, [type, analysis]) => sum + getFusionInput(type, analysis, weights).confidence, 0) / byType.size
    : 0.5;
  const hasConflict = directions.some((direction) => direction > 0) && directions.some((direction) => direction < 0);
  const recommendation =
    hasConflict && Math.abs(fusedScore) < 0.3 ? 'HOLD' :
    fusedScore > 0.2 ? 'LONG' :
    fusedScore < -0.2 ? 'SHORT' : 'HOLD';

  return { fusedScore, averageConfidence, hasConflict, recommendation };
}

export function shouldDebateForSymbol(analyses, exchange, analystWeights = ANALYST_WEIGHTS) {
  const fused = fuseSignals(analyses, analystWeights);
  if (fused.hasConflict) return true;
  if (exchange === 'kis' || exchange === 'kis_overseas') {
    const threshold = isPaperMode()
      ? LUNA_STOCK_PROFILE.debateThresholds.paper
      : LUNA_STOCK_PROFILE.debateThresholds.live;
    return fused.averageConfidence < threshold.minAverageConfidence || Math.abs(fused.fusedScore) < threshold.minAbsScore;
  }
  return fused.averageConfidence < LUNA_RUNTIME.debateThresholds.crypto.minAverageConfidence
    || Math.abs(fused.fusedScore) < LUNA_RUNTIME.debateThresholds.crypto.minAbsScore;
}

export default {
  ANALYST_WEIGHTS,
  DIRECTION_MAP,
  buildAnalystWeights,
  getMinConfidence,
  getDebateLimit,
  shouldDebateForSymbol,
  fuseSignals,
};
