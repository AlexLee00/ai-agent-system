#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { investmentOpsRuntimeFile } from '../shared/runtime-ops-path.ts';
import { runMarketCollectPipeline } from '../shared/pipeline-market-runner.ts';
import { finishPipelineRun } from '../shared/pipeline-db.ts';
import { buildLunaDecisionFilterReport } from './runtime-luna-decision-filter-report.ts';
import { buildDailyTechnicalCoverage, buildLunaDiscoveryFunnelReport } from './runtime-luna-discovery-funnel-report.ts';
import { buildStockIntradayLlmPolicyMeta, isStockIntradayEnrichmentEnabled } from '../shared/stock-intraday-llm-policy.ts';
import { extractCryptoTechnicalEvidence } from '../shared/luna-conservative-relaxation-policy.ts';
import {
  evaluateBinanceTopVolumeUniverseGate,
  getCachedBinanceTopVolumeUniverse,
} from '../shared/binance-top-volume-universe.ts';

const CONFIRM = 'luna-active-candidate-analysis-refresh';
const DEFAULT_STATE_PATH = investmentOpsRuntimeFile('luna-active-candidate-analysis-refresh-state.json');
const DEFAULT_DECISION_FILTER_HOURS = 2;
const DEFAULT_REFRESH_MAX_SYMBOLS_BY_MARKET = Object.freeze({
  crypto: 2,
  domestic: 4,
  overseas: 4,
});
const DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS_BY_MARKET = Object.freeze({
  crypto: 1,
  domestic: 1,
  overseas: 1,
});
const DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS = 1;
const DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES = 120;
const DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE = 0.58;
const DEFAULT_TARGETED_ENRICHMENT_CANDIDATE_SCORE = 0.55;
const DEFAULT_TARGETED_ENRICHMENT_CANDIDATE_RANK = 10;
const DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES = 10;
const DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS = 0;
const DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_BYPASS_MAX_SYMBOLS = 1;
const DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_ENABLED = true;
const DEFAULT_CRYPTO_TARGETED_ENRICHMENT_REQUIRE_TECHNICAL_PRESIGNAL = true;
const DEFAULT_CRYPTO_TARGETED_ENRICHMENT_DAILY_TECHNICAL_ENABLED = true;
const DEFAULT_CRYPTO_MTF_PRESIGNAL_WEIGHTED_SCORE = 0.45;
const DEFAULT_CRYPTO_MTF_PRESIGNAL_MIN_BUY_FRAMES = 1;
const GLOBAL_TARGETED_ENRICHMENT_SYMBOL = '__global__';

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolEnv(name, fallback = true, env = process.env) {
  const raw = env[name];
  if (raw == null || raw === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

function numEnv(name, fallback, env = process.env) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function normalizeMarket(market = 'crypto') {
  const normalized = String(market || 'crypto').toLowerCase();
  if (normalized === 'binance') return 'crypto';
  return normalized;
}

function isCollectResultOk(result = {}) {
  if (typeof result?.ok === 'boolean') return result.ok === true;
  return Number(result?.metrics?.failedHardCoreTasks || 0) === 0;
}

function defaultExchangeForMarket(market = 'crypto') {
  if (market === 'domestic') return 'kis';
  if (market === 'overseas') return 'kis_overseas';
  return 'binance';
}

function defaultRefreshMaxSymbols(market = 'crypto') {
  return DEFAULT_REFRESH_MAX_SYMBOLS_BY_MARKET[market] || 2;
}

function defaultTargetedEnrichmentMaxSymbols(market = 'crypto') {
  return DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS_BY_MARKET[normalizeMarket(market)] || DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS;
}

function shouldRefreshWhenCapacityFull(env = process.env) {
  return boolEnv('LUNA_ACTIVE_CANDIDATE_REFRESH_WHEN_CAPACITY_FULL', false, env);
}

function positiveIntOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function nonNegativeNumberOrFallback(value, fallback = 0) {
  if (value == null || value === '') return Math.max(0, Number(fallback || 0));
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, Number(fallback || 0));
}

function missingEnrichmentNodeIds(item = {}, { exchange: exchangeOverride = null, env = process.env } = {}) {
  const exchange = String(exchangeOverride || item.exchange || '').trim();
  const reasons = new Set(Array.isArray(item.reasons) ? item.reasons : []);
  const byAnalyst = item?.analystSummary?.byAnalyst || {};
  const nodes = [];
  const hasSentiment = hasUsableAnalystEvidence(byAnalyst.sentiment, 'sentiment')
    || hasUsableAnalystEvidence(byAnalyst.sentinel, 'sentiment');
  const hasOnchain = hasUsableAnalystEvidence(byAnalyst.onchain, 'onchain');
  const hasMarketFlow = hasUsableAnalystEvidence(byAnalyst.market_flow, 'market_flow');
  const hasTechnical = hasUsableAnalystEvidence(byAnalyst.ta_mtf, 'technical')
    || hasUsableAnalystEvidence(byAnalyst.ta, 'technical')
    || hasUsableAnalystEvidence(byAnalyst.technical, 'technical');
  const stockLightCollect = (exchange === 'kis' || exchange === 'kis_overseas') && !isStockIntradayEnrichmentEnabled(env);
  if (exchange === 'binance' && reasons.has('technical_not_confirmed') && !hasTechnical) nodes.push('L02');
  if (!stockLightCollect && reasons.has('sentiment_not_confirmed') && !hasSentiment) nodes.push('L03');
  if (exchange === 'binance' && reasons.has('onchain_not_confirmed') && !hasOnchain) nodes.push('L05');
  if (
    (exchange === 'kis' || exchange === 'kis_overseas')
    && (!hasMarketFlow || isStockMarketFlowRecheckCandidate(item, exchange))
    && (reasons.has('market_flow_not_confirmed') || reasons.has('news_only_buy'))
  ) {
    nodes.push('L04');
  }
  return [...new Set(nodes)];
}

function hasUsableAnalystEvidence(row = null, kind = 'generic') {
  if (!row || typeof row !== 'object') return false;
  const reasoning = String(row.reasoning || row.reason || row.error || '');
  const signal = String(row.signal || '').toUpperCase();
  const confidence = Number(row.confidence);
  const text = reasoning.toLowerCase();
  const explicitFailure = /(hub llm 호출 실패|llm 폴백|fallback.*failed|timeout|timed out|aborted|unavailable|api error|rate.?limit|nan|undefined|null)/i.test(reasoning);
  if (explicitFailure) return false;
  if (kind === 'onchain' && /불분명|정보가 충분하지|insufficient|unknown|missing/i.test(reasoning) && (!Number.isFinite(confidence) || confidence <= 0)) {
    return false;
  }
  if (kind === 'sentiment' && /키워드 감성 \(점수:\s*0\.00/i.test(reasoning) && (!Number.isFinite(confidence) || confidence <= 0.05)) {
    return false;
  }
  if (Number.isFinite(confidence) && confidence > 0) return true;
  return ['BUY', 'SELL', 'HOLD'].includes(signal) && text.length > 0 && !/(failed|error|timeout|aborted)/i.test(reasoning);
}

function isStockExchange(exchange = '') {
  const normalized = String(exchange || '').trim();
  return normalized === 'kis' || normalized === 'kis_overseas';
}

function hasTechnicalBuy(item = {}) {
  const byAnalyst = item?.analystSummary?.byAnalyst || {};
  return ['ta_mtf', 'ta', 'technical'].some((analyst) => String(byAnalyst?.[analyst]?.signal || '').toUpperCase() === 'BUY')
    || String(item?.fused?.recommendation || '').toUpperCase() === 'LONG';
}

function cryptoTechnicalRows(item = {}) {
  const byAnalyst = item?.analystSummary?.byAnalyst || {};
  return ['ta_mtf', 'ta', 'technical']
    .map((analyst) => {
      const row = byAnalyst?.[analyst];
      if (!row) return null;
      return {
        analyst,
        signal: row.signal,
        confidence: row.confidence,
        reasoning: row.reasoning || '',
        metadata: row.metadata || {},
      };
    })
    .filter(Boolean);
}

function hasCryptoMtfWeightedPresignal(item = {}, env = process.env) {
  if (String(item?.exchange || '').trim() !== 'binance') return false;
  const evidence = extractCryptoTechnicalEvidence(cryptoTechnicalRows(item));
  const weightedFloor = numEnv('LUNA_CRYPTO_TA_MTF_PRESIGNAL_WEIGHTED_SCORE', DEFAULT_CRYPTO_MTF_PRESIGNAL_WEIGHTED_SCORE, env);
  const minBuyFrames = Math.max(
    1,
    Math.round(numEnv('LUNA_CRYPTO_TA_MTF_PRESIGNAL_MIN_BUY_FRAMES', DEFAULT_CRYPTO_MTF_PRESIGNAL_MIN_BUY_FRAMES, env)),
  );
  const buyFrames = Number(evidence.intradayBuyFrames || 0) + Number(evidence.dailyBuyFrames || 0);
  const hasSellConflict = Number(evidence.intradaySellFrames || 0) > 0 || Number(evidence.dailySellFrames || 0) > 0;
  return evidence.weightedScore != null
    && Number(evidence.weightedScore) >= weightedFloor
    && buyFrames >= minBuyFrames
    && !hasSellConflict;
}

function normalizeSymbol(symbol = '') {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return raw;
  if (!raw.includes('/') && raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  return raw;
}

function dailyTechnicalRow(item = {}) {
  const direct = item?.dailyTechnical || item?.dailyTechnicalCoverage || item?.entryChartDailyTechnical || null;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  const rows = item?.dailyTechnicalRows || item?.analysisCoverage?.dailyTechnicalCoverage?.rows || [];
  const symbol = normalizeSymbol(item?.symbol);
  return (rows || []).find((row) => normalizeSymbol(row?.symbol) === symbol) || null;
}

function hasDailyBullishTechnicalPresignal(item = {}) {
  const row = dailyTechnicalRow(item);
  if (!row) return false;
  const reason = String(row.reason || '').toLowerCase();
  return row.ok === true || reason.includes('daily_trend_bullish');
}

function targetedTechnicalPresignal(item = {}, env = process.env) {
  if (hasTechnicalBuy(item)) return 'analyst_technical_buy';
  if (hasCryptoMtfWeightedPresignal(item, env)) return 'mtf_weighted_presignal';
  if (hasDailyBullishTechnicalPresignal(item)) return 'daily_technical_bullish';
  if (isProbeCriticalCandidate(item)) return 'relaxed_probe_candidate';
  return null;
}

function isProbeCriticalCandidate(item = {}) {
  if (item?.actionability === 'relaxed_probe_candidate') return true;
  if (item?.relaxation?.ok === true) return true;
  return false;
}

function isStockMarketFlowRecheckCandidate(item = {}, exchange = '') {
  if (!isStockExchange(exchange)) return false;
  const reasons = new Set(Array.isArray(item.reasons) ? item.reasons : []);
  if (!reasons.has('market_flow_not_confirmed') || reasons.has('conflict_detected')) return false;
  if (!hasDailyBullishTechnicalPresignal(item)) return false;
  const candidate = item?.activeCandidate || {};
  const rank = Number(candidate.rank || 999999);
  const confidence = Math.max(Number(candidate.score || 0), Number(candidate.confidence || 0));
  return rank >= 1 && rank <= DEFAULT_TARGETED_ENRICHMENT_CANDIDATE_RANK && confidence >= DEFAULT_TARGETED_ENRICHMENT_CANDIDATE_SCORE;
}

function numericValues(values = []) {
  return values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function candidateConfidence(item = {}) {
  const analystConfidences = Object.values(item?.analystSummary?.byAnalyst || {}).map((analyst) => analyst?.confidence);
  const values = numericValues([
    item?.confidence,
    item?.fused?.averageConfidence,
    item?.fused?.confidence,
    item?.relaxation?.confidence,
    item?.activeCandidate?.score,
    item?.activeCandidate?.confidence,
    ...analystConfidences,
  ]);
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function isHighPriorityActiveCandidate(item = {}) {
  const activeCandidate = item?.activeCandidate || null;
  if (!activeCandidate) return false;
  const rank = Number(activeCandidate.rank || 999999);
  const score = Number(activeCandidate.score ?? activeCandidate.confidence ?? 0);
  return rank >= 1
    && rank <= DEFAULT_TARGETED_ENRICHMENT_CANDIDATE_RANK
    && score >= DEFAULT_TARGETED_ENRICHMENT_CANDIDATE_SCORE;
}

function shouldTargetCandidateForEnrichment(item = {}, { exchange = null, env = process.env } = {}) {
  const reasons = new Set(Array.isArray(item.reasons) ? item.reasons : []);
  if (reasons.has('conflict_detected')) return false;
  const missingNodes = missingEnrichmentNodeIds(item, { exchange, env });
  if (reasons.has('news_only_buy')) {
    return isStockExchange(exchange) && missingNodes.includes('L04');
  }
  if (targetedTechnicalPresignal(item, env)) return true;
  if (isProbeCriticalCandidate(item) && missingNodes.includes('L02')) return true;
  const requireTechnicalPresignal = String(exchange || '').trim() === 'binance'
    ? boolEnv(
      'LUNA_CRYPTO_TARGETED_ENRICHMENT_REQUIRE_TECHNICAL_PRESIGNAL',
      DEFAULT_CRYPTO_TARGETED_ENRICHMENT_REQUIRE_TECHNICAL_PRESIGNAL,
      env,
    )
    : false;
  if (requireTechnicalPresignal) return false;
  if (!isHighPriorityActiveCandidate(item)) return false;
  return missingNodes.length > 0;
}

function isGlobalCooldownBypassCandidate(item = {}, confidence = 0, minConfidence = DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE, env = process.env) {
  if (isProbeCriticalCandidate(item)) return true;
  if (!targetedTechnicalPresignal(item, env)) return false;
  return Number(confidence || 0) >= Math.max(Number(minConfidence || 0), 0.62);
}

function buildDailyTechnicalBySymbol(coverage = null) {
  const bySymbol = new Map();
  for (const row of coverage?.rows || []) {
    const symbol = normalizeSymbol(row?.symbol);
    if (symbol && !bySymbol.has(symbol)) bySymbol.set(symbol, row);
  }
  return bySymbol;
}

function attachDailyTechnicalCoverage(report = {}, coverage = null) {
  if (!coverage || !Array.isArray(report?.top)) return report;
  const bySymbol = buildDailyTechnicalBySymbol(coverage);
  if (bySymbol.size === 0) return {
    ...report,
    dailyTechnicalCoverage: coverage,
  };
  return {
    ...report,
    dailyTechnicalCoverage: coverage,
    top: report.top.map((item) => {
      const row = bySymbol.get(normalizeSymbol(item?.symbol));
      return row ? { ...item, dailyTechnical: row } : item;
    }),
  };
}

function buildTargetedEnrichmentPlan({
  report,
  state = {},
  now = new Date(),
  maxSymbols = DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS,
  cooldownMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES,
  minConfidence = DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE,
  cooldownBypassMinMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES,
  cooldownBypassMaxSymbols = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS,
  globalCooldownBypassMaxSymbols = DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_BYPASS_MAX_SYMBOLS,
  globalCooldownEnabled = DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_ENABLED,
  exchange = null,
  excludeSymbols = [],
  env = process.env,
} = {}) {
  const attempts = state?.symbols || {};
  const safeCooldownMinutes = Math.max(1, Number(cooldownMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES));
  const safeMinConfidence = Math.max(0, Math.min(1, Number(minConfidence ?? DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE)));
  const cooldownMs = safeCooldownMinutes * 60 * 1000;
  const bypassMs = Math.max(1, Number(cooldownBypassMinMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES)) * 60 * 1000;
  const bypassMax = Math.max(0, Number(cooldownBypassMaxSymbols || 0));
  const globalBypassMax = Math.max(0, Number(globalCooldownBypassMaxSymbols || 0));
  const excluded = new Set((excludeSymbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean));
  const selected = [];
  const skippedCooldown = [];
  const skippedQuality = [];
  const nodeIds = new Set();
  let cooldownBypassed = 0;
  let globalCooldownBypassed = 0;
  let globalCooldown = null;
  const globalKey = exchange
    ? `${exchange}:targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`
    : `targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`;
  const globalAttempt = attempts?.[globalKey] || null;
  const globalLastAttemptAt = globalAttempt?.lastAttemptAt || null;
  const globalAgeMs = globalLastAttemptAt ? now.getTime() - new Date(globalLastAttemptAt).getTime() : Infinity;
  if (Number.isFinite(globalAgeMs) && globalAgeMs >= 0 && globalAgeMs < cooldownMs) {
    globalCooldown = {
      lastAttemptAt: globalLastAttemptAt,
      nextEligibleAt: new Date(new Date(globalLastAttemptAt).getTime() + cooldownMs).toISOString(),
      cooldownMinutes: safeCooldownMinutes,
    };
  }

  for (const item of report?.top || []) {
    const symbol = String(item?.symbol || '').trim().toUpperCase();
    if (!symbol || excluded.has(symbol)) continue;
    if (item.actionability === 'likely_actionable') continue;
    if (!shouldTargetCandidateForEnrichment(item, { exchange, env })) continue;
    const confidence = candidateConfidence(item);
    if (!isProbeCriticalCandidate(item) && confidence < safeMinConfidence) {
      skippedQuality.push({
        symbol,
        confidence,
        minConfidence: safeMinConfidence,
        reason: 'targeted_enrichment_low_confidence',
      });
      continue;
    }
    const reasons = new Set(Array.isArray(item.reasons) ? item.reasons : []);
    if (reasons.has('conflict_detected')) continue;
    const missingNodes = missingEnrichmentNodeIds(item, { exchange, env });
    if (missingNodes.length === 0) continue;
    const key = exchange ? `${exchange}:targeted_enrichment:${symbol}` : `targeted_enrichment:${symbol}`;
    const attempt = attempts?.[key] || null;
    const lastAttemptAt = attempt?.lastAttemptAt || null;
    const ageMs = lastAttemptAt ? now.getTime() - new Date(lastAttemptAt).getTime() : Infinity;
    if (globalCooldown && globalCooldownEnabled === true) {
      const globalBypassAllowed = isGlobalCooldownBypassCandidate(item, confidence, safeMinConfidence, env)
        && globalCooldownBypassed < globalBypassMax
        && globalAgeMs >= bypassMs
        && selected.length < Math.max(0, Number(maxSymbols || 0))
        && (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= bypassMs);
      if (globalBypassAllowed) {
        cooldownBypassed += 1;
        globalCooldownBypassed += 1;
        selected.push({
          symbol,
          reasons: [...reasons],
          missingNodes,
          confidence,
          fused: item.fused || null,
          recommendation: item.recommendation || null,
          technicalPresignal: targetedTechnicalPresignal(item, env),
          cooldownBypassed: true,
          globalCooldownBypassed: true,
          globalLastAttemptAt: globalCooldown.lastAttemptAt,
          globalNextEligibleAt: globalCooldown.nextEligibleAt,
        });
        for (const nodeId of missingNodes) nodeIds.add(nodeId);
        if (selected.length >= Math.max(0, Number(maxSymbols || 0))) break;
        continue;
      }
      skippedCooldown.push({
        symbol,
        lastAttemptAt: globalCooldown.lastAttemptAt,
        nextEligibleAt: globalCooldown.nextEligibleAt,
        missingNodes,
        scope: 'market_global',
      });
      continue;
    }
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldownMs) {
      const bypassAllowed = isProbeCriticalCandidate(item)
        && cooldownBypassed < bypassMax
        && ageMs >= bypassMs
        && selected.length < Math.max(0, Number(maxSymbols || 0));
      if (bypassAllowed) {
        cooldownBypassed += 1;
        selected.push({
          symbol,
          reasons: [...reasons],
          missingNodes,
          confidence,
          fused: item.fused || null,
          recommendation: item.recommendation || null,
          cooldownBypassed: true,
          lastAttemptAt,
          nextEligibleAt: new Date(new Date(lastAttemptAt).getTime() + cooldownMs).toISOString(),
        });
        for (const nodeId of missingNodes) nodeIds.add(nodeId);
        if (selected.length >= Math.max(0, Number(maxSymbols || 0))) break;
        continue;
      }
      skippedCooldown.push({
        symbol,
        lastAttemptAt,
        nextEligibleAt: new Date(new Date(lastAttemptAt).getTime() + cooldownMs).toISOString(),
        missingNodes,
      });
      continue;
    }

    selected.push({
      symbol,
      reasons: [...reasons],
      missingNodes,
      confidence,
      fused: item.fused || null,
      recommendation: item.recommendation || null,
      technicalPresignal: targetedTechnicalPresignal(item, env),
    });
    for (const nodeId of missingNodes) nodeIds.add(nodeId);
    if (selected.length >= Math.max(0, Number(maxSymbols || 0))) break;
  }

  return {
    ok: true,
    enabled: Math.max(0, Number(maxSymbols || 0)) > 0,
    status: selected.length > 0
      ? 'targeted_enrichment_needed'
      : skippedCooldown.length > 0
        ? 'targeted_enrichment_cooldown'
        : skippedQuality.length > 0
          ? 'targeted_enrichment_quality_filtered'
          : 'targeted_enrichment_clear',
    selected,
    selectedSymbols: selected.map((item) => item.symbol),
    nodeIds: [...nodeIds],
    skippedCooldown,
    skippedQuality,
    globalCooldown,
    globalCooldownEnabled: globalCooldownEnabled === true,
    requireTechnicalPresignal: String(exchange || '').trim() === 'binance'
      ? boolEnv(
        'LUNA_CRYPTO_TARGETED_ENRICHMENT_REQUIRE_TECHNICAL_PRESIGNAL',
        DEFAULT_CRYPTO_TARGETED_ENRICHMENT_REQUIRE_TECHNICAL_PRESIGNAL,
        env,
      )
      : false,
    cooldownBypassed,
    cooldownBypassedSymbols: selected.filter((item) => item.cooldownBypassed).map((item) => item.symbol),
    globalCooldownBypassed,
    globalCooldownBypassMaxSymbols: globalBypassMax,
    maxSymbols: Math.max(0, Number(maxSymbols || 0)),
    cooldownMinutes: safeCooldownMinutes,
    minConfidence: safeMinConfidence,
    cooldownBypassMinMinutes: Math.max(1, Number(cooldownBypassMinMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES)),
    cooldownBypassMaxSymbols: bypassMax,
  };
}

export function buildActiveCandidateAnalysisRefreshPlan({
  report,
  state = {},
  now = new Date(),
  maxSymbols = 4,
  maxEnrichmentSymbols = DEFAULT_TARGETED_ENRICHMENT_MAX_SYMBOLS,
  cooldownMinutes = 45,
  targetedCooldownMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES,
  minTargetedConfidence = DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE,
  cooldownBypassMinMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES,
  cooldownBypassMaxSymbols = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS,
  globalCooldownBypassMaxSymbols = DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_BYPASS_MAX_SYMBOLS,
  globalCooldownEnabled = DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_ENABLED,
  exchange = null,
  env = process.env,
} = {}) {
  const missing = [...new Set((report?.missingActiveCandidateSymbols || []).map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  const cooldownMs = Math.max(1, Number(cooldownMinutes || 45)) * 60 * 1000;
  const attempts = state?.symbols || {};
  const selected = [];
  const skippedCooldown = [];
  const attemptKeyFor = (symbol) => exchange ? `${exchange}:analysis:${symbol}` : `analysis:${symbol}`;

  for (const symbol of missing) {
    const attempt = attempts?.[attemptKeyFor(symbol)] || attempts?.[exchange ? `${exchange}:${symbol}` : symbol] || null;
    const lastAttemptAt = attempt?.lastAttemptAt || null;
    const ageMs = lastAttemptAt ? now.getTime() - new Date(lastAttemptAt).getTime() : Infinity;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldownMs) {
      skippedCooldown.push({
        symbol,
        lastAttemptAt,
        nextEligibleAt: new Date(new Date(lastAttemptAt).getTime() + cooldownMs).toISOString(),
      });
      continue;
    }
    if (selected.length < Math.max(1, Number(maxSymbols || 4))) selected.push(symbol);
  }

  const targetedEnrichment = buildTargetedEnrichmentPlan({
    report,
    state,
    now,
    maxSymbols: maxEnrichmentSymbols,
    cooldownMinutes: targetedCooldownMinutes,
    minConfidence: minTargetedConfidence,
    cooldownBypassMinMinutes,
    cooldownBypassMaxSymbols,
    globalCooldownBypassMaxSymbols,
    globalCooldownEnabled,
    exchange,
    excludeSymbols: selected,
    env,
  });
  const hasWork = selected.length > 0 || targetedEnrichment.selected.length > 0;
  const hasCooldown = skippedCooldown.length > 0 || targetedEnrichment.skippedCooldown.length > 0;

  return {
    ok: true,
    status: hasWork
      ? 'active_candidate_analysis_refresh_needed'
      : hasCooldown || missing.length > 0
        ? 'active_candidate_analysis_refresh_cooldown'
        : 'active_candidate_analysis_refresh_clear',
    missing,
    selected,
    skippedCooldown,
    targetedEnrichment,
    maxSymbols: Math.max(1, Number(maxSymbols || 4)),
    maxEnrichmentSymbols: Math.max(0, Number(maxEnrichmentSymbols || 0)),
    cooldownMinutes: Math.max(1, Number(cooldownMinutes || 45)),
    targetedCooldownMinutes: Math.max(1, Number(targetedCooldownMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES)),
    minTargetedConfidence: Math.max(0, Math.min(1, Number(minTargetedConfidence ?? DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE))),
    nextAction: hasWork
      ? 'collect_missing_or_targeted_enrichment_without_decision_execution'
      : hasCooldown || missing.length > 0
        ? 'wait_for_refresh_cooldown_or_regular_market_cycle'
        : 'continue_observation',
  };
}

function isPreopenMarketFlowPending(marketReport = {}) {
  if (marketReport?.preopenReadiness?.active !== true) return false;
  const pending = [
    ...(marketReport?.preopenReadiness?.pending || []),
    ...(marketReport?.observations || []),
  ];
  return pending.some((code) => String(code || '').includes('preopen_market_flow_analysis_missing_for_candidates'));
}

function discoveryTopSymbols(marketReport = {}) {
  return (marketReport?.candidateUniverse?.top || [])
    .map((item) => String(item?.symbol || '').trim().toUpperCase())
    .filter(Boolean);
}

function bullishDailySymbols(marketReport = {}) {
  return new Set((marketReport?.analysisCoverage?.dailyTechnicalCoverage?.rows || [])
    .filter((row) => row?.ok === true || String(row?.reason || '').toLowerCase().includes('bullish'))
    .map((row) => String(row?.symbol || '').trim().toUpperCase())
    .filter(Boolean));
}

export function buildPreopenMarketFlowRefreshPlan({
  marketReport = {},
  state = {},
  now = new Date(),
  maxSymbols = 2,
  cooldownMinutes = DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES,
  exchange = null,
} = {}) {
  if (!isPreopenMarketFlowPending(marketReport)) {
    return {
      ok: true,
      enabled: false,
      status: 'preopen_market_flow_refresh_not_needed',
      selected: [],
      selectedSymbols: [],
      nodeIds: [],
      skippedCooldown: [],
    };
  }
  const missing = (marketReport?.analysisCoverage?.required?.missingByAnalyst?.market_flow || [])
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter(Boolean);
  const top = discoveryTopSymbols(marketReport);
  const rank = new Map(top.map((symbol, index) => [symbol, index]));
  const bullish = bullishDailySymbols(marketReport);
  const candidateSymbols = (missing.length > 0 ? missing : top)
    .filter((symbol, index, arr) => arr.indexOf(symbol) === index)
    .sort((a, b) => (rank.get(a) ?? 9999) - (rank.get(b) ?? 9999));
  const preferredSymbols = bullish.size > 0
    ? candidateSymbols.filter((symbol) => bullish.has(symbol))
    : candidateSymbols;
  const fallbackSymbols = preferredSymbols.length > 0 ? preferredSymbols : candidateSymbols;
  const attempts = state?.symbols || {};
  const cooldownMs = Math.max(1, Number(cooldownMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES)) * 60 * 1000;
  const selected = [];
  const skippedCooldown = [];
  const limit = Math.max(0, Number(maxSymbols || 0));
  if (limit <= 0) {
    return {
      ok: true,
      enabled: false,
      status: 'preopen_market_flow_refresh_disabled_by_cap',
      selected: [],
      selectedSymbols: [],
      nodeIds: [],
      skippedCooldown: [],
      missingSymbols: candidateSymbols,
      preferredSymbols,
      pending: marketReport?.preopenReadiness?.pending || [],
      nextOpen: marketReport?.preopenReadiness?.nextOpen || null,
      minutesUntilOpen: marketReport?.preopenReadiness?.minutesUntilOpen ?? null,
      maxSymbols: 0,
      cooldownMinutes: Math.max(1, Number(cooldownMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES)),
    };
  }
  for (const symbol of fallbackSymbols) {
    const key = exchange ? `${exchange}:preopen_market_flow:${symbol}` : `preopen_market_flow:${symbol}`;
    const attempt = attempts?.[key] || null;
    const lastAttemptAt = attempt?.lastAttemptAt || null;
    const ageMs = lastAttemptAt ? now.getTime() - new Date(lastAttemptAt).getTime() : Infinity;
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < cooldownMs) {
      skippedCooldown.push({
        symbol,
        lastAttemptAt,
        nextEligibleAt: new Date(new Date(lastAttemptAt).getTime() + cooldownMs).toISOString(),
      });
      continue;
    }
    if (selected.length < limit) selected.push(symbol);
    if (selected.length >= limit) break;
  }
  return {
    ok: true,
    enabled: true,
    status: selected.length > 0
      ? 'preopen_market_flow_refresh_needed'
      : fallbackSymbols.length > 0
        ? 'preopen_market_flow_refresh_cooldown'
        : 'preopen_market_flow_refresh_no_symbols',
    selected,
    selectedSymbols: selected,
    nodeIds: selected.length > 0 ? ['L04'] : [],
    skippedCooldown,
    missingSymbols: candidateSymbols,
    preferredSymbols,
    pending: marketReport?.preopenReadiness?.pending || [],
    nextOpen: marketReport?.preopenReadiness?.nextOpen || null,
    minutesUntilOpen: marketReport?.preopenReadiness?.minutesUntilOpen ?? null,
    maxSymbols: limit,
    cooldownMinutes: Math.max(1, Number(cooldownMinutes || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES)),
  };
}

function combineRefreshStatus(plan = {}, preopenMarketFlow = {}) {
  if ((plan.selected || []).length > 0 || (plan.targetedEnrichment?.selected || []).length > 0) return plan.status;
  if ((preopenMarketFlow.selected || []).length > 0) return 'active_candidate_preopen_market_flow_refresh_needed';
  if ((preopenMarketFlow.skippedCooldown || []).length > 0) return 'active_candidate_preopen_market_flow_refresh_cooldown';
  return plan.status;
}

function filterTop30SelectedSymbols(symbols = [], universe = null) {
  const selected = [];
  const excluded = [];
  for (const symbol of symbols || []) {
    const gate = evaluateBinanceTopVolumeUniverseGate(symbol, universe);
    if (gate.ok) selected.push(gate.canonicalSymbol);
    else excluded.push({ symbol, reason: gate.reason, rank: gate.rank });
  }
  return { selected: [...new Set(selected)], excluded };
}

function applyCryptoTop30ToRefreshPlan(plan = {}, universe = null, exchange = '') {
  if (String(exchange || '').trim() !== 'binance') return { plan, excluded: [] };
  const base = filterTop30SelectedSymbols(plan.selected || [], universe);
  const targeted = filterTop30SelectedSymbols(plan.targetedEnrichment?.selectedSymbols || [], universe);
  const targetedSelectedSet = new Set(targeted.selected);
  const targetedSelected = (plan.targetedEnrichment?.selected || [])
    .filter((item) => targetedSelectedSet.has(String(item?.symbol || '').trim().toUpperCase()))
    .map((item) => ({ ...item, binanceTop30Rank: evaluateBinanceTopVolumeUniverseGate(item.symbol, universe).rank }));
  return {
    plan: {
      ...plan,
      selected: base.selected,
      targetedEnrichment: {
        ...(plan.targetedEnrichment || {}),
        selected: targetedSelected,
        selectedSymbols: targeted.selected,
        top30ExcludedSymbols: targeted.excluded,
      },
      top30ExcludedSymbols: base.excluded,
    },
    excluded: [...base.excluded, ...targeted.excluded],
  };
}

function updateAttemptState(state = {}, symbols = [], result = {}, now = new Date(), { exchange = null, purpose = 'analysis' } = {}) {
  const next = {
    ...(state || {}),
    updatedAt: now.toISOString(),
    symbols: { ...((state || {}).symbols || {}) },
  };
  for (const symbol of symbols || []) {
    const key = exchange ? `${exchange}:${purpose}:${symbol}` : `${purpose}:${symbol}`;
    next.symbols[key] = {
      symbol,
      exchange,
      purpose,
      lastAttemptAt: now.toISOString(),
      lastStatus: isCollectResultOk(result) ? 'ok' : 'failed',
      lastOutcome: result?.metrics?.collectQuality?.status || result?.status || null,
      lastSessionId: result?.sessionId || null,
    };
  }
  if (purpose === 'targeted_enrichment' && (symbols || []).length > 0) {
    const globalKey = exchange
      ? `${exchange}:targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`
      : `targeted_enrichment:${GLOBAL_TARGETED_ENRICHMENT_SYMBOL}`;
    next.symbols[globalKey] = {
      symbol: GLOBAL_TARGETED_ENRICHMENT_SYMBOL,
      exchange,
      purpose,
      lastAttemptAt: now.toISOString(),
      lastStatus: isCollectResultOk(result) ? 'ok' : 'failed',
      lastOutcome: result?.metrics?.collectQuality?.status || result?.status || null,
      lastSessionId: result?.sessionId || null,
    };
  }
  return next;
}

export async function runActiveCandidateAnalysisRefresh({
  market = 'crypto',
  exchange = null,
  env = process.env,
  hours = Number(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_HOURS || DEFAULT_DECISION_FILTER_HOURS),
  limit = 20,
  maxSymbols = positiveIntOrNull(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_MAX_SYMBOLS),
  maxEnrichmentSymbols = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MAX_SYMBOLS || defaultTargetedEnrichmentMaxSymbols(market)),
  cooldownMinutes = Number(process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_COOLDOWN_MINUTES || 45),
  targetedCooldownMinutes = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES),
  minTargetedConfidence = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MIN_CONFIDENCE || DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE),
  cooldownBypassMinMinutes = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES),
  cooldownBypassMaxSymbols = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS),
  globalCooldownBypassMaxSymbols = Number(process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_BYPASS_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_BYPASS_MAX_SYMBOLS),
  globalCooldownEnabled = boolEnv('LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_ENABLED', DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_ENABLED),
  enabled = boolEnv('LUNA_ACTIVE_CANDIDATE_REFRESH_ENABLED', true),
  targetedEnrichmentEnabled = boolEnv('LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_ENABLED', true),
  dailyTechnicalTargetingEnabled = boolEnv('LUNA_ACTIVE_CANDIDATE_TARGETED_DAILY_TECHNICAL_ENABLED', DEFAULT_CRYPTO_TARGETED_ENRICHMENT_DAILY_TECHNICAL_ENABLED, env),
  apply = false,
  confirm = null,
  statePath = DEFAULT_STATE_PATH,
  reportBuilder = buildLunaDecisionFilterReport,
  collectRunner = runMarketCollectPipeline,
  finishRun = finishPipelineRun,
  discoveryReportBuilder = buildLunaDiscoveryFunnelReport,
  binanceTopVolumeUniverse: providedBinanceTopVolumeUniverse = null,
  now = new Date(),
} = {}) {
  const normalizedMarket = normalizeMarket(market);
  const resolvedExchange = exchange || defaultExchangeForMarket(normalizedMarket);
  const resolvedMaxSymbols = Math.max(1, Number(maxSymbols || defaultRefreshMaxSymbols(normalizedMarket)));
  if (!['crypto', 'domestic', 'overseas'].includes(normalizedMarket)) {
    return {
      ok: true,
      status: 'active_candidate_analysis_refresh_not_applicable',
      market: normalizedMarket,
      exchange: resolvedExchange,
      reason: 'unsupported_market_for_targeted_refresh',
    };
  }
  if (!enabled) {
    return {
      ok: true,
      status: 'active_candidate_analysis_refresh_disabled',
      market: normalizedMarket,
      exchange: resolvedExchange,
    };
  }

  const state = readJsonSafe(statePath, { symbols: {} });
  let report = await reportBuilder({
    market: normalizedMarket,
    exchange: resolvedExchange,
    activeCandidates: true,
    hours,
    limit,
  });
  if (report?.entryCapacity?.full === true && !shouldRefreshWhenCapacityFull(env)) {
    return {
      ok: true,
      status: 'active_candidate_analysis_refresh_skipped_capacity_full',
      dryRun: !apply,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      statePath,
      reason: 'entry_capacity_full_monitor_existing_positions_first',
      entryCapacity: report.entryCapacity,
      report: {
        status: report.status,
        activeCandidateCoverage: report.activeCandidateCoverage,
        bottlenecks: report.bottlenecks,
      },
      nextAction: 'monitor_existing_positions_until_slot_available',
    };
  }
  let targetedDailyTechnicalCoverage = null;
  if (
    targetedEnrichmentEnabled
    && dailyTechnicalTargetingEnabled
    && resolvedExchange === 'binance'
    && Array.isArray(report?.activeCandidateSymbols)
    && report.activeCandidateSymbols.length > 0
  ) {
    targetedDailyTechnicalCoverage = await buildDailyTechnicalCoverage({
      market: normalizedMarket,
      exchange: resolvedExchange,
      symbols: report.activeCandidateSymbols,
      marketOpen: true,
    }).catch((error) => ({
      enabled: true,
      sourcePolicy: 'tradingview',
      checkedCount: 0,
      availableCount: 0,
      bullishCount: 0,
      rows: [],
      error: error?.message || String(error),
    }));
    report = attachDailyTechnicalCoverage(report, targetedDailyTechnicalCoverage);
  }
  const plan = buildActiveCandidateAnalysisRefreshPlan({
    report,
    state,
    now,
    maxSymbols: resolvedMaxSymbols,
    maxEnrichmentSymbols: targetedEnrichmentEnabled ? maxEnrichmentSymbols : 0,
    cooldownMinutes,
    targetedCooldownMinutes,
    minTargetedConfidence,
    cooldownBypassMinMinutes,
    cooldownBypassMaxSymbols,
    globalCooldownBypassMaxSymbols,
    globalCooldownEnabled,
    exchange: resolvedExchange,
    env,
  });
  const binanceTopVolumeUniverse = resolvedExchange === 'binance'
    ? providedBinanceTopVolumeUniverse || await getCachedBinanceTopVolumeUniverse().catch((error) => ({
      source: 'binance_top30_unavailable',
      limit: 30,
      symbols: [],
      ranks: {},
      error: String(error?.message || error),
    }))
    : null;
  const top30Plan = applyCryptoTop30ToRefreshPlan(plan, binanceTopVolumeUniverse, resolvedExchange);
  const effectiveBasePlan = top30Plan.plan;
  let preopenMarketFlow = {
    ok: true,
    enabled: false,
    status: 'preopen_market_flow_refresh_not_checked',
    selected: [],
    selectedSymbols: [],
    nodeIds: [],
    skippedCooldown: [],
  };
  if (
    isStockExchange(resolvedExchange)
    && effectiveBasePlan.selected.length === 0
    && effectiveBasePlan.targetedEnrichment.selected.length === 0
  ) {
    const discoveryReport = await discoveryReportBuilder({
      market: normalizedMarket,
      hours: Math.max(Number(hours || 0), 6),
    }).catch((error) => ({
      ok: false,
      status: 'luna_discovery_funnel_unavailable',
      error: error?.message || String(error),
      markets: [],
    }));
    const marketReport = (discoveryReport?.markets || []).find((item) => item?.market === normalizedMarket)
      || discoveryReport?.markets?.[0]
      || {};
    preopenMarketFlow = buildPreopenMarketFlowRefreshPlan({
      marketReport,
      state,
      now,
      maxSymbols: nonNegativeNumberOrFallback(
        maxEnrichmentSymbols == null || maxEnrichmentSymbols === '' ? resolvedMaxSymbols : maxEnrichmentSymbols,
        resolvedMaxSymbols,
      ),
      cooldownMinutes: targetedCooldownMinutes,
      exchange: resolvedExchange,
    });
  }
  const effectivePlan = {
    ...effectiveBasePlan,
    preopenMarketFlow,
    binanceTopVolumeUniverse: binanceTopVolumeUniverse ? {
      source: binanceTopVolumeUniverse.source,
      fetchedAt: binanceTopVolumeUniverse.fetchedAt,
      limit: binanceTopVolumeUniverse.limit,
    } : null,
    top30ExcludedSymbols: top30Plan.excluded,
  };
  const effectiveStatus = combineRefreshStatus(effectiveBasePlan, preopenMarketFlow);

  if (!apply) {
    return {
      ok: true,
      status: effectiveStatus,
      dryRun: true,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      statePath,
      plan: effectivePlan,
      report: {
        status: report.status,
        activeCandidateCoverage: report.activeCandidateCoverage,
        dailyTechnicalCoverage: report.dailyTechnicalCoverage
          ? {
              checkedCount: report.dailyTechnicalCoverage.checkedCount,
              availableCount: report.dailyTechnicalCoverage.availableCount,
              bullishCount: report.dailyTechnicalCoverage.bullishCount,
              error: report.dailyTechnicalCoverage.error || null,
            }
          : null,
        bottlenecks: report.bottlenecks,
      },
      applyCommand: `node scripts/runtime-luna-active-candidate-analysis-refresh.ts --apply --confirm=${CONFIRM} --json`,
    };
  }

  if (confirm !== CONFIRM) {
    return {
      ok: false,
      status: 'active_candidate_analysis_refresh_confirm_required',
      dryRun: false,
      applied: false,
      confirmRequired: CONFIRM,
      plan: effectivePlan,
    };
  }

  if (effectiveBasePlan.selected.length === 0 && effectiveBasePlan.targetedEnrichment.selected.length === 0 && preopenMarketFlow.selected.length === 0) {
    return {
      ok: true,
      status: effectiveStatus,
      dryRun: false,
      applied: false,
      market: normalizedMarket,
      exchange: resolvedExchange,
      statePath,
      plan: effectivePlan,
    };
  }

  const collectRuns = [];
  async function runCollectStage({ symbols, purpose, meta, universeMeta }) {
    if (!Array.isArray(symbols) || symbols.length === 0) return null;
    const collect = await collectRunner({
      market: resolvedExchange,
      symbols,
      triggerType: purpose === 'targeted_enrichment'
        ? 'active_candidate_targeted_enrichment'
        : purpose === 'preopen_market_flow'
          ? 'preopen_market_flow_refresh'
          : 'active_candidate_analysis_refresh',
      meta,
      universeMeta,
    });
    const collectOk = Number(collect?.metrics?.failedHardCoreTasks || 0) === 0;
    let finishResult = null;
    try {
      finishResult = await finishRun(collect.sessionId, {
        status: collectOk ? 'completed' : 'failed',
        meta: {
          bridge_status: collectOk
            ? `${purpose}_collected`
            : `${purpose}_collect_degraded`,
          market_script: 'active_candidate_analysis_refresh',
          decision_execution_skipped: true,
          collect_purpose: purpose,
          collect_metrics: collect.metrics || null,
          collect_quality: collect.metrics?.collectQuality || null,
          collect_warnings: collect.metrics?.warnings || [],
        },
      });
    } catch (error) {
      finishResult = {
        updated: false,
        reason: 'finish_pipeline_run_failed',
        error: error?.message || String(error),
      };
    }
    const finishOk = finishResult?.updated === true || finishResult?.reason === 'already_terminal';
    const record = { purpose, collect, collectOk, finish: finishResult, finishOk };
    collectRuns.push(record);
    return record;
  }

  const baseRun = await runCollectStage({
    symbols: effectiveBasePlan.selected,
    purpose: 'analysis',
    meta: buildStockIntradayLlmPolicyMeta({
      market: resolvedExchange,
      marketScript: 'active_candidate_analysis_refresh',
      collectMode: 'active_candidate_analysis_refresh',
      extraMeta: {
        decision_execution_skipped: true,
      },
    }),
    universeMeta: {
      screeningSymbolCount: effectiveBasePlan.selected.length,
      activeCandidateRefresh: true,
      binanceTop30Universe: effectivePlan.binanceTopVolumeUniverse,
    },
  });

  const enrichmentRun = await runCollectStage({
    symbols: effectiveBasePlan.targetedEnrichment.selectedSymbols,
    purpose: 'targeted_enrichment',
    meta: buildStockIntradayLlmPolicyMeta({
      market: resolvedExchange,
      marketScript: 'active_candidate_analysis_refresh',
      collectMode: 'active_candidate_targeted_enrichment',
      extraMeta: {
        decision_execution_skipped: true,
        targeted_enrichment: true,
        targeted_enrichment_reason: 'fill_missing_confirmation_before_l13',
        agentPlan: {
          collect: {
            nodeIds: effectiveBasePlan.targetedEnrichment.nodeIds,
            concurrencyLimit: Math.min(3, Math.max(1, effectiveBasePlan.targetedEnrichment.nodeIds.length || 1)),
          },
        },
        llm_call_policy: {
          source_enrichment: 'targeted_top_n_only',
          targeted_enrichment_nodes: effectiveBasePlan.targetedEnrichment.nodeIds,
          targeted_enrichment_max_symbols: effectiveBasePlan.targetedEnrichment.maxSymbols,
          targeted_enrichment_cooldown_minutes: effectiveBasePlan.targetedEnrichment.cooldownMinutes,
          targeted_enrichment_min_confidence: effectiveBasePlan.targetedEnrichment.minConfidence,
          targeted_enrichment_cooldown_bypassed_symbols: effectiveBasePlan.targetedEnrichment.cooldownBypassedSymbols || [],
          targeted_enrichment_global_cooldown_bypassed: effectiveBasePlan.targetedEnrichment.globalCooldownBypassed || 0,
          targeted_enrichment_global_cooldown: effectiveBasePlan.targetedEnrichment.globalCooldown,
        },
      },
    }),
    universeMeta: {
      screeningSymbolCount: effectiveBasePlan.targetedEnrichment.selectedSymbols.length,
      activeCandidateRefresh: true,
      targetedEnrichment: true,
      binanceTop30Universe: effectivePlan.binanceTopVolumeUniverse,
    },
  });

  const preopenMarketFlowRun = await runCollectStage({
    symbols: preopenMarketFlow.selectedSymbols,
    purpose: 'preopen_market_flow',
    meta: buildStockIntradayLlmPolicyMeta({
      market: resolvedExchange,
      marketScript: 'active_candidate_analysis_refresh',
      collectMode: 'preopen_market_flow_refresh',
      extraMeta: {
        decision_execution_skipped: true,
        preopen_market_flow: true,
        targeted_enrichment: true,
        targeted_enrichment_reason: 'fill_preopen_market_flow_before_next_session',
        agentPlan: {
          collect: {
            nodeIds: preopenMarketFlow.nodeIds,
            concurrencyLimit: 1,
          },
        },
        llm_call_policy: {
          source_enrichment: 'preopen_market_flow_top_n_only',
          targeted_enrichment_nodes: preopenMarketFlow.nodeIds,
          targeted_enrichment_max_symbols: preopenMarketFlow.maxSymbols,
          targeted_enrichment_cooldown_minutes: preopenMarketFlow.cooldownMinutes,
        },
      },
    }),
    universeMeta: {
      screeningSymbolCount: preopenMarketFlow.selectedSymbols.length,
      activeCandidateRefresh: true,
      preopenMarketFlow: true,
    },
  });

  const finishOk = collectRuns.every((run) => run.finishOk);
  const collectOk = collectRuns.every((run) => run.collectOk);
  let nextState = updateAttemptState(state, effectiveBasePlan.selected, baseRun?.collect || {}, now, { exchange: resolvedExchange, purpose: 'analysis' });
  nextState = updateAttemptState(nextState, effectiveBasePlan.targetedEnrichment.selectedSymbols, enrichmentRun?.collect || {}, now, { exchange: resolvedExchange, purpose: 'targeted_enrichment' });
  nextState = updateAttemptState(nextState, preopenMarketFlow.selectedSymbols, preopenMarketFlowRun?.collect || {}, now, { exchange: resolvedExchange, purpose: 'preopen_market_flow' });
  writeJson(statePath, nextState);

  return {
    ok: collectOk && finishOk,
    status: finishOk
      ? 'active_candidate_analysis_refresh_collected'
      : 'active_candidate_analysis_refresh_finish_failed',
    dryRun: false,
    applied: true,
    market: normalizedMarket,
    exchange: resolvedExchange,
    statePath,
    plan: effectivePlan,
    collect: baseRun ? {
      sessionId: baseRun.collect.sessionId,
      symbols: baseRun.collect.symbols,
      summaries: baseRun.collect.summaries,
      metrics: baseRun.collect.metrics,
    } : null,
    targetedEnrichmentCollect: enrichmentRun ? {
      sessionId: enrichmentRun.collect.sessionId,
      symbols: enrichmentRun.collect.symbols,
      summaries: enrichmentRun.collect.summaries,
      metrics: enrichmentRun.collect.metrics,
    } : null,
    preopenMarketFlowCollect: preopenMarketFlowRun ? {
      sessionId: preopenMarketFlowRun.collect.sessionId,
      symbols: preopenMarketFlowRun.collect.symbols,
      summaries: preopenMarketFlowRun.collect.summaries,
      metrics: preopenMarketFlowRun.collect.metrics,
    } : null,
    finish: baseRun?.finish || enrichmentRun?.finish || preopenMarketFlowRun?.finish || null,
    collectRuns: collectRuns.map((run) => ({
      purpose: run.purpose,
      sessionId: run.collect?.sessionId || null,
      symbols: run.collect?.symbols || [],
      collectOk: run.collectOk,
      finishOk: run.finishOk,
      finish: run.finish,
    })),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const market = argValue('market', 'crypto', argv);
  const result = await runActiveCandidateAnalysisRefresh({
    market,
    exchange: argValue('exchange', null, argv),
    hours: Math.max(1, Number(argValue('hours', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_HOURS || DEFAULT_DECISION_FILTER_HOURS, argv)) || DEFAULT_DECISION_FILTER_HOURS),
    limit: Math.max(1, Number(argValue('limit', 20, argv)) || 20),
    maxSymbols: positiveIntOrNull(argValue('max-symbols', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_MAX_SYMBOLS || null, argv)),
    maxEnrichmentSymbols: Math.max(0, Number(argValue('max-enrichment-symbols', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MAX_SYMBOLS || defaultTargetedEnrichmentMaxSymbols(market), argv)) || 0),
    cooldownMinutes: Math.max(1, Number(argValue('cooldown-minutes', process.env.LUNA_ACTIVE_CANDIDATE_REFRESH_COOLDOWN_MINUTES || 45, argv)) || 45),
    targetedCooldownMinutes: Math.max(1, Number(argValue('targeted-cooldown-minutes', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES, argv)) || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_MINUTES),
    minTargetedConfidence: Math.max(0, Math.min(1, Number(argValue('targeted-min-confidence', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_MIN_CONFIDENCE || DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE, argv)) || DEFAULT_TARGETED_ENRICHMENT_MIN_CONFIDENCE)),
    cooldownBypassMinMinutes: Math.max(1, Number(argValue('cooldown-bypass-minutes', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES, argv)) || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MINUTES),
    cooldownBypassMaxSymbols: Math.max(0, Number(argValue('cooldown-bypass-max-symbols', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_COOLDOWN_BYPASS_MAX_SYMBOLS, argv)) || 0),
    globalCooldownBypassMaxSymbols: Math.max(0, Number(argValue('global-cooldown-bypass-max-symbols', process.env.LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_BYPASS_MAX_SYMBOLS || DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_BYPASS_MAX_SYMBOLS, argv)) || 0),
    globalCooldownEnabled: hasArg('targeted-global-cooldown', argv)
      ? true
      : hasArg('no-targeted-global-cooldown', argv)
        ? false
        : boolEnv('LUNA_ACTIVE_CANDIDATE_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_ENABLED', DEFAULT_TARGETED_ENRICHMENT_GLOBAL_COOLDOWN_ENABLED),
    apply: hasArg('apply', argv),
    confirm: argValue('confirm', null, argv),
    statePath: argValue('state-path', DEFAULT_STATE_PATH, argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-active-candidate-analysis-refresh ${result.status}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-active-candidate-analysis-refresh 실패:',
  });
}
