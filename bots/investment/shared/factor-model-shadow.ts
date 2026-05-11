// @ts-nocheck

const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1, fallback = 0) {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function round(value, digits = 4) {
  return Number(Number(value || 0).toFixed(digits));
}

function normalizeExchange(value) {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'crypto') return 'binance';
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  return VALID_EXCHANGES.has(raw) ? raw : 'binance';
}

export function marketForFactorExchange(exchange) {
  const normalized = normalizeExchange(exchange);
  if (normalized === 'kis') return 'domestic';
  if (normalized === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function parseJsonMaybe(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeBars(candidate = {}) {
  const sources = [
    candidate.bars,
    candidate.ohlcv,
    candidate.candles,
    candidate.block_meta?.bars,
    candidate.block_meta?.ohlcv,
    candidate.block_meta?.candles,
    candidate.trigger_context?.bars,
    candidate.trigger_context?.ohlcv,
    candidate.trigger_meta?.bars,
    candidate.trigger_meta?.ohlcv,
    candidate.factorContext?.bars,
  ];
  const raw = sources.find((item) => Array.isArray(item) && item.length > 0) || [];
  return raw.map((bar) => {
    if (Array.isArray(bar)) {
      return {
        close: finiteNumber(bar[4] ?? bar[1], NaN),
        high: finiteNumber(bar[2] ?? bar[4] ?? bar[1], NaN),
        low: finiteNumber(bar[3] ?? bar[4] ?? bar[1], NaN),
        volume: finiteNumber(bar[5], 0),
      };
    }
    return {
      close: finiteNumber(bar.close ?? bar.c ?? bar.price, NaN),
      high: finiteNumber(bar.high ?? bar.h ?? bar.close ?? bar.price, NaN),
      low: finiteNumber(bar.low ?? bar.l ?? bar.close ?? bar.price, NaN),
      volume: finiteNumber(bar.volume ?? bar.v ?? bar.quoteVolume ?? bar.qv, 0),
    };
  }).filter((bar) => Number.isFinite(bar.close) && bar.close > 0).slice(-120);
}

function returnsFromBars(bars = []) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = finiteNumber(bars[i - 1]?.close, 0);
    const curr = finiteNumber(bars[i]?.close, 0);
    if (prev > 0 && curr > 0) out.push((curr - prev) / prev);
  }
  return out;
}

function stdev(values = []) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
  return Math.sqrt(variance);
}

function scoreMomentum(candidate, bars) {
  if (bars.length >= 5) {
    const first = bars[0].close;
    const last = bars[bars.length - 1].close;
    const ret = first > 0 ? (last - first) / first : 0;
    return {
      score: clamp(0.5 + ret * 4, 0, 1, 0.5),
      raw: round(ret, 6),
      source: 'ohlcv_return',
      available: true,
    };
  }
  const predictive = finiteNumber(candidate.predictiveScore ?? candidate.predictive_score ?? candidate.prediction?.score, NaN);
  if (Number.isFinite(predictive)) {
    return { score: clamp(predictive, 0, 1, 0.5), raw: round(predictive, 4), source: 'predictive_score', available: true };
  }
  const confidence = finiteNumber(candidate.confidence, NaN);
  if (Number.isFinite(confidence)) {
    return { score: clamp(confidence, 0, 1, 0.5), raw: round(confidence, 4), source: 'confidence_fallback', available: true };
  }
  return { score: 0.5, raw: null, source: 'missing_factor', available: false };
}

function scoreVolatility(candidate, bars) {
  const returns = returnsFromBars(bars);
  if (returns.length >= 4) {
    const vol = stdev(returns);
    return {
      score: clamp(1 - (vol / 0.08), 0, 1, 0.5),
      raw: round(vol, 6),
      source: 'ohlcv_return_stdev',
      available: true,
    };
  }
  const atr = finiteNumber(candidate.atr ?? candidate.atr_value ?? candidate.block_meta?.atr, NaN);
  const price = finiteNumber(candidate.entry_price ?? candidate.entryPrice ?? candidate.target_price ?? candidate.targetPrice, NaN);
  if (Number.isFinite(atr) && Number.isFinite(price) && price > 0) {
    const atrPct = atr / price;
    return { score: clamp(1 - (atrPct / 0.08), 0, 1, 0.5), raw: round(atrPct, 6), source: 'atr_pct', available: true };
  }
  return { score: 0.5, raw: null, source: 'missing_factor', available: false };
}

function scoreLiquidity(candidate, bars) {
  const quoteVolume = finiteNumber(
    candidate.quoteVolume ?? candidate.quote_volume ?? candidate.volumeQuote ?? candidate.block_meta?.quoteVolume ?? candidate.trigger_meta?.quoteVolume,
    NaN,
  );
  if (Number.isFinite(quoteVolume) && quoteVolume > 0) {
    return { score: clamp(Math.log10(quoteVolume + 1) / 9, 0, 1, 0.5), raw: round(quoteVolume, 2), source: 'quote_volume', available: true };
  }
  const volumes = bars.map((bar) => finiteNumber(bar.volume, 0)).filter((value) => value > 0);
  if (volumes.length >= 3) {
    const recent = volumes.slice(-3).reduce((sum, value) => sum + value, 0) / Math.min(3, volumes.length);
    const base = volumes.reduce((sum, value) => sum + value, 0) / volumes.length;
    const ratio = base > 0 ? recent / base : 1;
    return { score: clamp(0.45 + ratio / 4, 0, 1, 0.5), raw: round(ratio, 4), source: 'volume_ratio', available: true };
  }
  return { score: 0.5, raw: null, source: 'missing_factor', available: false };
}

function scoreDrawdown(_candidate, bars) {
  if (bars.length >= 5) {
    let peak = bars[0].close;
    let maxDrawdown = 0;
    for (const bar of bars) {
      peak = Math.max(peak, finiteNumber(bar.high ?? bar.close, peak));
      const close = finiteNumber(bar.close, peak);
      if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - close) / peak);
    }
    return { score: clamp(1 - (maxDrawdown / 0.25), 0, 1, 0.5), raw: round(maxDrawdown, 6), source: 'ohlcv_max_drawdown', available: true };
  }
  return { score: 0.5, raw: null, source: 'missing_factor', available: false };
}

function scoreRelativeStrength(candidate, bars, marketContext = {}) {
  const marketReturn = finiteNumber(marketContext.marketReturn ?? marketContext.benchmarkReturn, NaN);
  if (bars.length >= 5 && Number.isFinite(marketReturn)) {
    const ret = (bars[bars.length - 1].close - bars[0].close) / bars[0].close;
    const spread = ret - marketReturn;
    return { score: clamp(0.5 + spread * 4, 0, 1, 0.5), raw: round(spread, 6), source: 'benchmark_spread', available: true };
  }
  const regimeConfidence = finiteNumber(candidate.regimeConfidence ?? candidate.block_meta?.regimeConfidence ?? marketContext.regimeConfidence, NaN);
  if (Number.isFinite(regimeConfidence)) {
    return { score: clamp(regimeConfidence, 0, 1, 0.5), raw: round(regimeConfidence, 4), source: 'regime_confidence', available: true };
  }
  return { score: 0.5, raw: null, source: 'missing_factor', available: false };
}

function scoreValue(candidate) {
  const fundamentals = candidate.fundamentals || candidate.block_meta?.fundamentals || candidate.trigger_meta?.fundamentals || {};
  const pe = finiteNumber(fundamentals.pe ?? fundamentals.per ?? fundamentals.trailingPE, NaN);
  const pb = finiteNumber(fundamentals.pb ?? fundamentals.pbr ?? fundamentals.priceToBook, NaN);
  if (Number.isFinite(pe) || Number.isFinite(pb)) {
    const peScore = Number.isFinite(pe) && pe > 0 ? clamp(1 - pe / 60, 0, 1, 0.5) : 0.5;
    const pbScore = Number.isFinite(pb) && pb > 0 ? clamp(1 - pb / 12, 0, 1, 0.5) : 0.5;
    return { score: round((peScore + pbScore) / 2, 4), raw: { pe: Number.isFinite(pe) ? pe : null, pb: Number.isFinite(pb) ? pb : null }, source: 'fundamentals_value', available: true };
  }
  return { score: 0.5, raw: null, source: 'missing_factor', available: false };
}

function scoreQuality(candidate) {
  const fundamentals = candidate.fundamentals || candidate.block_meta?.fundamentals || candidate.trigger_meta?.fundamentals || {};
  const roe = finiteNumber(fundamentals.roe ?? fundamentals.returnOnEquity, NaN);
  const margin = finiteNumber(fundamentals.margin ?? fundamentals.operatingMargin ?? fundamentals.netMargin, NaN);
  const debtToEquity = finiteNumber(fundamentals.debtToEquity ?? fundamentals.debt_to_equity, NaN);
  if ([roe, margin, debtToEquity].some(Number.isFinite)) {
    const roeScore = Number.isFinite(roe) ? clamp(0.5 + roe, 0, 1, 0.5) : 0.5;
    const marginScore = Number.isFinite(margin) ? clamp(0.5 + margin, 0, 1, 0.5) : 0.5;
    const debtScore = Number.isFinite(debtToEquity) ? clamp(1 - debtToEquity / 3, 0, 1, 0.5) : 0.5;
    return { score: round((roeScore + marginScore + debtScore) / 3, 4), raw: { roe: Number.isFinite(roe) ? roe : null, margin: Number.isFinite(margin) ? margin : null, debtToEquity: Number.isFinite(debtToEquity) ? debtToEquity : null }, source: 'fundamentals_quality', available: true };
  }
  return { score: 0.5, raw: null, source: 'missing_factor', available: false };
}

function weightsForMarket(market) {
  if (market === 'crypto') {
    return {
      momentum: 0.3,
      liquidity: 0.25,
      volatility: 0.2,
      drawdown: 0.15,
      relativeStrength: 0.1,
    };
  }
  return {
    momentum: 0.25,
    liquidity: 0.2,
    volatility: 0.15,
    drawdown: 0.15,
    value: 0.125,
    quality: 0.125,
  };
}

function allocationHint(compositeScore, market) {
  const score = finiteNumber(compositeScore, 0);
  const maxPct = market === 'crypto' ? 0.12 : 0.1;
  if (score >= 0.78) return { suggestedPositionSizePct: maxPct, tier: 'strong_shadow_candidate' };
  if (score >= 0.66) return { suggestedPositionSizePct: round(maxPct * 0.65, 4), tier: 'medium_shadow_candidate' };
  if (score >= 0.55) return { suggestedPositionSizePct: round(maxPct * 0.35, 4), tier: 'watchlist_only' };
  return { suggestedPositionSizePct: 0, tier: 'insufficient_factor_score' };
}

export function buildFactorModelShadow(candidate = {}, context = {}) {
  const exchange = normalizeExchange(candidate.exchange || context.exchange);
  const market = candidate.market || context.market || marketForFactorExchange(exchange);
  const bars = normalizeBars(candidate);
  const factorScores = {
    momentum: scoreMomentum(candidate, bars),
    volatility: scoreVolatility(candidate, bars),
    liquidity: scoreLiquidity(candidate, bars),
    drawdown: scoreDrawdown(candidate, bars),
    relativeStrength: scoreRelativeStrength(candidate, bars, context.marketContext || {}),
  };
  if (market !== 'crypto') {
    factorScores.value = scoreValue(candidate);
    factorScores.quality = scoreQuality(candidate);
  }
  const weights = weightsForMarket(market);
  const weighted = Object.entries(weights).map(([name, weight]) => ({
    name,
    weight,
    score: finiteNumber(factorScores[name]?.score, 0.5),
    available: factorScores[name]?.available === true,
  }));
  const compositeScore = round(weighted.reduce((sum, item) => sum + item.score * item.weight, 0), 4);
  const availableCount = weighted.filter((item) => item.available).length;
  const missingFactors = weighted.filter((item) => !item.available).map((item) => item.name);
  const dataHealth = availableCount >= Math.max(3, Math.ceil(weighted.length * 0.6))
    ? 'ready'
    : availableCount >= 2
      ? 'partial'
      : 'insufficient';
  return {
    ok: Boolean(candidate.symbol),
    symbol: candidate.symbol || null,
    exchange,
    market,
    factorScores,
    weights,
    compositeScore,
    rank: null,
    allocationHint: allocationHint(compositeScore, market),
    dataHealth,
    missingFactors,
    shadowOnly: true,
    evidence: {
      source: context.source || 'candidate',
      bars: bars.length,
      triggerId: candidate.id || candidate.triggerId || candidate.trigger_id || null,
    },
  };
}

export function rankFactorModelShadows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.market || 'unknown'}:${row.exchange || 'unknown'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const groupRows of groups.values()) {
    groupRows
      .sort((a, b) => finiteNumber(b.compositeScore, 0) - finiteNumber(a.compositeScore, 0))
      .forEach((row, index) => {
        row.rank = index + 1;
      });
  }
  return rows;
}

export function normalizeFactorShadowRow(row = {}) {
  return {
    ok: true,
    symbol: row.symbol,
    exchange: row.exchange,
    market: row.market || marketForFactorExchange(row.exchange),
    factorScores: parseJsonMaybe(row.factor_scores, row.factor_scores || {}),
    compositeScore: finiteNumber(row.composite_score, 0),
    rank: row.rank == null ? null : Number(row.rank),
    allocationHint: parseJsonMaybe(row.allocation_hint, row.allocation_hint || {}),
    dataHealth: row.data_health || 'unknown',
    shadowOnly: row.shadow_only !== false,
    evidence: {
      source: 'investment.luna_factor_model_shadow',
      observedAt: row.observed_at || null,
    },
  };
}

export default {
  buildFactorModelShadow,
  marketForFactorExchange,
  normalizeFactorShadowRow,
  rankFactorModelShadows,
};
