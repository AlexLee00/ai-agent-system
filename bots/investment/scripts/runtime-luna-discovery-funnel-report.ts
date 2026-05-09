#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { ensureCandidateUniverseTable } from '../team/discovery/discovery-store.ts';
import { ensureLunaDiscoveryEntryTables } from '../shared/luna-discovery-entry-store.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateKisMarketHours } from '../shared/kis-market-hours-guard.ts';
import { ANALYST_TYPES } from '../shared/signal.ts';
import { evaluateDailyTrendSnapshot, evaluateKisDailySnapshot, evaluateTradingViewSnapshot, fetchEntryChartSnapshot } from '../shared/tradingview-entry-guard.ts';
import {
  DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  readPositionRuntimeAutopilotHistoryLines,
} from './runtime-position-runtime-autopilot-history-store.ts';
import { buildDiscoveryUniverse } from '../team/discovery/discovery-universe.ts';
import { buildDecisionFilterDiagnostics } from './runtime-luna-decision-filter-report.ts';
import { getLunaIntelligentDiscoveryFlags } from '../shared/luna-intelligent-discovery-config.ts';

const MARKET_EXCHANGES = {
  crypto: 'binance',
  domestic: 'kis',
  overseas: 'kis_overseas',
};

const REQUIRED_ANALYSTS = {
  crypto: [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.SENTIMENT, ANALYST_TYPES.ONCHAIN],
  domestic: [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.SENTIMENT, ANALYST_TYPES.MARKET_FLOW],
  overseas: [ANALYST_TYPES.TA_MTF, ANALYST_TYPES.SENTIMENT, ANALYST_TYPES.MARKET_FLOW],
};

const ANALYST_BOTTLENECK_CODES = {
  [ANALYST_TYPES.TA_MTF]: 'technical_analysis_missing_for_candidates',
  [ANALYST_TYPES.SENTIMENT]: 'sentiment_analysis_missing_for_candidates',
  [ANALYST_TYPES.ONCHAIN]: 'onchain_analysis_missing_for_candidates',
  [ANALYST_TYPES.MARKET_FLOW]: 'market_flow_analysis_missing_for_candidates',
};

const ANALYST_PARTIAL_BOTTLENECK_CODES = {
  [ANALYST_TYPES.TA_MTF]: 'technical_analysis_partial_for_candidates',
  [ANALYST_TYPES.SENTIMENT]: 'sentiment_analysis_partial_for_candidates',
  [ANALYST_TYPES.ONCHAIN]: 'onchain_analysis_partial_for_candidates',
  [ANALYST_TYPES.MARKET_FLOW]: 'market_flow_analysis_partial_for_candidates',
};
const DEFAULT_RELAXED_PROBE_RECENT_TRADE_COOLDOWN_HOURS = 6;

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    telegram: argv.includes('--telegram'),
    hours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--hours='))?.split('=')[1] || 24) || 24),
    market: argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all',
    historyFile: argv.find((arg) => arg.startsWith('--history-file='))?.split('=').slice(1).join('=') || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  };
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMarketScope(market = 'all') {
  const m = String(market || 'all').trim().toLowerCase();
  if (m === 'crypto' || m === 'domestic' || m === 'overseas') return [m];
  return ['crypto', 'domestic', 'overseas'];
}

function rowsToStateMap(rows = []) {
  return Object.fromEntries((rows || []).map((row) => [String(row.state || row.trigger_state || row.status || 'unknown'), number(row.count)]));
}

export function buildRequiredAnalystCoverage({
  market,
  analysisSymbols = [],
  requiredSymbols = null,
  analysisRows = [],
  marketOpen = true,
  dailyTechnicalCoverage = null,
} = {}) {
  const requiredAnalysts = REQUIRED_ANALYSTS[market] || [];
  const hasExplicitRequiredSymbols = Array.isArray(requiredSymbols);
  const scopedSymbols = hasExplicitRequiredSymbols
    ? [...new Set(requiredSymbols.map((symbol) => normalizeCandidateSymbolForAnalysis(symbol, market)).filter(Boolean))]
    : analysisSymbols;
  const byAnalyst = {};
  const bySymbol = Object.fromEntries((analysisSymbols || []).map((symbol) => [symbol, {}]));
  const dailyTechnicalSymbols = new Set((dailyTechnicalCoverage?.rows || [])
    .filter((row) => row?.source || Number(row?.bars || 0) > 0)
    .map((row) => normalizeCandidateSymbolForAnalysis(row.symbol, market))
    .filter(Boolean));

  for (const row of analysisRows || []) {
    const symbol = String(row.symbol || '').trim().toUpperCase();
    const analyst = String(row.analyst || '').trim();
    if (!symbol || !analyst) continue;
    if (!byAnalyst[analyst]) {
      byAnalyst[analyst] = {
        count: 0,
        symbols: [],
        latestCreatedAt: null,
      };
    }
    byAnalyst[analyst].count += number(row.count);
    if (!byAnalyst[analyst].symbols.includes(symbol)) byAnalyst[analyst].symbols.push(symbol);
    if (!byAnalyst[analyst].latestCreatedAt || String(row.latest_created_at || '') > String(byAnalyst[analyst].latestCreatedAt || '')) {
      byAnalyst[analyst].latestCreatedAt = row.latest_created_at || null;
    }
    if (!bySymbol[symbol]) bySymbol[symbol] = {};
    bySymbol[symbol][analyst] = {
      count: number(row.count),
      latestCreatedAt: row.latest_created_at || null,
    };
  }

  const missingByAnalyst = {};
  const bottlenecks = [];
  for (const analyst of requiredAnalysts) {
    const covered = new Set(byAnalyst[analyst]?.symbols || []);
    const missingSymbols = (scopedSymbols || []).filter((symbol) => {
      if (covered.has(symbol)) return false;
      if (analyst === ANALYST_TYPES.TA_MTF && market !== 'crypto' && dailyTechnicalSymbols.has(symbol)) return false;
      return true;
    });
    missingByAnalyst[analyst] = missingSymbols;
    if (scopedSymbols.length > 0 && missingSymbols.length === scopedSymbols.length) {
      if (analyst === ANALYST_TYPES.TA_MTF && market !== 'crypto' && !marketOpen) {
        if (Number(dailyTechnicalCoverage?.availableCount || 0) <= 0) {
          bottlenecks.push('technical_analysis_deferred_until_market_open');
        }
      } else {
        bottlenecks.push(ANALYST_BOTTLENECK_CODES[analyst] || `${analyst}_analysis_missing_for_candidates`);
      }
    } else if (missingSymbols.length > 0) {
      bottlenecks.push(ANALYST_PARTIAL_BOTTLENECK_CODES[analyst] || `${analyst}_analysis_partial_for_candidates`);
    }
  }

  return {
    requiredAnalysts,
    scope: {
      source: hasExplicitRequiredSymbols ? 'entry_targetable_candidates' : 'all_candidates',
      checkedSymbols: scopedSymbols,
      ignoredSymbols: (analysisSymbols || []).filter((symbol) => !scopedSymbols.includes(symbol)),
    },
    byAnalyst,
    bySymbol,
    missingByAnalyst,
    dailyTechnicalCoverage,
    bottlenecks: [...new Set(bottlenecks)],
  };
}

export function classifyCoverageBottlenecksForMarket({ market, marketOpen = true, bottlenecks = [] } = {}) {
  const unique = [...new Set(bottlenecks || [])];
  if (market === 'crypto' || marketOpen) {
    return {
      bottlenecks: unique,
      observations: [],
    };
  }
  return {
    bottlenecks: [],
    observations: unique.map((code) => `preopen_${code}`),
  };
}

function getRelaxedProbeRecentTradeCooldownHours(env = process.env) {
  const value = Number(env?.LUNA_RELAXED_PROBE_RECENT_TRADE_COOLDOWN_HOURS);
  if (Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_RELAXED_PROBE_RECENT_TRADE_COOLDOWN_HOURS;
}

function getLiveFireMaxOpenPositions(env = process.env) {
  const value = Number(env?.LUNA_LIVE_FIRE_MAX_OPEN || env?.LUNA_MAX_OPEN_POSITIONS);
  if (Number.isFinite(value) && value > 0) return Math.floor(value);
  return 2;
}

async function loadRecentExecutedSignalCooldowns({ exchange, symbols = [], hours = DEFAULT_RELAXED_PROBE_RECENT_TRADE_COOLDOWN_HOURS } = {}) {
  const cleanSymbols = [...new Set((symbols || []).map((symbol) => String(symbol || '').trim()).filter(Boolean))];
  const lookbackHours = Number(hours);
  if (!exchange || cleanSymbols.length === 0 || !Number.isFinite(lookbackHours) || lookbackHours <= 0) return new Map();
  const rows = await queryRows(
    `SELECT symbol, action, status, created_at
     FROM signals
     WHERE exchange = $1
       AND symbol = ANY($2::text[])
       AND status = 'executed'
       AND action IN ('BUY', 'SELL')
       AND created_at >= now() - ($3::int * INTERVAL '1 hour')
     ORDER BY created_at DESC`,
    [exchange, cleanSymbols, Math.ceil(lookbackHours)],
  );
  const bySymbol = new Map();
  for (const row of rows || []) {
    const symbol = String(row?.symbol || '').trim();
    if (!symbol || bySymbol.has(symbol)) continue;
    bySymbol.set(symbol, {
      symbol,
      action: row.action || null,
      status: row.status || null,
      createdAt: row.created_at || null,
    });
  }
  return bySymbol;
}

async function loadCurrentLivePositions(exchange) {
  if (!exchange) return [];
  return queryRows(
    `SELECT symbol, amount, updated_at
     FROM positions
     WHERE exchange = $1
       AND COALESCE(paper, false) = false
       AND COALESCE(execution_mode, 'live') = 'live'
       AND ABS(COALESCE(amount, 0)) > 0.00000001
     ORDER BY updated_at DESC NULLS LAST`,
    [exchange],
  );
}

function isDailyTechnicalBullish(row = {}) {
  const reason = String(row?.reason || '').toLowerCase();
  return row?.ok === true || reason.includes('daily_trend_bullish');
}

export function buildRequiredCoverageSymbols({ market, analysisSymbols = [], decisionDiagnostics = [], dailyTechnicalCoverage = null } = {}) {
  if (market !== 'crypto') return analysisSymbols;
  const targetable = new Set();
  for (const item of decisionDiagnostics || []) {
    if (item?.actionability !== 'likely_actionable' && item?.actionability !== 'relaxed_probe_candidate') continue;
    const symbol = normalizeCandidateSymbolForAnalysis(item.symbol, market);
    if (symbol) targetable.add(symbol);
  }
  return analysisSymbols.filter((symbol) => targetable.has(symbol));
}

function normalizeCandidateSymbolForAnalysis(symbol, market) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return raw;
  if (market === 'crypto' && !raw.includes('/') && raw.endsWith('USDT')) {
    return `${raw.slice(0, -4)}/USDT`;
  }
  return raw;
}

function candidateSymbolSqlFilter(market) {
  if (market === 'domestic') return `symbol ~ '^[0-9]{6}$'`;
  if (market === 'overseas') return `symbol !~ '/' AND symbol !~ '^[0-9]{6}$' AND symbol ~ '^[A-Za-z][A-Za-z0-9.\\-]{0,12}$'`;
  return `(symbol ~ '^[A-Za-z0-9]+/USDT$' OR symbol ~ '^[A-Za-z0-9]+USDT$')`;
}

function normalizedCandidateExpr() {
  return `CASE
    WHEN $1 = 'crypto' AND symbol ~ '^[A-Za-z0-9]+/USDT$' THEN UPPER(symbol)
    WHEN $1 = 'crypto' AND symbol ~ '^[A-Za-z0-9]+USDT$' THEN REGEXP_REPLACE(UPPER(symbol), 'USDT$', '/USDT')
    WHEN $1 = 'domestic' AND symbol ~ '^[0-9]{6}$' THEN symbol
    WHEN $1 = 'overseas' AND symbol !~ '/' AND symbol !~ '^[0-9]{6}$' AND symbol ~ '^[A-Za-z][A-Za-z0-9.\\-]{0,12}$' THEN UPPER(symbol)
    ELSE NULL
  END`;
}

function candidateSourcePriorityExpr() {
  return `CASE
    WHEN market = 'crypto' AND source = 'binance_market_momentum' THEN 30
    WHEN market = 'crypto' AND source = 'coingecko_trending' THEN 20
    ELSE 10
  END`;
}

async function queryRows(sql, params = []) {
  return db.query(sql, params).catch(() => []);
}

function summarizeEntryChartSnapshot(snapshot = {}, evaluated = {}) {
  return {
    ok: evaluated.ok === true,
    reason: evaluated.reason || snapshot?.error || null,
    source: snapshot?.dailyTrendSource || snapshot?.source || null,
    providerMode: snapshot?.providerMode || null,
    bars: Number(snapshot?.dailyBars?.length || snapshot?.daily_bars?.length || snapshot?.ohlcv?.length || 0),
    directHttpFallback: snapshot?.directHttpFallback?.ok === true
      ? 'ok'
      : snapshot?.directHttpFallback?.error || null,
  };
}

function isoDateDaysAgo(days = 90) {
  return new Date(Date.now() - Math.max(1, Number(days || 90)) * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeCryptoDailyBars(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      timestamp: Number(row.timestamp ?? row.time ?? row[0] ?? 0),
      open: Number(row.open ?? row[1] ?? 0),
      high: Number(row.high ?? row[2] ?? 0),
      low: Number(row.low ?? row[3] ?? 0),
      close: Number(row.close ?? row[4] ?? 0),
      volume: Number(row.volume ?? row[5] ?? 0),
    }))
    .filter((row) => row.close > 0);
}

async function fetchCryptoDailyCoverageFallback(symbol, { getOhlcv = null } = {}) {
  const days = Math.max(30, Math.round(Number(process.env.LUNA_ENTRY_DAILY_TREND_LOOKBACK_DAYS || 90)));
  const loader = getOhlcv || (await import('../shared/ohlcv-fetcher.ts')).getOHLCV;
  const rows = normalizeCryptoDailyBars(await loader(symbol, '1d', isoDateDaysAgo(days), null, 'binance'));
  const latest = rows[rows.length - 1] || {};
  const snapshot = {
    ok: rows.length > 0,
    source: 'binance_ohlcv_daily_for_tradingview_guard',
    providerMode: 'binance_ohlcv',
    market: 'tradingview',
    symbol,
    timeframe: '1d',
    price: Number(latest.close || 0),
    open: Number(latest.open || 0),
    high: Number(latest.high || 0),
    low: Number(latest.low || 0),
    dailyBars: rows.slice(-days),
    stale: false,
  };
  const evaluated = evaluateDailyTrendSnapshot(snapshot);
  return {
    symbol,
    sourcePolicy: 'tradingview',
    ok: evaluated.ok === true,
    reason: evaluated.reason || (rows.length > 0 ? 'daily_trend_not_bullish' : 'binance_ohlcv_daily_empty'),
    source: snapshot.source,
    providerMode: snapshot.providerMode,
    bars: rows.length,
    directHttpFallback: 'binance_ohlcv_daily',
  };
}

export async function buildDailyTechnicalCoverage({
  market,
  exchange,
  symbols = [],
  marketOpen = true,
  fetchSnapshot = fetchEntryChartSnapshot,
  evaluateTradingView = evaluateTradingViewSnapshot,
  evaluateKis = evaluateKisDailySnapshot,
  fetchCryptoDailyFallback = fetchCryptoDailyCoverageFallback,
} = {}) {
  if (symbols.length === 0) {
    return {
      enabled: true,
      sourcePolicy: market === 'crypto' ? 'tradingview' : 'kis',
      checkedCount: 0,
      availableCount: 0,
      bullishCount: 0,
      rows: [],
    };
  }
  if (market === 'crypto') {
    const limit = Math.max(1, Math.min(10, Number(process.env.LUNA_DISCOVERY_FUNNEL_CRYPTO_DAILY_TA_LIMIT || process.env.LUNA_DISCOVERY_FUNNEL_KIS_DAILY_TA_LIMIT || 5)));
    const providerMode = String(process.env.LUNA_DISCOVERY_FUNNEL_CRYPTO_DAILY_TA_PROVIDER || 'binance_ohlcv').toLowerCase();
    if (providerMode !== 'tradingview_realtime') {
      const rows = [];
      for (const symbol of symbols.slice(0, limit)) {
        rows.push(await fetchCryptoDailyFallback(symbol).catch((error) => ({
          symbol,
          sourcePolicy: 'tradingview',
          ok: false,
          reason: error?.message || String(error),
          source: 'binance_ohlcv_daily_for_tradingview_guard',
          providerMode: 'binance_ohlcv',
          bars: 0,
          directHttpFallback: 'binance_ohlcv_daily_error',
        })));
      }
      return {
        enabled: true,
        sourcePolicy: 'tradingview',
        checkedCount: rows.length,
        availableCount: rows.filter((row) => row.source && row.bars > 0).length,
        bullishCount: rows.filter((row) => row.ok).length,
        blockedCount: rows.filter((row) => !row.ok).length,
        rows,
      };
    }
    const realtimeTimeframe = process.env.LUNA_TRADINGVIEW_ENTRY_GUARD_TIMEFRAME || '1h';
    const rows = [];
    for (const symbol of symbols.slice(0, limit)) {
      const snapshot = await fetchSnapshot({ symbol, exchange, timeframe: realtimeTimeframe }).catch((error) => ({
        ok: false,
        error: error?.message || String(error),
        symbol,
      }));
      const evaluated = evaluateTradingView(snapshot);
      const row = {
        symbol,
        sourcePolicy: 'tradingview',
        ...summarizeEntryChartSnapshot(snapshot, evaluated),
      };
      if (!row.ok && row.bars <= 0) {
        rows.push(await fetchCryptoDailyFallback(symbol).catch((error) => ({
          ...row,
          reason: row.reason || error?.message || String(error),
        })));
      } else {
        rows.push(row);
      }
    }
    return {
      enabled: true,
      sourcePolicy: 'tradingview',
      checkedCount: rows.length,
      availableCount: rows.filter((row) => row.ok || (row.source && !String(row.source).includes('luna-marketdata-mcp'))).length,
      bullishCount: rows.filter((row) => row.ok).length,
      blockedCount: rows.filter((row) => !row.ok).length,
      rows,
    };
  }
  const limit = Math.max(1, Math.min(10, Number(process.env.LUNA_DISCOVERY_FUNNEL_KIS_DAILY_TA_LIMIT || 10)));
  const rows = [];
  for (const symbol of symbols.slice(0, limit)) {
    const snapshot = await fetchSnapshot({ symbol, exchange }).catch((error) => ({
      ok: false,
      error: error?.message || String(error),
      symbol,
    }));
    const evaluated = evaluateKis(snapshot);
    rows.push({
      symbol,
      sourcePolicy: 'kis',
      ...summarizeEntryChartSnapshot(snapshot, evaluated),
    });
  }
  return {
    enabled: true,
    sourcePolicy: 'kis',
    checkedCount: rows.length,
    availableCount: rows.filter((row) => row.bars > 0 || row.source).length,
    bullishCount: rows.filter((row) => row.ok).length,
    blockedCount: rows.filter((row) => !row.ok).length,
    rows,
  };
}

async function buildMarketFunnel(market, { hours }) {
  const exchange = MARKET_EXCHANGES[market];
  const marketHours = market === 'crypto'
    ? { market, isOpen: true, state: 'open', reasonCode: 'crypto_24h_market', nextAction: 'allow' }
    : evaluateKisMarketHours({ market });
  const marketOpen = marketHours.isOpen === true;
  const candidateSqlFilter = candidateSymbolSqlFilter(market);
  const normalizedExpr = normalizedCandidateExpr();
  const [candidateRows, sourceRows, signalRows, triggerRows, latestCandidates, latestTriggers] = await Promise.all([
    queryRows(
      `WITH normalized AS (
         SELECT *,
                ${normalizedExpr} AS normalized_symbol
         FROM candidate_universe
         WHERE market = $1
           AND expires_at > now()
           AND ${candidateSqlFilter}
       ),
       ranked AS (
         SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY normalized_symbol
                  ORDER BY ${candidateSourcePriorityExpr()} DESC, score DESC, confidence DESC NULLS LAST, discovered_at DESC
                ) AS rn
         FROM normalized
         WHERE normalized_symbol IS NOT NULL
       )
       SELECT
         COUNT(*)::int AS active_count,
         COUNT(*) FILTER (WHERE discovered_at >= now() - ($2::int * INTERVAL '1 hour'))::int AS recent_count,
         AVG(score)::float AS avg_score,
         MAX(discovered_at) AS latest_discovered_at
       FROM ranked
       WHERE rn = 1`,
      [market, hours],
    ),
    queryRows(
      `SELECT quality_status, COUNT(*)::int AS count, COALESCE(SUM(signal_count), 0)::int AS signal_count, MAX(captured_at) AS latest_captured_at
       FROM discovery_source_metrics
       WHERE market = $1
         AND captured_at >= now() - ($2::int * INTERVAL '1 hour')
       GROUP BY quality_status
       ORDER BY count DESC`,
      [market, hours],
    ),
    queryRows(
      `SELECT COALESCE(status, 'unknown') AS status,
              COALESCE(action, 'unknown') AS action,
              COALESCE(block_code, 'none') AS block_code,
              (
                COALESCE(exclude_from_learning, false) = true
                OR COALESCE(quality_flag, '') = 'exclude_from_learning'
                OR COALESCE(block_code, '') = 'synthetic_reflection_signal'
                OR symbol LIKE 'REFLECT_%'
              ) AS ignored,
              (
                action = 'BUY'
                AND COALESCE(status, 'pending') IN ('pending', 'approved', 'queued', 'retrying')
                AND COALESCE(confidence, 0) >= $3
                AND COALESCE(exclude_from_learning, false) = false
                AND COALESCE(quality_flag, 'trusted') <> 'exclude_from_learning'
              ) AS trigger_eligible,
              COUNT(*)::int AS count,
              MAX(created_at) AS latest_created_at
       FROM signals
       WHERE exchange = $1
         AND created_at >= now() - ($2::int * INTERVAL '1 hour')
       GROUP BY status, action, block_code, ignored, trigger_eligible
       ORDER BY count DESC`,
      [exchange, hours, Number(getLunaIntelligentDiscoveryFlags().entryTrigger?.minConfidence || 0.48)],
    ),
    queryRows(
      `SELECT trigger_state AS state, COUNT(*)::int AS count, MAX(COALESCE(fired_at, updated_at, created_at)) AS latest_at
       FROM entry_triggers
       WHERE exchange = $1
         AND COALESCE(fired_at, updated_at, created_at) >= now() - ($2::int * INTERVAL '1 hour')
       GROUP BY trigger_state
       ORDER BY count DESC`,
      [exchange, hours],
    ),
    queryRows(
      `WITH normalized AS (
         SELECT *,
                ${normalizedExpr} AS normalized_symbol
         FROM candidate_universe
         WHERE market = $1
           AND expires_at > now()
           AND ${candidateSqlFilter}
       ),
       ranked AS (
         SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY normalized_symbol
                  ORDER BY ${candidateSourcePriorityExpr()} DESC, score DESC, confidence DESC NULLS LAST, discovered_at DESC
                ) AS rn
         FROM normalized
         WHERE normalized_symbol IS NOT NULL
       )
       SELECT normalized_symbol AS symbol, source, score::float AS score, confidence, reason_code, discovered_at, expires_at
       FROM ranked
       WHERE rn = 1
       ORDER BY ${candidateSourcePriorityExpr()} DESC, score DESC, confidence DESC NULLS LAST, discovered_at DESC
       LIMIT 10`,
      [market],
    ),
    queryRows(
      `SELECT symbol, trigger_type, trigger_state, confidence, predictive_score, updated_at, fired_at, created_at
       FROM entry_triggers
       WHERE exchange = $1
       ORDER BY COALESCE(fired_at, updated_at, created_at) DESC
       LIMIT 10`,
      [exchange],
    ),
  ]);
  const executionUniverse = await buildDiscoveryUniverse(market, new Date(), {
    refresh: false,
    fallbackSymbols: [],
    preferCandidates: true,
    limit: 10,
  }).catch(() => null);
  const executionCandidates = Array.isArray(executionUniverse?.symbols) && executionUniverse.symbols.length > 0
    ? executionUniverse.symbols.map((symbol) => ({ symbol }))
    : latestCandidates || [];
  const analysisSymbols = Array.from(new Set((executionCandidates || [])
    .map((row) => normalizeCandidateSymbolForAnalysis(row.symbol, market))
    .filter(Boolean)));
  const analysisRows = analysisSymbols.length > 0
    ? await queryRows(
      `SELECT symbol, COUNT(*)::int AS count, MAX(created_at) AS latest_created_at
       FROM analysis
       WHERE exchange = $1
         AND symbol = ANY($2::text[])
         AND created_at >= now() - ($3::int * INTERVAL '1 hour')
       GROUP BY symbol
       ORDER BY latest_created_at DESC`,
      [exchange, analysisSymbols, hours],
    )
    : [];
  const analysisByAnalystRows = analysisSymbols.length > 0
    ? await queryRows(
      `SELECT symbol, analyst, COUNT(*)::int AS count, MAX(created_at) AS latest_created_at
       FROM analysis
       WHERE exchange = $1
         AND symbol = ANY($2::text[])
         AND created_at >= now() - ($3::int * INTERVAL '1 hour')
       GROUP BY symbol, analyst
       ORDER BY latest_created_at DESC`,
      [exchange, analysisSymbols, hours],
    )
    : [];
  const analysisDetailRows = analysisSymbols.length > 0
    ? await queryRows(
      `SELECT symbol, analyst, signal, confidence, reasoning, metadata, exchange, created_at
       FROM analysis
       WHERE exchange = $1
         AND symbol = ANY($2::text[])
         AND created_at >= now() - ($3::int * INTERVAL '1 hour')
       ORDER BY created_at DESC`,
      [exchange, analysisSymbols, hours],
    )
    : [];
  const recentBlockedSignalDetails = await queryRows(
    `SELECT symbol, COALESCE(block_code, 'none') AS block_code, COUNT(*)::int AS count, MAX(created_at) AS latest_created_at
     FROM signals
     WHERE exchange = $1
       AND created_at >= now() - ($2::int * INTERVAL '1 hour')
       AND COALESCE(block_code, '') IN ('capital_guard_rejected', 'live_position_reentry_blocked')
     GROUP BY symbol, block_code
     ORDER BY latest_created_at DESC`,
    [exchange, hours],
  );
  const currentLivePositions = await loadCurrentLivePositions(exchange);
  const currentOpenSymbols = new Set((currentLivePositions || []).map((row) => String(row.symbol || '').trim()).filter(Boolean));
  const maxOpenPositions = getLiveFireMaxOpenPositions();
  const decisionDiagnostics = buildDecisionFilterDiagnostics(analysisDetailRows, { exchange });
  const likelyActionable = decisionDiagnostics.filter((item) => item.actionability === 'likely_actionable');
  const relaxedProbeCandidates = decisionDiagnostics.filter((item) => item.actionability === 'relaxed_probe_candidate');
  const filteredBeforeSignal = decisionDiagnostics.filter((item) => item.actionability !== 'likely_actionable');
  const analysisBySymbol = Object.fromEntries((analysisRows || []).map((row) => [row.symbol, {
    count: number(row.count),
    latestCreatedAt: row.latest_created_at || null,
  }]));
  const analysisCoveredSymbols = analysisSymbols.filter((symbol) => number(analysisBySymbol[symbol]?.count) > 0);
  const dailyTechnicalCoverage = await buildDailyTechnicalCoverage({
    market,
    exchange,
    symbols: analysisSymbols,
    marketOpen,
  });
  const requiredCoverageSymbols = buildRequiredCoverageSymbols({
    market,
    analysisSymbols,
    decisionDiagnostics,
    dailyTechnicalCoverage,
  });
  const requiredAnalystCoverage = buildRequiredAnalystCoverage({
    market,
    analysisSymbols,
    requiredSymbols: requiredCoverageSymbols,
    analysisRows: analysisByAnalystRows,
    marketOpen,
    dailyTechnicalCoverage,
  });
  const relaxedProbeCooldownHours = getRelaxedProbeRecentTradeCooldownHours();
  const relaxedProbeCooldowns = await loadRecentExecutedSignalCooldowns({
    exchange,
    symbols: relaxedProbeCandidates.map((item) => item.symbol),
    hours: relaxedProbeCooldownHours,
  });
  const relaxedProbeCooldownSymbols = relaxedProbeCandidates
    .map((item) => String(item.symbol || '').trim())
    .filter((symbol) => relaxedProbeCooldowns.has(symbol));
  const relaxedProbeReadyCandidates = relaxedProbeCandidates
    .filter((item) => !relaxedProbeCooldowns.has(String(item.symbol || '').trim()));

  const candidate = candidateRows?.[0] || {};
  const signalsByStatus = {};
  const signalsByAction = {};
  const signalsByBlockCode = {};
  const ignoredSignalsByAction = {};
  let ignoredSignalCount = 0;
  let triggerEligibleBuySignals = 0;
  for (const row of signalRows || []) {
    if (row.ignored === true || row.ignored === 't') {
      ignoredSignalCount += number(row.count);
      ignoredSignalsByAction[row.action] = (ignoredSignalsByAction[row.action] || 0) + number(row.count);
      continue;
    }
    signalsByStatus[row.status] = (signalsByStatus[row.status] || 0) + number(row.count);
    signalsByAction[row.action] = (signalsByAction[row.action] || 0) + number(row.count);
    signalsByBlockCode[row.block_code] = (signalsByBlockCode[row.block_code] || 0) + number(row.count);
    if (row.trigger_eligible === true || row.trigger_eligible === 't') {
      triggerEligibleBuySignals += number(row.count);
    }
  }
  const triggerByState = rowsToStateMap(triggerRows);
  const activeTriggerCount = number(triggerByState.armed) + number(triggerByState.waiting);
  const recentSignalCount = Object.values(signalsByStatus).reduce((sum, count) => sum + number(count), 0);
  const recentBuySignals = number(signalsByAction.BUY);
  const sourceSignalCount = sourceRows.reduce((sum, row) => sum + number(row.signal_count), 0);
  const bottlenecks = [];
  const observations = [];

  function addMarketPrepGap(code, preopenCode = `preopen_${code}`) {
    if (market === 'crypto' || marketOpen) bottlenecks.push(code);
    else observations.push(preopenCode);
  }

  if (number(candidate.active_count) === 0) addMarketPrepGap('discovery_candidate_empty', 'preopen_candidate_universe_empty');
  if (sourceSignalCount === 0) addMarketPrepGap('source_metric_empty', 'preopen_source_metric_empty');
  if (!marketOpen && number(candidate.active_count) > 0) observations.push('market_closed_waiting_open');
  if (marketOpen && number(candidate.active_count) > 0 && recentSignalCount === 0 && analysisCoveredSymbols.length === 0) bottlenecks.push('candidate_not_persisted_to_signal_window');
  if (marketOpen && number(candidate.active_count) > 0 && recentSignalCount === 0 && analysisCoveredSymbols.length > 0 && likelyActionable.length === 0 && relaxedProbeCandidates.length === 0) bottlenecks.push('analysis_completed_no_actionable_signal');
  if (marketOpen && likelyActionable.length > 0 && recentBuySignals === 0) bottlenecks.push('actionable_candidate_waiting_signal_persistence');
  if (marketOpen && relaxedProbeReadyCandidates.length > 0 && recentBuySignals === 0) bottlenecks.push('relaxed_probe_candidate_waiting_l13_probe');
  if (triggerEligibleBuySignals > 0 && activeTriggerCount === 0) bottlenecks.push('buy_signal_without_active_entry_trigger');
  if (
    activeTriggerCount === 0
    && number(triggerByState.expired) > 0
    && (triggerEligibleBuySignals > 0 || likelyActionable.length > 0 || relaxedProbeReadyCandidates.length > 0)
  ) {
    bottlenecks.push('entry_triggers_expired_without_active_replacement');
  }
  if (number(signalsByBlockCode.capital_guard_rejected) > 0) {
    if (currentLivePositions.length >= maxOpenPositions) {
      bottlenecks.push('capital_guard_rejected_recent_buy_signal');
    } else {
      observations.push('historical_capital_guard_rejected_resolved_by_current_position_count');
    }
  }
  if (number(signalsByBlockCode.live_position_reentry_blocked) > 0) {
    const reentryRows = (recentBlockedSignalDetails || []).filter((row) => row.block_code === 'live_position_reentry_blocked');
    const allBlockedSymbolsStillOpen = reentryRows.length > 0
      && reentryRows.every((row) => currentOpenSymbols.has(String(row.symbol || '').trim()));
    if (allBlockedSymbolsStillOpen) {
      observations.push('open_position_reentry_block_expected_for_current_position');
    } else {
      bottlenecks.push('live_position_reentry_blocked_recent_buy_signal');
    }
  }
  if (marketOpen && number(candidate.active_count) > 0 && activeTriggerCount === 0 && recentBuySignals === 0 && likelyActionable.length === 0 && relaxedProbeCandidates.length === 0) bottlenecks.push('candidates_filtered_before_entry_trigger');
  if (number(candidate.active_count) > 0 && analysisSymbols.length > 0) {
    const classifiedCoverage = classifyCoverageBottlenecksForMarket({
      market,
      marketOpen,
      bottlenecks: requiredAnalystCoverage.bottlenecks,
    });
    bottlenecks.push(...classifiedCoverage.bottlenecks);
    observations.push(...classifiedCoverage.observations);
  }
  if (market === 'crypto' && number(dailyTechnicalCoverage.checkedCount) > 0) {
    if (number(dailyTechnicalCoverage.availableCount) === 0) {
      bottlenecks.push('tradingview_daily_technical_coverage_unavailable');
    } else if (number(dailyTechnicalCoverage.bullishCount) === 0) {
      bottlenecks.push('tradingview_daily_no_bullish_candidate');
    }
  }

  return {
    market,
    exchange,
    marketHours,
    candidateUniverse: {
      activeCount: number(candidate.active_count),
      recentCount: number(candidate.recent_count),
      avgScore: candidate.avg_score != null ? number(candidate.avg_score) : null,
      latestDiscoveredAt: candidate.latest_discovered_at || null,
      top: executionCandidates || [],
      promotedCount: Number(executionUniverse?.promotedCount || 0),
      promotedSymbols: executionUniverse?.promotedSymbols || [],
      selectionPolicy: executionUniverse?.selectionPolicy || null,
    },
    sourceMetrics: {
      rows: sourceRows || [],
      signalCount: sourceSignalCount,
    },
    analysisCoverage: {
      checkedCount: analysisSymbols.length,
      coveredCount: analysisCoveredSymbols.length,
      missingCount: Math.max(0, analysisSymbols.length - analysisCoveredSymbols.length),
      coveredSymbols: analysisCoveredSymbols,
      missingSymbols: analysisSymbols.filter((symbol) => !analysisCoveredSymbols.includes(symbol)),
      bySymbol: analysisBySymbol,
      dailyTechnicalCoverage,
      required: requiredAnalystCoverage,
    },
    preopenReadiness: {
      enabled: market !== 'crypto',
      marketOpen,
      candidateUniverseReady: number(candidate.active_count) > 0,
      sourceMetricsReady: sourceSignalCount > 0,
      requiredAnalysisReady: (requiredAnalystCoverage.bottlenecks || []).length === 0,
      pending: observations.filter((code) => String(code).startsWith('preopen_')),
    },
    decisionFilter: {
      checkedCount: decisionDiagnostics.length,
      likelyActionableCount: likelyActionable.length,
      relaxedProbeCount: relaxedProbeCandidates.length,
      relaxedProbeReadyCount: relaxedProbeReadyCandidates.length,
      relaxedProbeCooldownCount: relaxedProbeCooldownSymbols.length,
      filteredCount: filteredBeforeSignal.length,
      likelyActionableSymbols: likelyActionable.map((item) => item.symbol),
      relaxedProbeSymbols: relaxedProbeCandidates.map((item) => item.symbol),
      relaxedProbeReadySymbols: relaxedProbeReadyCandidates.map((item) => item.symbol),
      relaxedProbeCooldown: {
        enabled: relaxedProbeCooldownHours > 0,
        hours: relaxedProbeCooldownHours,
        symbols: relaxedProbeCooldownSymbols,
        bySymbol: Object.fromEntries([...relaxedProbeCooldowns.entries()]),
      },
      top: decisionDiagnostics.slice(0, 5),
    },
    signalPersistence: {
      recentCount: recentSignalCount,
      buyCount: recentBuySignals,
      triggerEligibleBuyCount: triggerEligibleBuySignals,
      ignoredCount: ignoredSignalCount,
      ignoredByAction: ignoredSignalsByAction,
      byStatus: signalsByStatus,
      byAction: signalsByAction,
      byBlockCode: signalsByBlockCode,
      recentBlockedSignalDetails,
    },
    currentPositions: {
      openCount: currentLivePositions.length,
      maxOpenPositions,
      symbols: currentLivePositions.map((row) => row.symbol).filter(Boolean),
    },
    entryTriggers: {
      activeCount: activeTriggerCount,
      recentByState: triggerByState,
      latest: latestTriggers || [],
    },
    bottlenecks,
    observations,
  };
}

function buildAutopilotFunnel({ historyFile, hours }) {
  const cutoff = Date.now() - (Math.max(1, Number(hours || 24)) * 3600 * 1000);
  const rows = readPositionRuntimeAutopilotHistoryLines(historyFile)
    .filter((row) => {
      const ts = new Date(row?.recordedAt || 0).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });
  const totals = {
    samples: rows.length,
    candidateCount: 0,
    executedCount: 0,
    queuedCount: 0,
    retryingCount: 0,
    skippedCount: 0,
    failureCount: 0,
    marketQueueTotal: 0,
    marketQueueWaitingOpen: 0,
  };
  for (const row of rows) {
    totals.candidateCount += number(row.dispatchCandidateCount);
    totals.executedCount += number(row.dispatchExecutedCount);
    totals.queuedCount += number(row.dispatchQueuedCount);
    totals.retryingCount += number(row.dispatchRetryingCount);
    totals.skippedCount += number(row.dispatchSkippedCount);
    totals.failureCount += number(row.dispatchFailureCount);
    totals.marketQueueTotal += number(row.dispatchMarketQueue?.total);
    totals.marketQueueWaitingOpen += number(row.dispatchMarketQueue?.waitingMarketOpen);
  }
  return {
    historyFile,
    latestRecordedAt: rows[rows.length - 1]?.recordedAt || null,
    latestStatus: rows[rows.length - 1]?.status || null,
    totals,
  };
}

export async function buildLunaDiscoveryFunnelReport({
  hours = 24,
  market = 'all',
  historyFile = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
} = {}) {
  await db.initSchema();
  await ensureCandidateUniverseTable();
  await ensureLunaDiscoveryEntryTables();
  const markets = normalizeMarketScope(market);
  const marketReports = await Promise.all(markets.map((m) => buildMarketFunnel(m, { hours })));
  const autopilot = buildAutopilotFunnel({ historyFile, hours });
  const allBottlenecks = marketReports.flatMap((item) => item.bottlenecks.map((code) => `${item.market}:${code}`));
  const preopenGaps = marketReports.flatMap((item) => (item.observations || [])
    .filter((code) => String(code).startsWith('preopen_'))
    .map((code) => `${item.market}:${code}`));
  const liveMarketReports = marketReports.filter((item) => item.market === 'crypto' || item.marketHours?.isOpen === true);
  const candidateTotal = marketReports.reduce((sum, item) => sum + item.candidateUniverse.activeCount, 0);
  const activeTriggerTotal = liveMarketReports.reduce((sum, item) => sum + item.entryTriggers.activeCount, 0);
  const actionableWaitingTotal = liveMarketReports.reduce((sum, item) => sum + number(item.decisionFilter?.likelyActionableCount), 0);
  const relaxedProbeReadyTotal = liveMarketReports.reduce((sum, item) => sum + number(item.decisionFilter?.relaxedProbeReadyCount), 0);
  const recommendations = [];
  if (candidateTotal === 0) recommendations.push('all_markets_discovery_candidate_empty');
  if (allBottlenecks.length === 0 && preopenGaps.length > 0) recommendations.push('preopen_market_preparation_pending');
  if (candidateTotal > 0 && activeTriggerTotal === 0 && actionableWaitingTotal > 0) recommendations.push('actionable_candidates_waiting_market_cycle_or_signal_persistence');
  if (candidateTotal > 0 && activeTriggerTotal === 0 && actionableWaitingTotal === 0 && relaxedProbeReadyTotal > 0) recommendations.push('relaxed_probe_candidates_waiting_l13_probe');
  if (
    allBottlenecks.length > 0
    && candidateTotal > 0
    && activeTriggerTotal === 0
    && actionableWaitingTotal === 0
    && relaxedProbeReadyTotal === 0
  ) {
    recommendations.push('candidate_to_entry_trigger_funnel_needs_review');
  }
  if (autopilot.totals.samples === 0) recommendations.push('runtime_autopilot_history_missing');
  if (autopilot.totals.candidateCount === 0) recommendations.push('dispatch_idle_no_candidates_in_window');
  return {
    ok: true,
    status: allBottlenecks.length
      ? 'luna_discovery_funnel_attention'
      : preopenGaps.length
        ? 'luna_discovery_funnel_preopen_pending'
        : 'luna_discovery_funnel_clear',
    generatedAt: new Date().toISOString(),
    hours,
    market,
    markets: marketReports,
    autopilot,
    bottlenecks: allBottlenecks,
    preopenGaps,
    recommendations,
    nextAction: recommendations.includes('candidate_to_entry_trigger_funnel_needs_review')
      ? 'inspect_score_fusion_predictive_validation_entry_trigger_thresholds'
      : recommendations.includes('relaxed_probe_candidates_waiting_l13_probe')
        ? 'run_l13_probe_with_existing_risk_and_entry_guards'
      : recommendations.includes('actionable_candidates_waiting_market_cycle_or_signal_persistence')
        ? 'run_or_wait_next_market_cycle_to_persist_buy_signal'
      : recommendations.includes('all_markets_discovery_candidate_empty')
        ? 'inspect_discovery_orchestrator_sources'
        : recommendations.includes('preopen_market_preparation_pending')
          ? 'run_or_wait_preopen_refresh_before_next_session'
        : recommendations.includes('dispatch_idle_no_candidates_in_window')
          ? 'continue_observation_or_lower_discovery_thresholds_after_review'
          : 'continue_observation',
  };
}

export function renderLunaDiscoveryFunnelReport(report = {}) {
  const lines = [
    '🔎 루나 discovery funnel 병목 리포트',
    `checkedAt: ${report.generatedAt || 'n/a'}`,
    `window: ${report.hours || 24}h / market=${report.market || 'all'}`,
    `status: ${report.status || 'unknown'}`,
  ];
  for (const item of report.markets || []) {
    const required = item.analysisCoverage?.required || {};
    const requiredLine = (required.requiredAnalysts || [])
      .map((analyst) => {
        const covered = required.byAnalyst?.[analyst]?.symbols?.length || 0;
        const total = required.scope?.checkedSymbols?.length || item.analysisCoverage?.checkedCount || 0;
        return `${analyst}:${covered}/${total}`;
      })
      .join(' ');
    lines.push(
      `${item.market}: market=${item.marketHours?.state || 'unknown'} candidates=${item.candidateUniverse?.activeCount || 0} analysis=${item.analysisCoverage?.coveredCount || 0}/${item.analysisCoverage?.checkedCount || 0} actionable=${item.decisionFilter?.likelyActionableCount || 0} recentSignals=${item.signalPersistence?.recentCount || 0} buySignals=${item.signalPersistence?.buyCount || 0} activeTriggers=${item.entryTriggers?.activeCount || 0} bottlenecks=${(item.bottlenecks || []).join(',') || 'none'}`,
    );
    if ((item.observations || []).length > 0) lines.push(`  observations: ${(item.observations || []).join(',')}`);
    if (requiredLine) lines.push(`  required_analysis: ${requiredLine}`);
  }
  lines.push(`dispatch: samples=${report.autopilot?.totals?.samples || 0} candidates=${report.autopilot?.totals?.candidateCount || 0} executed=${report.autopilot?.totals?.executedCount || 0} failures=${report.autopilot?.totals?.failureCount || 0}`);
  lines.push(`nextAction: ${report.nextAction || 'n/a'}`);
  return lines.join('\n');
}

async function publishReport(report) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.bottlenecks?.length ? 2 : 1,
    message: renderLunaDiscoveryFunnelReport(report),
    payload: report,
  });
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaDiscoveryFunnelReport(args);
  if (args.telegram) await publishReport(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLunaDiscoveryFunnelReport(report));
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-discovery-funnel-report 실패:',
  });
}
