import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { RSI, MACD, BollingerBands, ATR, EMA, SMA } = require('technicalindicators');

export function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  const values = RSI.calculate({ period, values: closes });
  return values.length > 0 ? values[values.length - 1] : null;
}

export function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length < slowPeriod + signalPeriod) return null;
  const values = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const latest = values[values.length - 1];
  if (!latest) return null;
  return {
    macd: latest.MACD,
    signal: latest.signal,
    histogram: latest.histogram,
  };
}

export function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const values = BollingerBands.calculate({ period, stdDev, values: closes });
  const latest = values[values.length - 1];
  if (!latest) return null;
  return {
    upper: latest.upper,
    middle: latest.middle,
    lower: latest.lower,
    bandwidth: latest.middle ? (latest.upper - latest.lower) / latest.middle : 0,
  };
}

export function calcATR(highs, lows, closes, period = 14) {
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)) return null;
  if (closes.length < period + 1 || highs.length !== lows.length || highs.length !== closes.length) return null;
  const values = ATR.calculate({ high: highs, low: lows, close: closes, period });
  return values.length > 0 ? values[values.length - 1] : null;
}

export function calcEMA(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const values = EMA.calculate({ period, values: closes });
  return values.length > 0 ? values[values.length - 1] : null;
}

export function calcSMA(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const values = SMA.calculate({ period, values: closes });
  return values.length > 0 ? values[values.length - 1] : null;
}
