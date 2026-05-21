#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import * as db from '../shared/db.ts';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.ts';
import {
  buildAnalystWeights,
  fuseSignals,
  getMinConfidence,
} from '../shared/luna-decision-policy.ts';
import {
  getStockFlowDecisionPrefilterConfidence,
  getStockTaDecisionPrefilterConfidence,
  isStockIntradayEnrichmentEnabled,
  shouldRunStockIntradayDecisionLlm,
} from '../shared/stock-intraday-llm-policy.ts';
import {
  evaluateConservativeRelaxation,
  extractCryptoTechnicalEvidence,
} from '../shared/luna-conservative-relaxation-policy.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildDiscoveryUniverse } from '../team/discovery/discovery-universe.ts';
import { investmentOpsRuntimeFile } from '../shared/runtime-ops-path.ts';

const DEFAULT_HOURS = 2;
const STOCK_EXCHANGES = new Set(['kis', 'kis_overseas']);
const TECHNICAL_ANALYSTS = new Set([ANALYST_TYPES.TA_MTF, ANALYST_TYPES.TA]);
const NEWS_LIKE_ANALYSTS = new Set([ANALYST_TYPES.NEWS, ANALYST_TYPES.SENTINEL]);
const DEFAULT_DAILY_BULLISH_PROBE_MIN_INTRADAY_CONFIDENCE = 0.18;
const DEFAULT_CRYPTO_MTF_PRESIGNAL_WEIGHTED_SCORE = 0.45;
const DEFAULT_CRYPTO_MTF_PRESIGNAL_MIN_BUY_FRAMES = 1;
const DEFAULT_KIS_DAILY_TA_CACHE_MINUTES = 12 * 60;

function numEnv(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const symbolArg = argv.find((arg) => arg.startsWith('--symbols='))?.split('=').slice(1).join('=') || '';
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'crypto';
  const defaultExchange = market === 'overseas' ? 'kis_overseas' : market === 'domestic' ? 'kis' : 'binance';
  return {
    json: argv.includes('--json'),
    activeCandidates: argv.includes('--active-candidates'),
    market,
    exchange: argv.find((arg) => arg.startsWith('--exchange='))?.split('=')[1] || defaultExchange,
    hours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--hours='))?.split('=')[1] || DEFAULT_HOURS) || DEFAULT_HOURS),
    limit: Math.max(1, Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 12) || 12),
    symbols: symbolArg
      .split(',')
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean),
  };
}

function normalizeCandidateSymbol(symbol, market = 'crypto') {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return raw;
  if (market === 'crypto' && !raw.includes('/') && raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  return raw;
}

function dailyTechnicalCachePath(exchange = 'kis') {
  return investmentOpsRuntimeFile(`luna-discovery-daily-technical-cache-${exchange}.json`);
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadDailyTechnicalRowsFromCache({ exchange = 'kis', symbols = [], env = process.env } = {}) {
  if (!STOCK_EXCHANGES.has(exchange)) return {};
  const payload = readJsonSafe(dailyTechnicalCachePath(exchange), {});
  const items = payload?.items && typeof payload.items === 'object' ? payload.items : {};
  const ttlMinutes = Math.max(1, Number(env?.LUNA_KIS_DAILY_TA_CACHE_MINUTES || DEFAULT_KIS_DAILY_TA_CACHE_MINUTES) || DEFAULT_KIS_DAILY_TA_CACHE_MINUTES);
  const now = Date.now();
  const bySymbol = {};
  for (const symbol of symbols || []) {
    const normalized = normalizeCandidateSymbol(symbol, exchange === 'kis' ? 'domestic' : 'overseas');
    const item = items[`${exchange}:${normalized}`];
    const cachedAt = Date.parse(item?.cachedAt || 0) || 0;
    if (!item?.row || !cachedAt || now - cachedAt > ttlMinutes * 60 * 1000) continue;
    bySymbol[normalized] = {
      ...item.row,
      cached: true,
      cachedAt: item.cachedAt,
      cacheAgeMinutes: Number(((now - cachedAt) / 60000).toFixed(2)),
    };
  }
  return bySymbol;
}

async function loadOpenCandidateSymbols({ exchange = 'binance', market = 'crypto' } = {}) {
  const rows = await db.getOpenPositions(exchange, false).catch(() => []);
  return new Set((rows || [])
    .map((row) => normalizeCandidateSymbol(row?.symbol, market))
    .filter(Boolean));
}

function getLiveFireMaxOpenPositions(env = process.env) {
  const value = Number(env?.LUNA_LIVE_FIRE_MAX_OPEN || env?.LUNA_MAX_OPEN_POSITIONS);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return 2;
}

function normalizeAction(value) {
  const action = String(value || ACTIONS.HOLD).trim().toUpperCase();
  if (action === ACTIONS.BUY || action === ACTIONS.SELL || action === ACTIONS.HOLD) return action;
  if (action === 'LONG') return ACTIONS.BUY;
  if (action === 'SHORT') return ACTIONS.SELL;
  return ACTIONS.HOLD;
}

function normalizeAnalysis(row = {}) {
  return {
    ...row,
    symbol: String(row.symbol || '').trim().toUpperCase(),
    analyst: String(row.analyst || '').trim(),
    signal: normalizeAction(row.signal),
    confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0.5))),
    reasoning: row.reasoning || '',
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    created_at: row.created_at || row.createdAt || null,
  };
}

function latestByAnalyst(analyses = []) {
  const byAnalyst = new Map();
  for (const analysis of analyses.map(normalizeAnalysis)) {
    if (!analysis.symbol || !analysis.analyst) continue;
    if (!byAnalyst.has(analysis.analyst)) {
      byAnalyst.set(analysis.analyst, analysis);
      continue;
    }
    const prev = byAnalyst.get(analysis.analyst);
    const prevTime = Date.parse(prev?.created_at || 0) || 0;
    const nextTime = Date.parse(analysis?.created_at || 0) || 0;
    if (nextTime >= prevTime) byAnalyst.set(analysis.analyst, analysis);
  }
  return [...byAnalyst.values()];
}

function appendDailyTechnicalPresignals(analyses = [], { exchange, dailyTechnicalBySymbol = {}, env = process.env } = {}) {
  if (!STOCK_EXCHANGES.has(exchange)) return analyses;
  const grouped = new Map();
  for (const analysis of analyses || []) {
    const normalized = normalizeAnalysis(analysis);
    if (!normalized.symbol) continue;
    if (!grouped.has(normalized.symbol)) grouped.set(normalized.symbol, []);
    grouped.get(normalized.symbol).push(normalized);
  }
  for (const [symbol, rows] of grouped.entries()) {
    const hasTechnical = rows.some((row) => TECHNICAL_ANALYSTS.has(row.analyst));
    const daily = dailyTechnicalBySymbol?.[symbol];
    if (hasTechnical || daily?.ok !== true) continue;
    rows.push(normalizeAnalysis({
      symbol,
      analyst: ANALYST_TYPES.TA_MTF,
      signal: ACTIONS.BUY,
      confidence: Math.max(getStockTaDecisionPrefilterConfidence(env), 0.35),
      reasoning: `[KIS 일봉] ${daily.reason || 'kis_daily_chart_bullish'}; source=${daily.source || 'kis_daily_price'}`,
      metadata: {
        synthetic_daily_technical: true,
        source: daily.source || null,
        providerMode: daily.providerMode || null,
        cachedAt: daily.cachedAt || null,
      },
      exchange,
      created_at: daily.cachedAt || new Date().toISOString(),
    }));
  }
  return [...grouped.values()].flat();
}

function findAnalyst(analyses, candidates) {
  const candidateSet = new Set(candidates);
  return analyses.find((analysis) => candidateSet.has(analysis.analyst)) || null;
}

function summarizeAnalysts(analyses = []) {
  const bySignal = { BUY: 0, HOLD: 0, SELL: 0 };
  const byAnalyst = {};
  for (const analysis of analyses) {
    bySignal[analysis.signal] = (bySignal[analysis.signal] || 0) + 1;
    byAnalyst[analysis.analyst] = {
      signal: analysis.signal,
      confidence: analysis.confidence,
      reasoning: String(analysis.reasoning || '').slice(0, 180),
    };
  }
  return { bySignal, byAnalyst };
}

function hasCryptoMtfTechnicalPresignal(analyses = [], env = process.env) {
  const evidence = extractCryptoTechnicalEvidence(analyses);
  const weightedFloor = numEnv(env, 'LUNA_CRYPTO_TA_MTF_PRESIGNAL_WEIGHTED_SCORE', DEFAULT_CRYPTO_MTF_PRESIGNAL_WEIGHTED_SCORE);
  const minBuyFrames = Math.max(
    1,
    Math.round(numEnv(env, 'LUNA_CRYPTO_TA_MTF_PRESIGNAL_MIN_BUY_FRAMES', DEFAULT_CRYPTO_MTF_PRESIGNAL_MIN_BUY_FRAMES)),
  );
  const buyFrames = Number(evidence.intradayBuyFrames || 0) + Number(evidence.dailyBuyFrames || 0);
  const hasSellConflict = Number(evidence.intradaySellFrames || 0) > 0 || Number(evidence.dailySellFrames || 0) > 0;
  return evidence.weightedScore != null
    && Number(evidence.weightedScore) >= weightedFloor
    && buyFrames >= minBuyFrames
    && !hasSellConflict;
}

function hasExplicitDailyTechnicalBearishBlock(row = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  if (row.ok === true) return false;
  const reason = String(row.reason || '').toLowerCase();
  return reason.includes('not_bullish') || reason.includes('not_confirmed');
}

function buildFilterReasons(analyses, fused, { exchange, minConfidence, dailyTechnical = null, env = process.env }) {
  const reasons = [];
  const buyAnalysts = analyses.filter((analysis) => analysis.signal === ACTIONS.BUY);
  const sellAnalysts = analyses.filter((analysis) => analysis.signal === ACTIONS.SELL);
  const technical = findAnalyst(analyses, [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.TA]);
  const sentiment = findAnalyst(analyses, [ANALYST_TYPES.SENTIMENT, ANALYST_TYPES.SENTINEL]);
  const onchain = findAnalyst(analyses, [ANALYST_TYPES.ONCHAIN]);
  const marketFlow = findAnalyst(analyses, [ANALYST_TYPES.MARKET_FLOW]);
  const hasNewsOnlyBuy = buyAnalysts.length > 0 && buyAnalysts.every((analysis) => NEWS_LIKE_ANALYSTS.has(analysis.analyst));
  const stockDecisionPrefilter = STOCK_EXCHANGES.has(exchange)
    ? shouldRunStockIntradayDecisionLlm({ market: exchange, analyses })
    : null;
  const stockMissingSentimentAllowed = STOCK_EXCHANGES.has(exchange)
    && !sentiment
    && (!isStockIntradayEnrichmentEnabled(env) || stockDecisionPrefilter?.run === true);

  if (analyses.length < 2) reasons.push('insufficient_analyst_coverage');
  if (fused.recommendation !== 'LONG') reasons.push('fusion_not_long');
  if (Number(fused.averageConfidence || 0) < minConfidence) reasons.push('average_confidence_below_min');
  if (fused.hasConflict || sellAnalysts.length > 0) reasons.push('conflict_detected');
  const technicalConfirmed = technical?.signal === ACTIONS.BUY
    || (exchange === 'binance' && hasCryptoMtfTechnicalPresignal(analyses, env));
  if (!technicalConfirmed) reasons.push('technical_not_confirmed');
  if (exchange === 'binance' && (!onchain || onchain.signal !== ACTIONS.BUY)) reasons.push('onchain_not_confirmed');
  const stockFlowConfirmed = !STOCK_EXCHANGES.has(exchange)
    || !marketFlow
    || (marketFlow.signal === ACTIONS.BUY && Number(marketFlow.confidence || 0) >= getStockFlowDecisionPrefilterConfidence(env));
  if (STOCK_EXCHANGES.has(exchange) && marketFlow && !stockFlowConfirmed) reasons.push('market_flow_not_confirmed');
  if (STOCK_EXCHANGES.has(exchange) && hasExplicitDailyTechnicalBearishBlock(dailyTechnical)) reasons.push('daily_technical_not_confirmed');
  if (
    (!sentiment && !stockMissingSentimentAllowed)
    || (sentiment && sentiment.signal === ACTIONS.SELL)
    || (sentiment && !STOCK_EXCHANGES.has(exchange) && sentiment.signal !== ACTIONS.BUY)
  ) {
    reasons.push('sentiment_not_confirmed');
  }
  if (hasNewsOnlyBuy) reasons.push('news_only_buy');

  return [...new Set(reasons)];
}

function buildRecommendation(reasons = []) {
  if (reasons.includes('news_only_buy')) return 'wait_for_technical_and_flow_confirmation';
  if (reasons.includes('daily_technical_not_confirmed')) return 'wait_for_daily_technical_confirmation';
  if (reasons.includes('technical_not_confirmed')) return 'wait_for_trend_confirmation';
  if (reasons.includes('onchain_not_confirmed')) return 'wait_for_onchain_confirmation';
  if (reasons.includes('market_flow_not_confirmed')) return 'wait_for_market_flow_confirmation';
  if (reasons.includes('average_confidence_below_min')) return 'keep_threshold_and_collect_more_evidence';
  if (reasons.includes('conflict_detected')) return 'send_to_debate_or_hold';
  if (reasons.includes('insufficient_analyst_coverage')) return 'collect_missing_analysts';
  return 'eligible_for_signal_persistence_review';
}

function analystSignal(item, analysts = []) {
  for (const analyst of analysts) {
    const signal = item?.analystSummary?.byAnalyst?.[analyst]?.signal;
    if (signal) return signal;
  }
  return null;
}

function analystConfidence(item, analysts = []) {
  for (const analyst of analysts) {
    const value = item?.analystSummary?.byAnalyst?.[analyst]?.confidence;
    if (value != null && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function hasAnalystEvidence(item, analysts = []) {
  return Boolean(analystSignal(item, analysts));
}

function hasDailyBullishPresignal(item = {}) {
  const row = item?.dailyTechnical || item?.dailyTechnicalCoverage || null;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const reason = String(row.reason || '').toLowerCase();
  return row.ok === true || reason.includes('daily_trend_bullish');
}

function activeCandidateConfidence(item = {}) {
  const candidate = item?.activeCandidate || {};
  return Math.max(
    0,
    Number(candidate.score || 0),
    Number(candidate.confidence || 0),
  );
}

function dailyBullishProbeHasIntradayFloor(item = {}) {
  const technicalSignal = analystSignal(item, [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.TA]);
  if (!technicalSignal) return true;
  if (technicalSignal === ACTIONS.BUY) return true;
  if (technicalSignal === ACTIONS.SELL) return false;
  const confidence = analystConfidence(item, [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.TA]);
  const minConfidence = Math.max(
    0,
    Number(process.env.LUNA_DAILY_BULLISH_PROBE_MIN_INTRADAY_CONFIDENCE || DEFAULT_DAILY_BULLISH_PROBE_MIN_INTRADAY_CONFIDENCE),
  );
  return confidence == null || confidence >= minConfidence;
}

function isDailyBullishProbeCandidate(item = {}) {
  if (item.exchange !== 'binance') return false;
  if (!hasDailyBullishPresignal(item)) return false;
  if (!dailyBullishProbeHasIntradayFloor(item)) return false;
  const candidate = item?.activeCandidate || {};
  const rank = Number(candidate.rank || 999999);
  const confidence = activeCandidateConfidence(item);
  return rank >= 1 && rank <= 10 && confidence >= 0.55;
}

function isStockDailyBullishProbeCandidate(item = {}) {
  if (!STOCK_EXCHANGES.has(item.exchange)) return false;
  if (!hasDailyBullishPresignal(item)) return false;
  const candidate = item?.activeCandidate || {};
  const rank = Number(candidate.rank || 999999);
  const confidence = activeCandidateConfidence(item);
  return rank >= 1 && rank <= 12 && confidence >= 0.7;
}

export function promoteStockDailyBullishActiveCandidateProbe(item = {}, env = process.env) {
  if (item.actionability !== 'filtered_before_signal') return item;
  if (!isStockDailyBullishProbeCandidate(item)) return item;
  const reasons = new Set(item.reasons || []);
  if (reasons.has('conflict_detected') || reasons.has('news_only_buy')) return item;
  const fused = item.fused || {};
  const candidate = item.activeCandidate || {};
  const minFusedScore = Number(env?.LUNA_STOCK_DAILY_BULLISH_PROBE_MIN_FUSED_SCORE ?? -0.12);
  const minAverageConfidence = Number(env?.LUNA_STOCK_DAILY_BULLISH_PROBE_MIN_AVG_CONFIDENCE ?? 0.12);
  const fusedScore = Number(fused.fusedScore || 0);
  const averageConfidence = Number(fused.averageConfidence || 0);
  if (Number.isFinite(minFusedScore) && fusedScore < minFusedScore) return item;
  if (Number.isFinite(minAverageConfidence) && averageConfidence < minAverageConfidence) return item;

  return {
    ...item,
    actionability: 'relaxed_probe_candidate',
    recommendation: 'run_l13_probe_with_reduced_sizing',
    relaxation: {
      enabled: true,
      ok: true,
      marketType: 'stock',
      reason: 'stock_daily_bullish_active_candidate_probe',
      sizeRatio: 0.25,
      summary: {
        source: 'daily_bullish_active_candidate',
        activeCandidateRank: Number(candidate.rank || 0) || null,
        activeCandidateConfidence: activeCandidateConfidence(item),
        dailyTechnical: item.dailyTechnical || item.dailyTechnicalCoverage || null,
      },
      fused,
    },
  };
}

export function promoteCryptoDailyBullishActiveCandidateProbe(item = {}, env = process.env) {
  if (item.actionability !== 'filtered_before_signal') return item;
  if (!isDailyBullishProbeCandidate(item)) return item;
  const reasons = new Set(item.reasons || []);
  if (reasons.has('conflict_detected') || reasons.has('news_only_buy')) return item;
  const fused = item.fused || {};
  const candidate = item.activeCandidate || {};
  const minFusedScore = Number(env?.LUNA_CRYPTO_DAILY_BULLISH_PROBE_MIN_FUSED_SCORE ?? -0.08);
  const minAverageConfidence = Number(env?.LUNA_CRYPTO_DAILY_BULLISH_PROBE_MIN_AVG_CONFIDENCE ?? 0.18);
  const fusedScore = Number(fused.fusedScore || 0);
  const averageConfidence = Number(fused.averageConfidence || 0);
  if (Number.isFinite(minFusedScore) && fusedScore < minFusedScore) return item;
  if (Number.isFinite(minAverageConfidence) && averageConfidence < minAverageConfidence) return item;

  return {
    ...item,
    actionability: 'relaxed_probe_candidate',
    recommendation: 'run_l13_probe_with_reduced_sizing',
    relaxation: {
      enabled: true,
      ok: true,
      marketType: 'crypto',
      reason: 'crypto_daily_bullish_active_candidate_probe',
      sizeRatio: 0.25,
      summary: {
        source: 'daily_bullish_active_candidate',
        activeCandidateRank: Number(candidate.rank || 0) || null,
        activeCandidateConfidence: activeCandidateConfidence(item),
        dailyTechnical: item.dailyTechnical || item.dailyTechnicalCoverage || null,
      },
      fused,
    },
  };
}

export function buildNearMissWatchCandidate(item = {}) {
  if (item.actionability === 'likely_actionable') return null;
  const reasons = new Set(item.reasons || []);
  const dailyBullishProbeCandidate = isDailyBullishProbeCandidate(item);
  const stockDailyBullishProbeCandidate = isStockDailyBullishProbeCandidate(item);
  if (item.actionability === 'relaxed_probe_candidate' && item.relaxation?.ok === true) {
    const missingConfirmations = [];
    if (reasons.has('technical_not_confirmed')) missingConfirmations.push('technical');
    if (reasons.has('onchain_not_confirmed') && !hasAnalystEvidence(item, [ANALYST_TYPES.ONCHAIN])) missingConfirmations.push('onchain');
    if (reasons.has('sentiment_not_confirmed') && !hasAnalystEvidence(item, [ANALYST_TYPES.SENTIMENT, ANALYST_TYPES.SENTINEL])) missingConfirmations.push('sentiment');
    if (
      reasons.has('market_flow_not_confirmed')
      && (STOCK_EXCHANGES.has(item.exchange) || !hasAnalystEvidence(item, [ANALYST_TYPES.MARKET_FLOW]))
    ) {
      missingConfirmations.push('market_flow');
    }
    if (reasons.has('daily_technical_not_confirmed')) missingConfirmations.push('daily_technical');
    if (reasons.has('average_confidence_below_min')) missingConfirmations.push('confidence');
    if (reasons.has('fusion_not_long')) missingConfirmations.push('fusion');
    return {
      symbol: item.symbol,
      exchange: item.exchange,
      readiness: 'relaxed_probe_watch',
      watchReason: item.relaxation.reason || 'conservative_policy_relaxed_probe',
      missingConfirmations,
      nextAction: 'run_l13_probe_with_existing_risk_and_entry_guards',
      fused: item.fused,
      analystSummary: item.analystSummary,
      recommendation: item.recommendation,
      relaxation: item.relaxation,
    };
  }
  const technicalSignal = analystSignal(item, [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.TA]);
  const hardStopReasons = [
    'conflict_detected',
    'news_only_buy',
  ];
  if (!dailyBullishProbeCandidate && !stockDailyBullishProbeCandidate) {
    hardStopReasons.push('insufficient_analyst_coverage', 'technical_not_confirmed');
  }
  if (hardStopReasons.some((reason) => reasons.has(reason))) return null;
  if (technicalSignal !== ACTIONS.BUY && !dailyBullishProbeCandidate && !stockDailyBullishProbeCandidate) return null;
  const confidenceFloor = STOCK_EXCHANGES.has(item.exchange) ? 0.35 : 0.38;
  const effectiveConfidence = dailyBullishProbeCandidate || stockDailyBullishProbeCandidate
    ? Math.max(Number(item?.fused?.averageConfidence || 0), activeCandidateConfidence(item))
    : Number(item?.fused?.averageConfidence || 0);
  if (effectiveConfidence < Math.max(confidenceFloor, Number(item?.minConfidence || 0.5) * 0.72)) return null;

  const missingConfirmations = [];
  if (dailyBullishProbeCandidate && technicalSignal !== ACTIONS.BUY) missingConfirmations.push('intraday_technical');
  if (reasons.has('onchain_not_confirmed') && !hasAnalystEvidence(item, [ANALYST_TYPES.ONCHAIN])) missingConfirmations.push('onchain');
  if (reasons.has('sentiment_not_confirmed') && !hasAnalystEvidence(item, [ANALYST_TYPES.SENTIMENT, ANALYST_TYPES.SENTINEL])) missingConfirmations.push('sentiment');
  if (
    reasons.has('market_flow_not_confirmed')
    && (stockDailyBullishProbeCandidate || !hasAnalystEvidence(item, [ANALYST_TYPES.MARKET_FLOW]))
  ) {
    missingConfirmations.push('market_flow');
  }
  if (reasons.has('daily_technical_not_confirmed')) missingConfirmations.push('daily_technical');
  if (reasons.has('average_confidence_below_min')) missingConfirmations.push('confidence');
  if (reasons.has('fusion_not_long')) missingConfirmations.push('fusion');
  if (missingConfirmations.length === 0) return null;
  const dailyTechnicalBlocked = reasons.has('daily_technical_not_confirmed');

  return {
    symbol: item.symbol,
    exchange: item.exchange,
    readiness: dailyBullishProbeCandidate || stockDailyBullishProbeCandidate ? 'relaxed_probe_watch' : 'near_miss_watch',
    watchReason: dailyTechnicalBlocked
      ? 'stock_daily_technical_not_confirmed'
      : dailyBullishProbeCandidate
      ? 'daily_bullish_active_candidate_probe'
      : stockDailyBullishProbeCandidate
        ? 'stock_daily_bullish_active_candidate_probe'
        : missingConfirmations.includes('onchain')
      ? 'technical_and_sentiment_buy_waiting_onchain'
      : missingConfirmations.includes('sentiment')
        ? 'technical_buy_waiting_sentiment'
        : 'technical_buy_waiting_fusion_quality',
    missingConfirmations,
    nextAction: dailyTechnicalBlocked
      ? 'wait_for_daily_technical_confirmation_before_signal_persistence'
      : dailyBullishProbeCandidate
      ? 'run_l13_probe_with_existing_risk_and_entry_guards'
      : stockDailyBullishProbeCandidate
        ? 'refresh_market_flow_then_l13_probe_with_existing_guards'
        : missingConfirmations.includes('onchain')
      ? 'refresh_onchain_and_keep_tradingview_daily_guard'
      : 'refresh_missing_confirmation_before_signal_persistence',
    fused: item.fused,
    analystSummary: item.analystSummary,
    recommendation: item.recommendation,
    dailyTechnical: dailyBullishProbeCandidate || stockDailyBullishProbeCandidate || dailyTechnicalBlocked
      ? (item.dailyTechnical || item.dailyTechnicalCoverage || null)
      : null,
  };
}

export function buildDecisionFilterDiagnostics(analysisRows = [], options = {}) {
  const exchange = options.exchange || 'binance';
  const weights = options.weights || buildAnalystWeights(exchange, options);
  const minConfidence = Number(options.minConfidence ?? getMinConfidence(exchange));
  const enrichedRows = appendDailyTechnicalPresignals(analysisRows, {
    exchange,
    dailyTechnicalBySymbol: options.dailyTechnicalBySymbol || {},
    env: options.env || process.env,
  });
  const grouped = new Map();
  for (const row of enrichedRows || []) {
    const analysis = normalizeAnalysis(row);
    if (!analysis.symbol) continue;
    if (!grouped.has(analysis.symbol)) grouped.set(analysis.symbol, []);
    grouped.get(analysis.symbol).push(analysis);
  }

  const diagnostics = [];
  for (const [symbol, rows] of grouped.entries()) {
    const analyses = latestByAnalyst(rows);
    const fused = fuseSignals(analyses, weights);
    const dailyTechnical = options.dailyTechnicalBySymbol?.[symbol] || null;
    const reasons = buildFilterReasons(analyses, fused, {
      exchange,
      minConfidence,
      dailyTechnical,
      env: options.env || process.env,
    });
    const relaxationBypassed = reasons.includes('daily_technical_not_confirmed');
    const relaxation = reasons.length > 0 && !relaxationBypassed
      ? evaluateConservativeRelaxation({ exchange, analyses, fused, env: options.env || process.env })
      : { ok: false, reason: 'strict_actionable' };
    const actionability = reasons.length === 0
      ? 'likely_actionable'
      : relaxation.ok
        ? 'relaxed_probe_candidate'
        : 'filtered_before_signal';
    const analystSummary = summarizeAnalysts(analyses);
    diagnostics.push({
      symbol,
      exchange,
      actionability,
      recommendation: actionability === 'relaxed_probe_candidate'
        ? 'run_l13_probe_with_reduced_sizing'
        : buildRecommendation(reasons),
      reasons,
      relaxation: relaxation.ok ? relaxation : null,
      minConfidence,
      fused: {
        recommendation: fused.recommendation,
        fusedScore: Number(Number(fused.fusedScore || 0).toFixed(4)),
        averageConfidence: Number(Number(fused.averageConfidence || 0).toFixed(4)),
        hasConflict: fused.hasConflict === true,
      },
      analystCount: analyses.length,
      analystSummary,
      dailyTechnical,
      latestAt: analyses
        .map((analysis) => analysis.created_at)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    });
  }

  diagnostics.sort((a, b) => {
    const actionabilityScore = (item) => item.actionability === 'likely_actionable' ? 2 : item.actionability === 'relaxed_probe_candidate' ? 1 : 0;
    return (actionabilityScore(b) - actionabilityScore(a))
      || (Number(b.fused.fusedScore || 0) - Number(a.fused.fusedScore || 0))
      || (Number(b.fused.averageConfidence || 0) - Number(a.fused.averageConfidence || 0));
  });

  return diagnostics;
}

async function queryRecentAnalysis({ exchange, hours, symbols }) {
  const symbolFilter = symbols.length > 0 ? 'AND symbol = ANY($3::text[])' : '';
  const params = symbols.length > 0 ? [exchange, hours, symbols] : [exchange, hours];
  return db.query(
    `SELECT symbol, analyst, signal, confidence, reasoning, metadata, exchange, created_at
     FROM analysis
     WHERE exchange = $1
       AND created_at >= now() - ($2::int * INTERVAL '1 hour')
       ${symbolFilter}
     ORDER BY created_at DESC`,
    params,
  ).catch(() => []);
}

async function queryActiveCandidateUniverse({ market, limit, binanceTopVolumeUniverse = null } = {}) {
  const universe = await buildDiscoveryUniverse(market, new Date(), {
    refresh: false,
    fallbackSymbols: [],
    preferCandidates: true,
    limit: Math.max(1, Number(limit || 50)),
    ...(binanceTopVolumeUniverse ? { binanceTopVolumeUniverse } : {}),
  }).catch(() => null);
  const candidates = Array.isArray(universe?.candidates) ? universe.candidates : [];
  const candidateMeta = {};
  let rank = 0;
  for (const candidate of candidates) {
    const symbol = normalizeCandidateSymbol(candidate.symbol, market);
    if (!symbol || candidateMeta[symbol]) continue;
    rank += 1;
    candidateMeta[symbol] = {
      rank,
      score: Number(candidate.score || 0),
      confidence: Number(candidate.confidence ?? candidate.score ?? 0),
      source: candidate.source || null,
      reasonCode: candidate.reasonCode || candidate.reason_code || null,
      discoveredAt: candidate.discoveredAt || candidate.discovered_at || null,
    };
  }
  const symbols = [...new Set((universe?.symbols || [])
    .map((symbol) => normalizeCandidateSymbol(symbol, market))
    .filter(Boolean))];
  return { symbols, candidateMeta };
}

export async function buildLunaDecisionFilterReport(options = {}) {
  const requestedMarket = options.market || null;
  const defaultExchange = requestedMarket === 'overseas' ? 'kis_overseas' : requestedMarket === 'domestic' ? 'kis' : 'binance';
  const exchange = options.exchange || defaultExchange;
  const market = requestedMarket || (exchange === 'kis' ? 'domestic' : exchange === 'kis_overseas' ? 'overseas' : 'crypto');
  const hours = Math.max(1, Number(options.hours || DEFAULT_HOURS));
  const limit = Math.max(1, Number(options.limit || 12));
  await db.initSchema();
  const excludeOpenPositions = options.excludeOpenPositions !== false;
  const openPositionSymbols = excludeOpenPositions
    ? Array.isArray(options.openPositionSymbols)
      ? new Set(options.openPositionSymbols.map((symbol) => normalizeCandidateSymbol(symbol, market)).filter(Boolean))
      : await loadOpenCandidateSymbols({ exchange, market })
    : new Set();
  const activeUniverse = options.activeCandidates
    ? await queryActiveCandidateUniverse({ market, limit, binanceTopVolumeUniverse: options.binanceTopVolumeUniverse || null })
    : { symbols: [], candidateMeta: {} };
  const rawCandidateSymbols = activeUniverse.symbols || [];
  const excludedOpenPositionSymbols = rawCandidateSymbols.filter((symbol) => openPositionSymbols.has(symbol));
  const candidateSymbols = rawCandidateSymbols.filter((symbol) => !openPositionSymbols.has(symbol));
  const requestedSymbols = (Array.isArray(options.symbols) ? options.symbols : [])
    .map((symbol) => normalizeCandidateSymbol(symbol, market))
    .filter((symbol) => !openPositionSymbols.has(symbol));
  const maxOpenPositions = getLiveFireMaxOpenPositions();
  const rows = await queryRecentAnalysis({
    exchange,
    hours,
    symbols: candidateSymbols.length > 0 ? candidateSymbols : requestedSymbols,
  });
  const dailyTechnicalBySymbol = STOCK_EXCHANGES.has(exchange) && options.activeCandidates
    ? loadDailyTechnicalRowsFromCache({
      exchange,
      symbols: candidateSymbols.length > 0 ? candidateSymbols : requestedSymbols,
      env: options.env || process.env,
    })
    : {};
  const diagnostics = buildDecisionFilterDiagnostics(rows, {
    exchange,
    minConfidence: options.minConfidence,
    env: options.env || process.env,
    dailyTechnicalBySymbol,
  })
    .filter((item) => !openPositionSymbols.has(normalizeCandidateSymbol(item.symbol, market)))
    .map((item) => activeUniverse.candidateMeta?.[item.symbol]
    ? { ...item, activeCandidate: activeUniverse.candidateMeta[item.symbol] }
    : item)
    .map((item) => promoteCryptoDailyBullishActiveCandidateProbe(item, options.env || process.env))
    .map((item) => promoteStockDailyBullishActiveCandidateProbe(item, options.env || process.env));
  const checkedSymbolSet = new Set(diagnostics.map((item) => item.symbol));
  const missingActiveCandidateSymbols = candidateSymbols.filter((symbol) => !checkedSymbolSet.has(symbol));
  const filtered = diagnostics.filter((item) => item.actionability !== 'likely_actionable');
  const likelyActionable = diagnostics.filter((item) => item.actionability === 'likely_actionable');
  const relaxedProbeCandidates = diagnostics.filter((item) => item.actionability === 'relaxed_probe_candidate');
  const nearMissWatchlist = filtered
    .map(buildNearMissWatchCandidate)
    .filter(Boolean)
    .slice(0, limit);
  const reasonCounts = {};
  for (const item of filtered) {
    for (const reason of item.reasons || []) {
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  }
  if (missingActiveCandidateSymbols.length > 0) {
    reasonCounts.active_candidate_analysis_missing = missingActiveCandidateSymbols.length;
  }
  const bottlenecks = [];
  if (missingActiveCandidateSymbols.length > 0) bottlenecks.push('active_candidate_analysis_missing');
  if (filtered.length > 0 && diagnostics.length > 0) bottlenecks.push('active_candidates_filtered_before_signal');
  return {
    ok: true,
    status: bottlenecks.length > 0 ? 'luna_decision_filter_attention' : 'luna_decision_filter_clear',
    exchange,
    market,
    hours,
    symbolScope: candidateSymbols.length > 0 ? 'active_candidates' : requestedSymbols.length > 0 ? 'explicit_symbols' : 'recent_analysis',
    activeCandidateSymbols: candidateSymbols,
    activeCandidateCoverage: candidateSymbols.length > 0 ? {
      total: rawCandidateSymbols.length,
      checked: checkedSymbolSet.size,
      missing: missingActiveCandidateSymbols.length,
      excludedOpenPositions: excludedOpenPositionSymbols.length,
    } : null,
    dailyTechnicalCoverage: Object.keys(dailyTechnicalBySymbol).length > 0 ? {
      source: 'kis_daily_technical_cache',
      checkedCount: candidateSymbols.length || requestedSymbols.length,
      availableCount: Object.keys(dailyTechnicalBySymbol).length,
      bullishCount: Object.values(dailyTechnicalBySymbol).filter((row) => row?.ok === true).length,
    } : null,
    openPositionSymbols: [...openPositionSymbols],
    excludedOpenPositionSymbols,
    entryCapacity: {
      openCount: openPositionSymbols.size,
      maxOpenPositions,
      remainingSlots: Math.max(0, maxOpenPositions - openPositionSymbols.size),
      full: openPositionSymbols.size >= maxOpenPositions,
    },
    missingActiveCandidateSymbols,
    checkedSymbols: diagnostics.length,
    likelyActionableCount: likelyActionable.length,
    relaxedProbeCount: relaxedProbeCandidates.length,
    nearMissWatchCount: nearMissWatchlist.length,
    nearMissWatchlist,
    filteredCount: filtered.length,
    reasonCounts,
    bottlenecks,
    top: diagnostics.slice(0, limit),
    generatedAt: new Date().toISOString(),
  };
}

function renderText(report) {
  const lines = [
    `Luna decision filter report (${report.exchange}, ${report.hours}h, scope=${report.symbolScope || 'recent_analysis'})`,
    `status=${report.status} checked=${report.checkedSymbols} likely_actionable=${report.likelyActionableCount} relaxed_probe=${report.relaxedProbeCount || 0} filtered=${report.filteredCount}`,
    `reasons=${Object.entries(report.reasonCounts || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}`,
    '',
  ];
  for (const item of report.top || []) {
    lines.push(
      `- ${item.symbol}: ${item.actionability} fused=${item.fused.recommendation}/${item.fused.fusedScore} avg=${item.fused.averageConfidence} reasons=${item.reasons.join('|') || 'none'}`,
      `  recommendation=${item.recommendation}`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaDecisionFilterReport(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-decision-filter-report 실패:',
  });
}
