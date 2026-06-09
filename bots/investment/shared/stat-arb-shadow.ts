const VALID_EXCHANGES = new Set(['binance', 'kis', 'kis_overseas']);
type AnyRecord = Record<string, any>;
type StatArbExchange = 'binance' | 'kis' | 'kis_overseas';
type PriceBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

export const DEFAULT_STAT_ARB_PAIRS = {
  binance: [
    ['BTC/USDT', 'ETH/USDT'],
    ['ETH/USDT', 'SOL/USDT'],
    ['BTC/USDT', 'SOL/USDT'],
  ],
  kis: [
    ['005930', '000660'],
    ['005380', '000270'],
  ],
  kis_overseas: [
    ['AAPL', 'MSFT'],
    ['NVDA', 'AMD'],
    ['SPY', 'QQQ'],
  ],
};

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value: unknown, min = 0, max = 1, fallback = 0): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function round(value: unknown, digits = 4): number {
  return Number(Number(value || 0).toFixed(digits));
}

function parseJsonMaybe(value: unknown, fallback: unknown = {}): unknown {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeStatArbExchange(value: unknown): StatArbExchange {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'crypto') return 'binance';
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  return VALID_EXCHANGES.has(raw) ? raw as StatArbExchange : 'binance';
}

export function marketForStatArbExchange(exchange: unknown): string {
  const normalized = normalizeStatArbExchange(exchange);
  if (normalized === 'kis') return 'domestic';
  if (normalized === 'kis_overseas') return 'overseas';
  return 'crypto';
}

export function defaultStatArbPairs(exchange: unknown): string[][] {
  const normalized = normalizeStatArbExchange(exchange);
  return (DEFAULT_STAT_ARB_PAIRS[normalized] || DEFAULT_STAT_ARB_PAIRS.binance)
    .map((pair) => [...pair]);
}

function normalizeBars(value: unknown = []): PriceBar[] {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((bar: any) => {
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
  }).filter((bar) => Number.isFinite(bar.close) && bar.close > 0).slice(-180);
}

function closesFromBars(bars: unknown = []): number[] {
  return normalizeBars(bars).map((bar) => bar.close);
}

function mean(values: number[] = []): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdev(values: number[] = []): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, values.length - 1);
  return Math.sqrt(variance);
}

function covariance(a: number[] = [], b: number[] = []): number {
  const len = Math.min(a.length, b.length);
  if (len < 2) return 0;
  const aa = a.slice(-len);
  const bb = b.slice(-len);
  const ma = mean(aa);
  const mb = mean(bb);
  return aa.reduce((sum, value, index) => sum + (value - ma) * (bb[index] - mb), 0) / Math.max(1, len - 1);
}

function correlation(a: number[] = [], b: number[] = []): number {
  const len = Math.min(a.length, b.length);
  if (len < 2) return 0;
  const aa = a.slice(-len);
  const bb = b.slice(-len);
  const denom = stdev(aa) * stdev(bb);
  return denom > 0 ? covariance(aa, bb) / denom : 0;
}

function rsi(closes: number[] = [], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const tail = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < tail.length; i += 1) {
    const delta = tail[i] - tail[i - 1];
    if (delta >= 0) gains += delta;
    else losses += Math.abs(delta);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function pairSignal(zScore: number): string {
  if (zScore >= 2) return 'pair_short_first_long_second';
  if (zScore <= -2) return 'pair_long_first_short_second';
  if (Math.abs(zScore) >= 1.25) return 'pair_watch';
  return 'neutral';
}

function meanReversionSignal(zScore: number, rsiValue: number | null): string {
  if (zScore <= -2 && rsiValue != null && rsiValue <= 35) return 'buy_reversion_watch';
  if (zScore >= 2 && rsiValue != null && rsiValue >= 65) return 'sell_reversion_watch';
  if (Math.abs(zScore) >= 1.5) return 'mean_reversion_watch';
  return 'neutral';
}

function dataHealthForBars(count: number, ready = 20, partial = 5): string {
  if (count >= ready) return 'ready';
  if (count >= partial) return 'partial';
  return 'insufficient';
}

export function buildPairsTradingShadow(input: AnyRecord = {}, context: AnyRecord = {}) {
  const exchange = normalizeStatArbExchange(input.exchange || context.exchange);
  const market = input.market || context.market || marketForStatArbExchange(exchange);
  const symbols = Array.isArray(input.symbols) && input.symbols.length >= 2
    ? input.symbols.slice(0, 2).map(String)
    : ['UNKNOWN_A', 'UNKNOWN_B'];
  const a = closesFromBars(input.barsA || input.seriesA || []);
  const b = closesFromBars(input.barsB || input.seriesB || []);
  const len = Math.min(a.length, b.length);
  const aa = a.slice(-len).map((value) => Math.log(value));
  const bb = b.slice(-len).map((value) => Math.log(value));
  const beta = stdev(bb) > 0 ? covariance(aa, bb) / (stdev(bb) ** 2) : 1;
  const spread = aa.map((value, index) => value - beta * bb[index]);
  const spreadMean = mean(spread);
  const spreadStd = stdev(spread);
  const zScore = spreadStd > 0 ? (spread[spread.length - 1] - spreadMean) / spreadStd : 0;
  const corr = correlation(aa, bb);
  const dataHealth = dataHealthForBars(len);
  const signal = dataHealth === 'ready' ? pairSignal(zScore) : 'missing_data';
  return {
    ok: symbols.every(Boolean),
    strategyType: 'pairs_trading',
    symbols,
    exchange,
    market,
    pairMetrics: {
      samples: len,
      hedgeRatio: round(beta, 6),
      correlation: round(corr, 4),
      spreadMean: round(spreadMean, 6),
      spreadStd: round(spreadStd, 6),
    },
    meanReversionMetrics: {},
    signal,
    zScore: round(zScore, 4),
    confidence: dataHealth === 'ready' ? clamp((Math.abs(zScore) / 3) * 0.65 + Math.abs(corr) * 0.35, 0, 1, 0.1) : 0,
    dataHealth,
    shadowOnly: true,
    evidence: {
      source: context.source || 'stat_arb_shadow',
      missingData: dataHealth === 'insufficient',
      barsA: a.length,
      barsB: b.length,
    },
  };
}

export function buildMeanReversionShadow(input: AnyRecord = {}, context: AnyRecord = {}) {
  const exchange = normalizeStatArbExchange(input.exchange || context.exchange);
  const market = input.market || context.market || marketForStatArbExchange(exchange);
  const symbol = String(input.symbol || input.symbols?.[0] || '').trim();
  const closes = closesFromBars(input.bars || input.series || []);
  const window = closes.slice(-20);
  const sma = mean(window);
  const sigma = stdev(window);
  const latest = closes[closes.length - 1] || 0;
  const zScore = sigma > 0 ? (latest - sma) / sigma : 0;
  const rsiValue = rsi(closes);
  const dataHealth = dataHealthForBars(closes.length);
  const signal = dataHealth === 'ready' ? meanReversionSignal(zScore, rsiValue) : 'missing_data';
  return {
    ok: Boolean(symbol),
    strategyType: 'mean_reversion',
    symbols: symbol ? [symbol] : [],
    exchange,
    market,
    pairMetrics: {},
    meanReversionMetrics: {
      samples: closes.length,
      lookback: Math.min(20, closes.length),
      latest: round(latest, 8),
      sma20: round(sma, 8),
      stdev20: round(sigma, 8),
      rsi14: rsiValue == null ? null : round(rsiValue, 4),
      upperBand: round(sma + 2 * sigma, 8),
      lowerBand: round(sma - 2 * sigma, 8),
    },
    signal,
    zScore: round(zScore, 4),
    confidence: dataHealth === 'ready' ? clamp(Math.abs(zScore) / 3, 0, 1, 0.1) : 0,
    dataHealth,
    shadowOnly: true,
    evidence: {
      source: context.source || 'stat_arb_shadow',
      missingData: dataHealth === 'insufficient',
      bars: closes.length,
    },
  };
}

export function normalizeStatArbShadowRow(row: AnyRecord = {}) {
  const symbols = parseJsonMaybe(row.symbols, row.symbols || []);
  return {
    ok: true,
    strategyType: row.strategy_type || row.strategyType || 'unknown',
    symbols: Array.isArray(symbols) ? symbols : [],
    exchange: row.exchange,
    market: row.market || marketForStatArbExchange(row.exchange),
    pairMetrics: parseJsonMaybe(row.pair_metrics, row.pairMetrics || {}),
    meanReversionMetrics: parseJsonMaybe(row.mean_reversion_metrics, row.meanReversionMetrics || {}),
    signal: row.signal || 'unknown',
    zScore: finiteNumber(row.z_score ?? row.zScore, 0),
    confidence: finiteNumber(row.confidence, 0),
    dataHealth: row.data_health || row.dataHealth || 'unknown',
    shadowOnly: row.shadow_only !== false,
    evidence: {
      ...parseJsonMaybe(row.context_evidence, row.evidence || {}) as AnyRecord,
      observedAt: row.observed_at || row.observedAt || null,
    },
  };
}

export default {
  buildMeanReversionShadow,
  buildPairsTradingShadow,
  defaultStatArbPairs,
  marketForStatArbExchange,
  normalizeStatArbExchange,
  normalizeStatArbShadowRow,
};
