// @ts-nocheck
// Compact WorldQuant 101 Phase A subset. Top-20 formulaic alphas are kept
// deterministic for smoke/backtest use and shadow-only promotion evidence.

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  return Number(finite(value, 0).toFixed(digits));
}

function normalizeBars(input = {}) {
  const raw = Array.isArray(input) ? input : input.bars || input.ohlcv || input.candles || [];
  return raw.map((bar) => Array.isArray(bar)
    ? { open: finite(bar[1]), high: finite(bar[2]), low: finite(bar[3]), close: finite(bar[4]), volume: finite(bar[5]) }
    : {
        open: finite(bar.open ?? bar.o ?? bar.close ?? bar.price),
        high: finite(bar.high ?? bar.h ?? bar.close ?? bar.price),
        low: finite(bar.low ?? bar.l ?? bar.close ?? bar.price),
        close: finite(bar.close ?? bar.c ?? bar.price),
        volume: finite(bar.volume ?? bar.v),
      }).filter((bar) => bar.close > 0);
}

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
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
  const denom = stdev(x) * stdev(y);
  if (!denom) return 0;
  return mean(x.map((value, index) => (value - mx) * (y[index] - my))) / denom;
}

function tsRank(values = []) {
  if (!values.length) return 0.5;
  const last = values.at(-1);
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted.findIndex((value) => value >= last) + 1) / sorted.length;
}

function returns(bars = []) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) out.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  return out.filter(Number.isFinite);
}

export function calculateWorldQuantAlphas(input = {}) {
  const b = normalizeBars(input);
  if (b.length < 10) return { ok: false, status: 'insufficient_bars', alphas: {}, composite: 0, alphaCount: 0, shadowOnly: true };
  const closes = b.map((bar) => bar.close);
  const opens = b.map((bar) => bar.open);
  const highs = b.map((bar) => bar.high);
  const lows = b.map((bar) => bar.low);
  const volumes = b.map((bar) => bar.volume);
  const rets = returns(b);
  const last = b.at(-1);
  const ret5 = closes.length >= 6 ? (last.close - closes.at(-6)) / closes.at(-6) : 0;
  const ret20 = closes.length >= 21 ? (last.close - closes.at(-21)) / closes.at(-21) : ret5;
  const avgVol20 = mean(volumes.slice(-20));
  const range = last.high - last.low;

  const alphas = {
    alpha001_rank_reversal: round(1 - tsRank(rets.slice(-20))),
    alpha002_neg_vol_price_corr: round(-corr(volumes.slice(-20), closes.slice(-20))),
    alpha003_intraday_reversion: round(last.open ? -(last.close - last.open) / last.open : 0),
    alpha004_close_to_low: round(last.close ? (last.close - last.low) / last.close : 0),
    alpha005_high_to_close: round(last.close ? (last.high - last.close) / last.close : 0),
    alpha006_volume_surge: round(avgVol20 ? last.volume / avgVol20 : 1),
    alpha007_momentum_5: round(ret5),
    alpha008_momentum_20: round(ret20),
    alpha009_low_vol_quality: round(-stdev(rets.slice(-20))),
    alpha010_close_rank_10: round(tsRank(closes.slice(-10))),
    alpha011_volume_rank_10: round(tsRank(volumes.slice(-10))),
    alpha012_range_pct: round(last.close ? range / last.close : 0),
    alpha013_gap_reversal: round(opens.length > 1 ? -(last.open - closes.at(-2)) / closes.at(-2) : 0),
    alpha014_return_volume_corr: round(corr(rets.slice(-20), volumes.slice(-20))),
    alpha015_downside_bounce: round(rets.at(-1) < -0.02 ? -rets.at(-1) : 0),
    alpha016_breakout_distance: round(last.close / Math.max(...highs.slice(-20)) - 1),
    alpha017_breakdown_distance: round(last.close / Math.min(...lows.slice(-20)) - 1),
    alpha018_liquidity_log: round(Math.log10(Math.max(1, avgVol20))),
    alpha019_body_range_ratio: round(range ? Math.abs(last.close - last.open) / range : 0),
    alpha020_factor_quality_blend: round((finite(input.factors?.quality, 0.5) + finite(input.factors?.hml, 0.5)) / 2),
  };

  const composite = round(
    alphas.alpha001_rank_reversal * 0.08
    + alphas.alpha006_volume_surge * 0.035
    + alphas.alpha007_momentum_5 * 1.7
    + alphas.alpha008_momentum_20 * 0.8
    + alphas.alpha020_factor_quality_blend * 0.22
    - Math.abs(alphas.alpha009_low_vol_quality) * 0.45,
  );
  return {
    ok: true,
    status: 'worldquant_alpha_shadow_ready',
    alphas,
    composite,
    alphaCount: Object.keys(alphas).length,
    signal: composite > 0.18 ? 'long_bias' : composite < -0.05 ? 'avoid_or_short_bias' : 'neutral',
    bars: b.length,
    shadowOnly: true,
  };
}

export default { calculateWorldQuantAlphas };
