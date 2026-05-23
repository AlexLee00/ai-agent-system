// @ts-nocheck
// Compact WorldQuant-style alpha subset adapted for Korean OHLCV fixtures.

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  return Number(finite(value, 0).toFixed(digits));
}

function bars(input = {}) {
  const raw = input.bars || input.ohlcv || input.candles || [];
  return raw.map((bar) => Array.isArray(bar)
    ? { open: finite(bar[1]), high: finite(bar[2]), low: finite(bar[3]), close: finite(bar[4]), volume: finite(bar[5]) }
    : {
        open: finite(bar.open ?? bar.o ?? bar.close),
        high: finite(bar.high ?? bar.h ?? bar.close),
        low: finite(bar.low ?? bar.l ?? bar.close),
        close: finite(bar.close ?? bar.c ?? bar.price),
        volume: finite(bar.volume ?? bar.v),
      }).filter((bar) => bar.close > 0);
}

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function returns(items = []) {
  const out = [];
  for (let i = 1; i < items.length; i += 1) {
    if (items[i - 1].close > 0) out.push((items[i].close - items[i - 1].close) / items[i - 1].close);
  }
  return out;
}

function stdev(values = []) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function corr(a = [], b = []) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  const cov = mean(x.map((value, index) => (value - mx) * (y[index] - my)));
  const denom = stdev(x) * stdev(y);
  return denom ? cov / denom : 0;
}

function tsRank(values = []) {
  if (!values.length) return 0.5;
  const last = values[values.length - 1];
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted.findIndex((value) => value >= last) + 1) / sorted.length;
}

export function calculateKoreanWorldQuantAlphas(input = {}) {
  const b = bars(input);
  if (b.length < 5) return { ok: false, status: 'insufficient_bars', alphas: {}, composite: 0, shadowOnly: true };
  const closes = b.map((x) => x.close);
  const opens = b.map((x) => x.open);
  const highs = b.map((x) => x.high);
  const lows = b.map((x) => x.low);
  const volumes = b.map((x) => x.volume);
  const rets = returns(b);
  const last = b[b.length - 1];
  const avgVol20 = mean(volumes.slice(-20));
  const ret5 = closes.length >= 6 ? (last.close - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
  const ret20 = closes.length >= 21 ? (last.close - closes[closes.length - 21]) / closes[closes.length - 21] : ret5;
  const intraday = last.open ? (last.close - last.open) / last.open : 0;

  const alphas = {
    alpha001_reversal_rank: round(1 - tsRank(rets.slice(-20))),
    alpha002_volume_price_corr: round(-corr(volumes.slice(-20), closes.slice(-20))),
    alpha003_open_close_reversion: round(-intraday),
    alpha004_low_distance: round(last.close ? (last.close - last.low) / last.close : 0),
    alpha005_high_distance: round(last.close ? (last.high - last.close) / last.close : 0),
    alpha006_volume_surge: round(avgVol20 ? last.volume / avgVol20 : 1),
    alpha007_momentum_5d: round(ret5),
    alpha008_momentum_20d: round(ret20),
    alpha009_volatility_penalty: round(-stdev(rets.slice(-20))),
    alpha010_close_rank_10d: round(tsRank(closes.slice(-10))),
    alpha011_volume_rank_10d: round(tsRank(volumes.slice(-10))),
    alpha012_high_low_spread: round(last.close ? (last.high - last.low) / last.close : 0),
    alpha013_gap: round(opens.length > 1 && closes.length > 1 ? (last.open - closes[closes.length - 2]) / closes[closes.length - 2] : 0),
    alpha014_return_volume_corr: round(corr(rets.slice(-20), volumes.slice(-20))),
    alpha015_downside_reversal: round(rets[rets.length - 1] < -0.02 ? -rets[rets.length - 1] : 0),
    alpha016_breakout: round(last.close / Math.max(...highs.slice(-20)) - 1),
    alpha017_breakdown_risk: round(last.close / Math.min(...lows.slice(-20)) - 1),
    alpha018_liquidity_quality: round(Math.log10(Math.max(1, avgVol20))),
    alpha019_body_to_range: round((last.high - last.low) ? Math.abs(last.close - last.open) / (last.high - last.low) : 0),
    alpha020_korea_quality_blend: round((finite(input.factors?.quality, 0.5) + finite(input.factors?.hml, 0.5)) / 2),
  };
  const composite = round(
    alphas.alpha001_reversal_rank * 0.08
    + alphas.alpha006_volume_surge * 0.04
    + alphas.alpha007_momentum_5d * 2
    + alphas.alpha008_momentum_20d
    + alphas.alpha020_korea_quality_blend * 0.2
    - Math.abs(alphas.alpha009_volatility_penalty) * 0.5,
    6,
  );
  return { ok: true, status: 'korean_worldquant_alpha_ready', alphas, composite, bars: b.length, shadowOnly: true };
}

export default { calculateKoreanWorldQuantAlphas };
