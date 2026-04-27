// @ts-nocheck

import { ANALYST_TYPES } from './signal.ts';
import { getEffectiveAnalystWeightProfiles, normalizeWeights } from './analyst-accuracy.ts';
import { REGIME_GUIDES } from './market-regime.ts';
import { isPaperMode } from './secrets.ts';

export const BASE_LUNA_ANALYST_WEIGHTS = {
  [ANALYST_TYPES.TA_MTF]: 0.35,
  [ANALYST_TYPES.ONCHAIN]: 0.25,
  [ANALYST_TYPES.MARKET_FLOW]: 0.18,
  [ANALYST_TYPES.SENTINEL]: 0.35,
  [ANALYST_TYPES.SENTIMENT]: 0.20,
  [ANALYST_TYPES.NEWS]: 0.15,
};

const STOCK_EXCHANGES = new Set(['kis', 'kis_overseas']);
const REGIME_AGENT_ANALYST_MAP = {
  aria: [ANALYST_TYPES.TA_MTF],
  echo: [ANALYST_TYPES.TA_MTF],
  chronos: [ANALYST_TYPES.TA_MTF],
  oracle: [ANALYST_TYPES.ONCHAIN],
  hound: [ANALYST_TYPES.MARKET_FLOW],
  hera: [ANALYST_TYPES.MARKET_FLOW],
  macro: [ANALYST_TYPES.MARKET_FLOW],
  vibe: [ANALYST_TYPES.SENTIMENT],
  sophia: [ANALYST_TYPES.SENTIMENT],
  hermes: [ANALYST_TYPES.NEWS],
};

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveRegimeGuide(marketRegime = null) {
  const guide = marketRegime?.guide || null;
  if (guide?.agentWeights) return guide;
  const regimeName = String(marketRegime?.regime || marketRegime || '').trim();
  return REGIME_GUIDES[regimeName] || null;
}

export function buildLunaBaseAnalystWeights(exchange = 'binance', options = {}) {
  const runtimeAnalystWeightConfig = getEffectiveAnalystWeightProfiles();
  const isStock = STOCK_EXCHANGES.has(exchange);
  const paperMode = options.paperMode ?? isPaperMode();
  const profile = isStock
    ? (paperMode ? runtimeAnalystWeightConfig.stocksPaper : runtimeAnalystWeightConfig.stocksLive)
    : runtimeAnalystWeightConfig.crypto;
  const fallback = runtimeAnalystWeightConfig.default || {};
  const sentinelBase = profile?.sentinel
    ?? ((profile?.sentiment ?? fallback.sentiment ?? BASE_LUNA_ANALYST_WEIGHTS[ANALYST_TYPES.SENTIMENT])
      + (profile?.news ?? fallback.news ?? BASE_LUNA_ANALYST_WEIGHTS[ANALYST_TYPES.NEWS])) / 2;

  return normalizeWeights({
    [ANALYST_TYPES.TA_MTF]: profile?.taMtf ?? fallback.taMtf ?? BASE_LUNA_ANALYST_WEIGHTS[ANALYST_TYPES.TA_MTF],
    [ANALYST_TYPES.ONCHAIN]: profile?.onchain ?? fallback.onchain ?? BASE_LUNA_ANALYST_WEIGHTS[ANALYST_TYPES.ONCHAIN],
    [ANALYST_TYPES.MARKET_FLOW]:
      (isStock ? (profile?.marketFlow ?? fallback.marketFlow ?? BASE_LUNA_ANALYST_WEIGHTS[ANALYST_TYPES.MARKET_FLOW]) : 0),
    [ANALYST_TYPES.SENTINEL]: sentinelBase,
    [ANALYST_TYPES.SENTIMENT]: profile?.sentiment ?? fallback.sentiment ?? BASE_LUNA_ANALYST_WEIGHTS[ANALYST_TYPES.SENTIMENT],
    [ANALYST_TYPES.NEWS]: profile?.news ?? fallback.news ?? BASE_LUNA_ANALYST_WEIGHTS[ANALYST_TYPES.NEWS],
  });
}

export function buildRegimeAnalystBias(marketRegime = null) {
  const guide = resolveRegimeGuide(marketRegime);
  const agentWeights = guide?.agentWeights || {};
  const buckets = {};

  for (const [agentName, rawWeight] of Object.entries(agentWeights)) {
    const analystTypes = REGIME_AGENT_ANALYST_MAP[agentName] || [];
    const weight = finiteNumber(rawWeight, null);
    if (weight == null) continue;
    for (const analystType of analystTypes) {
      if (!buckets[analystType]) buckets[analystType] = [];
      buckets[analystType].push(weight);
    }
  }

  const bias = {};
  for (const [analystType, values] of Object.entries(buckets)) {
    const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    // Regime guide는 방향성 힌트로만 쓰고, 정확도 기반 가중치가 과도하게 뒤집히지 않도록 감쇠한다.
    bias[analystType] = Number((1 + ((clamp(avg, 0.7, 1.35) - 1) * 0.35)).toFixed(4));
  }
  return bias;
}

export function applyRegimeBiasToAnalystWeights(baseWeights = {}, marketRegime = null) {
  const bias = buildRegimeAnalystBias(marketRegime);
  if (Object.keys(bias).length === 0) return normalizeWeights(baseWeights);

  const next = { ...baseWeights };
  for (const [analystType, multiplier] of Object.entries(bias)) {
    const current = finiteNumber(next[analystType], 0);
    if (!(current > 0)) continue;
    next[analystType] = current * multiplier;
  }

  return normalizeWeights(next);
}

export function buildLunaAnalystWeights(exchange = 'binance', options = {}) {
  const baseWeights = buildLunaBaseAnalystWeights(exchange, options);
  return applyRegimeBiasToAnalystWeights(baseWeights, options.marketRegime || null);
}
