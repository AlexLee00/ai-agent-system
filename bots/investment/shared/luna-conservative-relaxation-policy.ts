// @ts-nocheck
import { ACTIONS } from './signal.ts';

const STOCK_EXCHANGES = new Set(['kis', 'kis_overseas']);
const CRYPTO_EXCHANGES = new Set(['binance', 'crypto']);

function envFlag(env, key, fallback = false) {
  const value = env?.[key];
  if (value == null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(text)) return false;
  return fallback;
}

function numEnv(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function normalizeAction(value) {
  const action = String(value || ACTIONS.HOLD).trim().toUpperCase();
  if (action === ACTIONS.BUY || action === ACTIONS.SELL || action === ACTIONS.HOLD) return action;
  if (action === 'LONG') return ACTIONS.BUY;
  if (action === 'SHORT') return ACTIONS.SELL;
  return ACTIONS.HOLD;
}

function roleFor(exchange, row = {}) {
  const analyst = String(row?.analyst || row?.metadata?.analyst || row?.source || '').trim().toLowerCase();
  if (['ta', 'ta_mtf', 'technical', 'multi_timeframe', 'mtf'].some((key) => analyst.includes(key))) return 'technical';
  if (STOCK_EXCHANGES.has(exchange) && ['market_flow', 'flow', 'orderbook', 'momentum'].some((key) => analyst.includes(key))) return 'flow';
  if (CRYPTO_EXCHANGES.has(exchange) && ['onchain', 'market_flow', 'flow', 'orderbook', 'funding'].some((key) => analyst.includes(key))) return 'flow';
  if (['sentiment', 'news', 'sentinel', 'hermes', 'sophia'].some((key) => analyst.includes(key))) return 'narrative';
  return 'other';
}

function simpleFused(analyses = []) {
  let scoreSum = 0;
  let confidenceSum = 0;
  let count = 0;
  let buy = 0;
  let sell = 0;

  for (const row of analyses || []) {
    const action = normalizeAction(row?.signal);
    const confidence = clamp(row?.confidence ?? 0.5, 0, 1);
    const direction = action === ACTIONS.BUY ? 1 : action === ACTIONS.SELL ? -1 : 0;
    scoreSum += direction * confidence;
    confidenceSum += confidence;
    count += 1;
    if (action === ACTIONS.BUY) buy += 1;
    if (action === ACTIONS.SELL) sell += 1;
  }

  const fusedScore = count > 0 ? scoreSum / count : 0;
  return {
    fusedScore,
    averageConfidence: count > 0 ? confidenceSum / count : 0,
    hasConflict: buy > 0 && sell > 0,
    recommendation: fusedScore > 0.2 ? 'LONG' : fusedScore < -0.2 ? 'SHORT' : 'HOLD',
  };
}

function summarize(exchange, analyses = []) {
  const summary = {
    analystCount: 0,
    buyCount: 0,
    sellCount: 0,
    holdCount: 0,
    technicalBuy: false,
    flowBuy: false,
    narrativeBuy: false,
    sellConflict: false,
    roles: {
      technical: { buy: 0, sell: 0, hold: 0, maxConfidence: 0 },
      flow: { buy: 0, sell: 0, hold: 0, maxConfidence: 0 },
      narrative: { buy: 0, sell: 0, hold: 0, maxConfidence: 0 },
      other: { buy: 0, sell: 0, hold: 0, maxConfidence: 0 },
    },
  };

  for (const row of analyses || []) {
    const action = normalizeAction(row?.signal);
    const role = roleFor(exchange, row);
    const confidence = clamp(row?.confidence ?? 0, 0, 1);
    summary.analystCount += 1;
    if (action === ACTIONS.BUY) summary.buyCount += 1;
    else if (action === ACTIONS.SELL) summary.sellCount += 1;
    else summary.holdCount += 1;

    const roleStats = summary.roles[role] || summary.roles.other;
    roleStats.maxConfidence = Math.max(roleStats.maxConfidence, confidence);
    if (action === ACTIONS.BUY) roleStats.buy += 1;
    else if (action === ACTIONS.SELL) roleStats.sell += 1;
    else roleStats.hold += 1;

    if (action === ACTIONS.BUY && role === 'technical') summary.technicalBuy = true;
    if (action === ACTIONS.BUY && role === 'flow') summary.flowBuy = true;
    if (action === ACTIONS.BUY && role === 'narrative') summary.narrativeBuy = true;
    if (action === ACTIONS.SELL && confidence >= 0.45) summary.sellConflict = true;
  }

  return summary;
}

export function isConservativeRelaxationEnabled(env = process.env) {
  return envFlag(env, 'LUNA_CONSERVATIVE_RELAXATION_ENABLED', true);
}

export function getConservativeRelaxationMaxPerCycle(env = process.env) {
  const raw = Math.round(numEnv(env, 'LUNA_CONSERVATIVE_RELAXATION_MAX_PER_CYCLE', 3));
  return Math.max(0, Math.min(20, raw));
}

export function evaluateConservativeRelaxation({
  exchange = 'binance',
  analyses = [],
  fused = null,
  env = process.env,
} = {}) {
  const normalizedExchange = String(exchange || 'binance').trim();
  const enabled = isConservativeRelaxationEnabled(env);
  const marketType = STOCK_EXCHANGES.has(normalizedExchange)
    ? 'stock'
    : CRYPTO_EXCHANGES.has(normalizedExchange)
      ? 'crypto'
      : 'other';
  const signalSummary = summarize(normalizedExchange, analyses);
  const fusion = fused || simpleFused(analyses);

  if (!enabled) {
    return { enabled, ok: false, marketType, reason: 'conservative_relaxation_disabled', summary: signalSummary, fused: fusion };
  }
  if (marketType === 'other') {
    return { enabled, ok: false, marketType, reason: 'unsupported_market', summary: signalSummary, fused: fusion };
  }
  if (signalSummary.analystCount < 3) {
    return { enabled, ok: false, marketType, reason: 'relaxation_insufficient_coverage', summary: signalSummary, fused: fusion };
  }
  if (signalSummary.sellConflict || fusion.hasConflict) {
    return { enabled, ok: false, marketType, reason: 'relaxation_sell_conflict', summary: signalSummary, fused: fusion };
  }
  if (signalSummary.buyCount <= 0) {
    return { enabled, ok: false, marketType, reason: 'relaxation_no_buy_signal', summary: signalSummary, fused: fusion };
  }

  const avg = Number(fusion.averageConfidence || 0);
  const score = Number(fusion.fusedScore || 0);
  const stockPrimary = signalSummary.technicalBuy || signalSummary.flowBuy;
  const cryptoPrimary = signalSummary.technicalBuy || signalSummary.flowBuy;

  if (marketType === 'stock') {
    const avgFloor = clamp(numEnv(env, 'LUNA_STOCK_RELAXED_PROBE_MIN_AVG_CONFIDENCE', 0.30), 0, 1);
    const scoreFloor = clamp(numEnv(env, 'LUNA_STOCK_RELAXED_PROBE_MIN_FUSED_SCORE', -0.04), -1, 1);
    const narrativeAvgFloor = clamp(numEnv(env, 'LUNA_STOCK_RELAXED_NARRATIVE_MIN_AVG_CONFIDENCE', 0.46), 0, 1);
    if (stockPrimary && avg >= avgFloor && score >= scoreFloor) {
      return {
        enabled,
        ok: true,
        marketType,
        reason: 'stock_relaxed_primary_probe',
        sizeRatio: 0.5,
        summary: signalSummary,
        fused: fusion,
      };
    }
    if (signalSummary.narrativeBuy && avg >= narrativeAvgFloor && score >= 0.03) {
      return {
        enabled,
        ok: true,
        marketType,
        reason: 'stock_relaxed_narrative_probe',
        sizeRatio: 0.35,
        summary: signalSummary,
        fused: fusion,
      };
    }
  }

  if (marketType === 'crypto') {
    const avgFloor = clamp(numEnv(env, 'LUNA_CRYPTO_RELAXED_PROBE_MIN_AVG_CONFIDENCE', 0.36), 0, 1);
    const scoreFloor = clamp(numEnv(env, 'LUNA_CRYPTO_RELAXED_PROBE_MIN_FUSED_SCORE', -0.06), -1, 1);
    const narrativeAvgFloor = clamp(numEnv(env, 'LUNA_CRYPTO_RELAXED_NARRATIVE_MIN_AVG_CONFIDENCE', 0.50), 0, 1);
    if (cryptoPrimary && avg >= avgFloor && score >= scoreFloor) {
      return {
        enabled,
        ok: true,
        marketType,
        reason: 'crypto_relaxed_primary_probe',
        sizeRatio: 0.45,
        summary: signalSummary,
        fused: fusion,
      };
    }
    if (signalSummary.narrativeBuy && avg >= narrativeAvgFloor && score >= 0.05) {
      return {
        enabled,
        ok: true,
        marketType,
        reason: 'crypto_relaxed_narrative_probe',
        sizeRatio: 0.3,
        summary: signalSummary,
        fused: fusion,
      };
    }
  }

  return {
    enabled,
    ok: false,
    marketType,
    reason: 'relaxation_conditions_not_met',
    summary: signalSummary,
    fused: fusion,
  };
}

export default {
  evaluateConservativeRelaxation,
  getConservativeRelaxationMaxPerCycle,
  isConservativeRelaxationEnabled,
};
