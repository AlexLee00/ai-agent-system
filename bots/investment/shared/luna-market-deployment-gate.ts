// @ts-nocheck

import * as db from './db.ts';
import { getParameter } from './luna-parameter-store.ts';

export const LUNA_MARKET_GATE_MARKETS = Object.freeze(['overseas', 'domestic', 'crypto']);
export const LUNA_MARKET_GATE_PARAM_KEYS = Object.freeze({
  fullThreshold: 'g0.market_gate.full_threshold',
  reducedThreshold: 'g0.market_gate.reduced_threshold',
  reducedSizeMultiplier: 'g0.market_gate.reduced_size_multiplier',
  usTransitionWeight: 'g0.market_gate.us_transition_weight',
  regimeDirectionWeight: 'g0.market_gate.regime_direction_weight',
});

export const LUNA_MARKET_GATE_DEFAULTS = Object.freeze({
  fullThreshold: 70,
  reducedThreshold: 40,
  reducedSizeMultiplier: 0.6,
  usTransitionWeight: 0.2,
  regimeDirectionWeight: 1.5,
  minAvailableSignals: 2,
});

export const LUNA_MARKET_GATE_HISTORY_SCHEMA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS investment.luna_market_gate_history (
    id          BIGSERIAL PRIMARY KEY,
    market      TEXT NOT NULL CHECK (market IN ('overseas', 'domestic', 'crypto')),
    score       NUMERIC,
    deployment  TEXT NOT NULL CHECK (deployment IN ('full', 'reduced', 'halt', 'unknown')),
    signals     JSONB NOT NULL DEFAULT '{}'::jsonb,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_luna_market_gate_history_market_time
     ON investment.luna_market_gate_history (market, computed_at DESC)`,
]);

const MARKET_ALIASES = Object.freeze({
  kis_overseas: 'overseas',
  overseas: 'overseas',
  us: 'overseas',
  usa: 'overseas',
  kis_domestic: 'domestic',
  kis: 'domestic',
  domestic: 'domestic',
  kr: 'domestic',
  korea: 'domestic',
  binance: 'crypto',
  crypto: 'crypto',
});

function finite(value: any, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min = 0, max = 100) {
  const n = finite(value, min);
  return Math.min(max, Math.max(min, n));
}

function round(value: any, digits = 2) {
  const n = finite(value, null);
  return n == null ? null : Number(n.toFixed(digits));
}

function scoreFromRange(value: any, lowGood: number, highBad: number) {
  const n = finite(value, null);
  if (n == null) return null;
  return round(clamp(100 - ((n - lowGood) / Math.max(0.000001, highBad - lowGood)) * 100));
}

function scoreFromMomentumPct(value: any, minBad = -3, maxGood = 3) {
  const n = finite(value, null);
  if (n == null) return null;
  return round(clamp(((n - minBad) / Math.max(0.000001, maxGood - minBad)) * 100));
}

export function regimeDirectionScore(dominant: any, momentum20: any) {
  const regime = String(dominant || '').trim().toLowerCase();
  const momentum = finite(momentum20, null);
  if (momentum == null) return 50;
  if (regime === 'bull' && momentum > 0) return round(clamp(50 + momentum * 200, 50, 90));
  if (regime === 'bear' && momentum < 0) return round(clamp(50 + momentum * 200, 10, 50));
  return 50;
}

function unavailableSignal(name: string, source: string, error: any = 'unavailable', weight = 1) {
  return {
    name,
    source,
    raw: null,
    score: null,
    weight,
    available: false,
    error: String(error?.message || error || 'unavailable'),
  };
}

function signal(name: string, raw: any, score: any, weight = 1, source = 'computed') {
  const normalizedScore = round(score);
  return {
    name,
    source,
    raw,
    score: normalizedScore,
    weight,
    available: normalizedScore != null,
  };
}

function normalizeSignals(signals = []) {
  return (Array.isArray(signals) ? signals : [])
    .filter(Boolean)
    .map((item) => ({
      name: String(item.name || item.id || 'unknown'),
      source: item.source || 'fixture',
      raw: item.raw ?? null,
      score: round(item.score),
      weight: Math.max(0, finite(item.weight, 1)),
      available: item.available !== false && round(item.score) != null,
      error: item.error || null,
    }));
}

export function normalizeMarketDeploymentMarket(market: any = 'crypto') {
  const key = String(market || 'crypto').trim().toLowerCase();
  const normalized = MARKET_ALIASES[key];
  if (!normalized) throw new Error(`invalid_luna_market_gate_market:${market}`);
  return normalized;
}

async function numericParameter(key: string, fallback: number, options: any = {}) {
  if (options.parameters && Object.prototype.hasOwnProperty.call(options.parameters, key)) {
    return finite(options.parameters[key], fallback);
  }
  const getParameterFn = options.getParameterFn || getParameter;
  try {
    const row = await getParameterFn(key, 'global', {
      bypassCache: options.bypassParameterCache === true,
      env: options.env || process.env,
      queryFn: options.queryFn || db.query,
    });
    return finite(row?.value, fallback);
  } catch {
    return fallback;
  }
}

export async function loadMarketGateParameters(options: any = {}) {
  return {
    fullThreshold: await numericParameter(
      LUNA_MARKET_GATE_PARAM_KEYS.fullThreshold,
      LUNA_MARKET_GATE_DEFAULTS.fullThreshold,
      options,
    ),
    reducedThreshold: await numericParameter(
      LUNA_MARKET_GATE_PARAM_KEYS.reducedThreshold,
      LUNA_MARKET_GATE_DEFAULTS.reducedThreshold,
      options,
    ),
    reducedSizeMultiplier: await numericParameter(
      LUNA_MARKET_GATE_PARAM_KEYS.reducedSizeMultiplier,
      LUNA_MARKET_GATE_DEFAULTS.reducedSizeMultiplier,
      options,
    ),
    usTransitionWeight: await numericParameter(
      LUNA_MARKET_GATE_PARAM_KEYS.usTransitionWeight,
      LUNA_MARKET_GATE_DEFAULTS.usTransitionWeight,
      options,
    ),
    regimeDirectionWeight: await numericParameter(
      LUNA_MARKET_GATE_PARAM_KEYS.regimeDirectionWeight,
      LUNA_MARKET_GATE_DEFAULTS.regimeDirectionWeight,
      options,
    ),
    minAvailableSignals: LUNA_MARKET_GATE_DEFAULTS.minAvailableSignals,
  };
}

function classifyDeployment(score: any, params: any, availableCount: number) {
  if (availableCount < (params.minAvailableSignals || 2)) {
    return { deployment: 'unknown', effectiveDeployment: 'reduced', reason: 'insufficient_available_signals' };
  }
  const numericScore = finite(score, null);
  if (numericScore == null) {
    return { deployment: 'unknown', effectiveDeployment: 'reduced', reason: 'score_unavailable' };
  }
  if (numericScore > Number(params.fullThreshold)) {
    return { deployment: 'full', effectiveDeployment: 'full', reason: 'score_above_full_threshold' };
  }
  if (numericScore < Number(params.reducedThreshold)) {
    return { deployment: 'halt', effectiveDeployment: 'halt', reason: 'score_below_reduced_threshold' };
  }
  return { deployment: 'reduced', effectiveDeployment: 'reduced', reason: 'score_between_thresholds' };
}

export function combineMarketGateSignals(market: string, signals = [], params = LUNA_MARKET_GATE_DEFAULTS, now = new Date()) {
  const normalizedSignals = normalizeSignals(signals);
  const available = normalizedSignals.filter((item) => item.available && item.weight > 0);
  const weightSum = available.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const score = weightSum > 0
    ? available.reduce((sum, item) => sum + Number(item.score) * Number(item.weight || 0), 0) / weightSum
    : null;
  const classified = classifyDeployment(score, params, available.length);
  const thresholds = {
    full: Number(params.fullThreshold),
    reduced: Number(params.reducedThreshold),
    reducedSizeMultiplier: Number(params.reducedSizeMultiplier),
  };

  return {
    ok: true,
    market: normalizeMarketDeploymentMarket(market),
    score: round(score),
    deployment: classified.deployment,
    effectiveDeployment: classified.effectiveDeployment,
    reason: classified.reason,
    availableSignalCount: available.length,
    totalSignalCount: normalizedSignals.length,
    thresholds,
    signals: normalizedSignals,
    computedAt: now.toISOString(),
    shadowOnly: true,
    liveMutation: false,
  };
}

async function fetchYahooChart(symbol: string, options: any = {}) {
  const fetchFn = options.fetchFn || fetch;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10d&interval=1d`;
  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'luna-market-deployment-gate/1.0' },
    signal: AbortSignal.timeout(options.timeoutMs || 8000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const data = await res.json();
  const quote = data?.chart?.result?.[0]?.indicators?.quote?.[0] || {};
  const closes = (quote.close || []).map((v) => Number(v)).filter(Number.isFinite);
  const last = closes.at(-1);
  const prev = closes.at(-2) ?? last;
  const first = closes.at(0) ?? last;
  return {
    symbol,
    last,
    dayChangePct: prev > 0 ? ((last - prev) / prev) * 100 : null,
    trendPct: first > 0 ? ((last - first) / first) * 100 : null,
    closeCount: closes.length,
  };
}

async function safeSignal(name: string, source: string, weight: number, work: any) {
  try {
    const item = await work();
    return item || unavailableSignal(name, source, 'no_data', weight);
  } catch (error) {
    return unavailableSignal(name, source, error, weight);
  }
}

function normalizeRegimeDominant(value: any) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('bull')) return 'bull';
  if (text.includes('bear')) return 'bear';
  if (text.includes('volatile')) return 'volatile';
  if (text.includes('sideways') || text.includes('ranging')) return 'sideways';
  return text || null;
}

function regimeStateFromOptions(market: string, options: any = {}) {
  const normalizedMarket = normalizeMarketDeploymentMarket(market);
  const byMarket = options.regimeByMarket;
  if (byMarket?.get) return byMarket.get(normalizedMarket) || byMarket.get(market) || null;
  if (byMarket && typeof byMarket === 'object') return byMarket[normalizedMarket] || byMarket[market] || null;
  const regimes = Array.isArray(options.regimes) ? options.regimes : [];
  return regimes.find((row) => normalizeMarketDeploymentMarket(row?.market || normalizedMarket) === normalizedMarket) || null;
}

function averageSnapshotTrend(regime: any = {}) {
  const snapshots = (regime.snapshots || []).filter((item) => Number.isFinite(Number(item.trendPct ?? item.dayChangePct)));
  if (!snapshots.length) return null;
  const avgTrendPct = snapshots.reduce((sum, item) => sum + Number(item.trendPct ?? item.dayChangePct ?? 0), 0) / snapshots.length;
  return avgTrendPct / 100;
}

function regimeDirectionSignalFromState(market: string, state: any, weight: number) {
  if (!state) return null;
  const dominant = normalizeRegimeDominant(state.dominant || state.current_regime || state.currentRegime || state.regime);
  const momentum20 = finite(state.features?.momentum20 ?? state.momentum20, null);
  if (!dominant || momentum20 == null) return null;
  return signal(
    'regime_direction',
    {
      dominant,
      momentum20: round(momentum20, 6),
      confidence: state.confidence ?? null,
      source: state.source || 'hmm',
    },
    regimeDirectionScore(dominant, momentum20),
    weight,
    'luna-regime-engine',
  );
}

function regimeDirectionSignalFromFallback(regime: any, weight: number) {
  if (!regime) return null;
  const dominant = normalizeRegimeDominant(regime.regime || regime.bias);
  const momentum20 = averageSnapshotTrend(regime);
  if (!dominant || momentum20 == null) return null;
  return signal(
    'regime_direction',
    {
      dominant,
      momentum20: round(momentum20, 6),
      confidence: regime.confidence ?? null,
      source: 'market-regime',
    },
    regimeDirectionScore(dominant, momentum20),
    weight,
    'market-regime',
  );
}

async function buildRegimeDirectionSignal(market: string, options: any = {}, fallbackRegime: any = null) {
  const weight = finite(options.params?.regimeDirectionWeight, LUNA_MARKET_GATE_DEFAULTS.regimeDirectionWeight);
  const stateSignal = regimeDirectionSignalFromState(market, regimeStateFromOptions(market, options), weight);
  if (stateSignal) return stateSignal;
  if (fallbackRegime) {
    const fallbackSignal = regimeDirectionSignalFromFallback(fallbackRegime, weight);
    if (fallbackSignal) return fallbackSignal;
  }
  const { getMarketRegime } = await import('./market-regime.ts');
  const fallbackMarket = market === 'overseas' ? 'kis_overseas' : market === 'domestic' ? 'kis' : 'binance';
  const regime = await getMarketRegime(fallbackMarket);
  return regimeDirectionSignalFromFallback(regime, weight) || unavailableSignal('regime_direction', 'market-regime', 'regime_direction_unavailable', weight);
}

async function collectOverseasSignals(options: any = {}) {
  if (options.signalInputs?.overseas) return normalizeSignals(options.signalInputs.overseas);
  const { getMarketRegime } = await import('./market-regime.ts');

  const vixSignal = await safeSignal('vix_level', 'yahoo:^VIX', 1.2, async () => {
    const vix = options.vixSnapshot || await fetchYahooChart('^VIX', options);
    return signal('vix_level', { last: vix.last }, scoreFromRange(vix.last, 12, 35), 1.2, 'yahoo:^VIX');
  });

  const benchmarkSignal = await safeSignal('us_benchmark_trend', 'market-regime:kis_overseas', 1, async () => {
    const regime = options.usRegime || await getMarketRegime('kis_overseas');
    const snapshots = (regime.snapshots || []).filter((item) => Number.isFinite(Number(item.dayChangePct)));
    const avgTrend = snapshots.length
      ? snapshots.reduce((sum, item) => sum + Number(item.trendPct ?? item.dayChangePct ?? 0), 0) / snapshots.length
      : null;
    return signal(
      'us_benchmark_trend',
      { bias: regime.bias, regime: regime.regime, avgTrendPct: round(avgTrend), count: snapshots.length },
      scoreFromMomentumPct(avgTrend, -4, 4),
      1,
      'market-regime:kis_overseas',
    );
  });
  const regimeDirectionSignal = await safeSignal('regime_direction', 'luna-regime-engine', finite(options.params?.regimeDirectionWeight, LUNA_MARKET_GATE_DEFAULTS.regimeDirectionWeight), async () => (
    buildRegimeDirectionSignal('overseas', options, options.usRegime)
  ));

  return [
    vixSignal,
    benchmarkSignal,
    regimeDirectionSignal,
    unavailableSignal('vix_term_structure', 'not_configured', 'source_not_available_yet', 0.6),
    unavailableSignal('put_call_ratio', 'not_configured', 'source_not_available_yet', 0.6),
  ];
}

async function collectDomesticSignals(options: any = {}) {
  if (options.signalInputs?.domestic) return normalizeSignals(options.signalInputs.domestic);
  const { getMarketRegime } = await import('./market-regime.ts');
  const queryFn = options.queryFn || db.query;

  const volSignal = await safeSignal('kospi_realized_vol_proxy', 'market-regime:kis', 1, async () => {
    const regime = options.domesticRegime || await getMarketRegime('kis');
    const snapshots = (regime.snapshots || []).filter((item) => Number.isFinite(Number(item.dayChangePct)));
    const avgAbs = snapshots.length
      ? snapshots.reduce((sum, item) => sum + Math.abs(Number(item.dayChangePct || 0)), 0) / snapshots.length
      : null;
    return signal(
      'kospi_realized_vol_proxy',
      { bias: regime.bias, regime: regime.regime, avgAbsDayChangePct: round(avgAbs), count: snapshots.length },
      scoreFromRange(avgAbs, 0.4, 3),
      1,
      'market-regime:kis',
    );
  });

  const flowSignal = await safeSignal('korea_shadow_flow', 'korea_public_data_shadow_signals', 1, async () => {
    const rows = await queryFn(
      `SELECT action, COALESCE(confidence, signal_score, 0.5)::float AS confidence
         FROM korea_public_data_shadow_signals
        WHERE observed_at > NOW() - INTERVAL '24 hours'
        ORDER BY observed_at DESC
        LIMIT 200`,
    );
    const buy = rows.filter((row) => String(row.action || '').toLowerCase().includes('buy'));
    const sell = rows.filter((row) => String(row.action || '').toLowerCase().includes('sell'));
    const total = rows.length;
    const buyScore = buy.reduce((sum, row) => sum + Number(row.confidence || 0), 0);
    const sellScore = sell.reduce((sum, row) => sum + Number(row.confidence || 0), 0);
    const normalized = total > 0 ? clamp(50 + ((buyScore - sellScore) / Math.max(1, total)) * 50) : null;
    return signal('korea_shadow_flow', { rows: total, buy: buy.length, sell: sell.length }, normalized, 1, 'korea_public_data_shadow_signals');
  });

  const fxSignal = await safeSignal('usdkrw_momentum', 'fx_rates', 0.8, async () => {
    const rows = await queryFn(
      `SELECT inverse_rate, effective_date
         FROM fx_rates
        WHERE base_currency = 'KRW'
          AND quote_currency = 'USD'
        ORDER BY effective_date DESC
        LIMIT 2`,
    );
    if (!rows?.length) return unavailableSignal('usdkrw_momentum', 'fx_rates', 'no_fx_rows', 0.8);
    const latest = Number(rows[0].inverse_rate);
    const prev = Number(rows[1]?.inverse_rate || latest);
    const changePct = prev > 0 ? ((latest - prev) / prev) * 100 : 0;
    return signal('usdkrw_momentum', { latestUsdKrw: latest, changePct: round(changePct) }, clamp(50 - changePct * 15), 0.8, 'fx_rates');
  });

  const usScore = finite(options.usGate?.score, null);
  const transitionWeight = finite(options.params?.usTransitionWeight, LUNA_MARKET_GATE_DEFAULTS.usTransitionWeight);
  const transitionSignal = usScore == null
    ? unavailableSignal('us_gate_transition', 'market_gate:overseas', 'us_gate_unavailable', transitionWeight)
    : signal('us_gate_transition', { usScore, usDeployment: options.usGate.deployment }, usScore, transitionWeight, 'market_gate:overseas');
  const regimeDirectionSignal = await safeSignal('regime_direction', 'luna-regime-engine', finite(options.params?.regimeDirectionWeight, LUNA_MARKET_GATE_DEFAULTS.regimeDirectionWeight), async () => (
    buildRegimeDirectionSignal('domestic', options, options.domesticRegime)
  ));

  return [volSignal, flowSignal, fxSignal, transitionSignal, regimeDirectionSignal];
}

function scoreFundingRate(rate: any) {
  const n = finite(rate, null);
  if (n == null) return null;
  const absPct = Math.abs(n * 100);
  return round(clamp(100 - (absPct / 0.1) * 100));
}

async function collectCryptoSignals(options: any = {}) {
  if (options.signalInputs?.crypto) return normalizeSignals(options.signalInputs.crypto);
  const { getOnchainSummary, getSpotTicker24h } = await import('./onchain-data.ts');

  const btcVolSignal = await safeSignal('btc_realized_vol_proxy', 'binance:BTCUSDT:ticker24h', 1, async () => {
    const ticker = options.btcTicker || await getSpotTicker24h('BTCUSDT');
    const last = Number(ticker?.lastPrice || 0);
    const high = Number(ticker?.highPrice || 0);
    const low = Number(ticker?.lowPrice || 0);
    const rangePct = last > 0 ? ((high - low) / last) * 100 : null;
    return signal('btc_realized_vol_proxy', { rangePct: round(rangePct), priceChangePercent: ticker?.priceChangePercent ?? null }, scoreFromRange(rangePct, 1, 8), 1, 'binance:BTCUSDT:ticker24h');
  });

  const onchainSignal = await safeSignal('btc_onchain_flow', 'onchain-data:BTCUSDT', 1, async () => {
    const summary = options.onchainSummary || await getOnchainSummary('BTCUSDT');
    if (!summary?.spotFlow && !summary?.longShortRatio) {
      return unavailableSignal('btc_onchain_flow', 'onchain-data:BTCUSDT', 'empty_onchain_summary', 1);
    }
    let score = 50;
    const spotSignal = String(summary?.spotFlow?.signal || '');
    const imbalance = Number(summary?.spotFlow?.tradePressureImbalance ?? summary?.spotFlow?.depthImbalance ?? 0);
    score += clamp(imbalance * 100, -20, 20);
    if (spotSignal === 'spot_momentum_bid' || spotSignal === 'taker_buy_pressure') score += 12;
    if (spotSignal === 'spot_pressure_ask' || spotSignal === 'taker_sell_pressure') score -= 12;
    if (summary?.longShortRatio?.signal === 'crowd_long') score -= 8;
    if (summary?.longShortRatio?.signal === 'crowd_short') score += 6;
    return signal('btc_onchain_flow', { spotSignal, longShortSignal: summary?.longShortRatio?.signal || null, imbalance: round(imbalance, 4) }, clamp(score), 1, 'onchain-data:BTCUSDT');
  });

  const fundingSignal = await safeSignal('btc_funding_rate', 'onchain-data:BTCUSDT', 0.8, async () => {
    const summary = options.onchainSummary || await getOnchainSummary('BTCUSDT');
    const rate = finite(summary?.funding?.rate, null);
    return signal('btc_funding_rate', { rate, signal: summary?.funding?.signal || null }, scoreFundingRate(rate), 0.8, 'onchain-data:BTCUSDT');
  });

  const usScore = finite(options.usGate?.score, null);
  const transitionWeight = finite(options.params?.usTransitionWeight, LUNA_MARKET_GATE_DEFAULTS.usTransitionWeight);
  const transitionSignal = usScore == null
    ? unavailableSignal('us_gate_transition', 'market_gate:overseas', 'us_gate_unavailable', transitionWeight)
    : signal('us_gate_transition', { usScore, usDeployment: options.usGate.deployment }, usScore, transitionWeight, 'market_gate:overseas');
  const regimeDirectionSignal = await safeSignal('regime_direction', 'luna-regime-engine', finite(options.params?.regimeDirectionWeight, LUNA_MARKET_GATE_DEFAULTS.regimeDirectionWeight), async () => (
    buildRegimeDirectionSignal('crypto', options)
  ));

  return [
    btcVolSignal,
    onchainSignal,
    fundingSignal,
    unavailableSignal('btc_dominance', 'not_configured', 'source_not_available_yet', 0.5),
    transitionSignal,
    regimeDirectionSignal,
  ];
}

async function collectSignals(market: string, options: any = {}) {
  if (options.collectors?.[market]) {
    try {
      return normalizeSignals(await options.collectors[market](options));
    } catch (error) {
      return [unavailableSignal('collector_error', `collector:${market}`, error, 1)];
    }
  }
  if (market === 'overseas') return collectOverseasSignals(options);
  if (market === 'domestic') return collectDomesticSignals(options);
  return collectCryptoSignals(options);
}

export async function computeMarketDeploymentGate(market: any = 'crypto', options: any = {}) {
  const normalizedMarket = normalizeMarketDeploymentMarket(market);
  const now = options.now ? new Date(options.now) : new Date();
  const params = options.params || await loadMarketGateParameters(options);
  const usGate = normalizedMarket === 'overseas'
    ? null
    : options.usGate || await computeMarketDeploymentGate('overseas', { ...options, params, usGate: null });
  const signals = await collectSignals(normalizedMarket, { ...options, params, usGate });
  return combineMarketGateSignals(normalizedMarket, signals, params, now);
}

export async function computeAllMarketDeploymentGates(options: any = {}) {
  const params = await loadMarketGateParameters(options);
  const overseas = await computeMarketDeploymentGate('overseas', { ...options, params });
  const domestic = await computeMarketDeploymentGate('domestic', { ...options, params, usGate: overseas });
  const crypto = await computeMarketDeploymentGate('crypto', { ...options, params, usGate: overseas });
  return [overseas, domestic, crypto];
}

export async function ensureMarketGateHistorySchema(runFn = db.run) {
  for (const statement of LUNA_MARKET_GATE_HISTORY_SCHEMA_SQL) {
    await runFn(statement);
  }
}

export function formatMarketGateDailyLine(rows = []) {
  const byMarket = new Map((rows || []).map((row) => [normalizeMarketDeploymentMarket(row.market), row]));
  if (byMarket.size === 0) return '게이트: 데이터 없음';
  const parts = [
    ['overseas', 'US'],
    ['domestic', 'KR'],
    ['crypto', 'crypto'],
  ].map(([market, label]) => {
    const row = byMarket.get(market);
    if (!row) return `${label} 없음`;
    const score = round(row.score);
    const deployment = row.effectiveDeployment || row.effective_deployment || row.deployment || 'unknown';
    return `${label} ${deployment}(${score == null ? 'n/a' : score})`;
  });
  return `게이트: ${parts.join('·')}`;
}

export const _testOnly = {
  clamp,
  scoreFromRange,
  scoreFromMomentumPct,
  regimeDirectionScore,
  classifyDeployment,
  normalizeSignals,
  unavailableSignal,
  signal,
  collectSignals,
  regimeDirectionSignalFromState,
  regimeDirectionSignalFromFallback,
};

export default {
  computeMarketDeploymentGate,
  computeAllMarketDeploymentGates,
  combineMarketGateSignals,
  ensureMarketGateHistorySchema,
  formatMarketGateDailyLine,
};
