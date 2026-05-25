// @ts-nocheck
// Lightweight GARCH(1,1)-style volatility shadow model.

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function round(value, digits = 6) {
  return Number(finite(value, 0).toFixed(digits));
}

function normalizeBars(input = {}) {
  const raw = Array.isArray(input) ? input : input.bars || input.ohlcv || input.candles || [];
  return raw.map((bar) => Array.isArray(bar)
    ? { close: finite(bar[4]) }
    : { close: finite(bar.close ?? bar.c ?? bar.price) }).filter((bar) => bar.close > 0);
}

function returnsFromBars(bars = []) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    out.push(Math.log(bars[i].close / bars[i - 1].close));
  }
  return out.filter(Number.isFinite);
}

function variance(values = []) {
  if (values.length < 2) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
}

function zVar(volatility, z) {
  return round(Math.abs(volatility * z), 6);
}

export function forecastGarchVolatility(input = {}, options = {}) {
  const bars = normalizeBars(input);
  const returns = Array.isArray(input.returns) ? input.returns.map(Number).filter(Number.isFinite) : returnsFromBars(bars);
  if (returns.length < 8) {
    return {
      ok: false,
      status: 'insufficient_returns',
      volatilityForecast: { h1: 0, h4: 0, h24: 0 },
      var95: 0,
      var99: 0,
      positionSizeFactor: 0.5,
      shadowOnly: true,
    };
  }

  const alpha = finite(options.alpha, 0.08);
  const beta = finite(options.beta, 0.88);
  const omega = Math.max(0.00000001, variance(returns.slice(-60)) * Math.max(0.01, 1 - alpha - beta));
  let sigma2 = variance(returns.slice(0, Math.min(20, returns.length))) || variance(returns);
  for (const ret of returns.slice(-120)) {
    sigma2 = omega + alpha * (ret ** 2) + beta * sigma2;
  }

  const h1 = Math.sqrt(Math.max(0, sigma2));
  const h4 = h1 * Math.sqrt(4);
  const h24 = h1 * Math.sqrt(24);
  const realized21 = Math.sqrt(variance(returns.slice(-21)));
  const volRatio = h24 / Math.max(0.0001, realized21 * Math.sqrt(24));
  const positionSizeFactor = clamp(1 / Math.max(1, volRatio), 0.25, 1);

  return {
    ok: true,
    status: 'garch_volatility_shadow_ready',
    volatilityForecast: {
      h1: round(h1),
      h4: round(h4),
      h24: round(h24),
    },
    var95: zVar(h24, 1.65),
    var99: zVar(h24, 2.33),
    positionSizeFactor: round(positionSizeFactor, 4),
    features: {
      returns: returns.length,
      realized21: round(realized21),
      volRatio: round(volRatio, 4),
      alpha,
      beta,
      omega: round(omega, 10),
    },
    shadowOnly: true,
  };
}

export default { forecastGarchVolatility };
