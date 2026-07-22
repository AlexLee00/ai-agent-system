#!/usr/bin/env node
// @ts-nocheck
/**
 * Kairos — shadow-only time-series prediction agent.
 *
 * Kairos never changes live orders directly. It produces prediction evidence
 * for Chronos/Luna and remains shadow unless the explicit kill switch is on.
 */
import { predictPrice, predictPriceBatch } from '../shared/ml-price-predictor.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function isKairosActive() {
  return boolEnv('LUNA_KAIROS_ACTIVE_ENABLED', boolEnv('LUNA_KAIROS_ENABLED', false));
}

export function isKairosShadowMode() {
  return boolEnv('LUNA_KAIROS_SHADOW_MODE', true) || !isKairosActive();
}

export function getKairosConfidenceMin() {
  return Math.max(0, Math.min(1, Number(process.env.LUNA_KAIROS_CONFIDENCE_MIN || 0.7) || 0.7));
}

const TIMEFRAME_MS = Object.freeze({
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
});

export function resolveKairosLookbackFrom(timeframe = '1d', limit = 120, now = new Date()) {
  const tf = String(timeframe || '1d').trim().toLowerCase();
  const stepMs = TIMEFRAME_MS[tf] || TIMEFRAME_MS['1d'];
  const cappedLimit = Math.max(30, Math.min(2000, Math.round(Number(limit || 120) || 120)));
  return new Date(new Date(now).getTime() - stepMs * cappedLimit).toISOString();
}

export async function forecastSymbol(symbol = 'BTC/USDT', opts = {}) {
  const horizon = Number(opts.horizon || 5);
  const timeframe = String(opts.timeframe || '1d');
  const limit = Math.max(30, Math.min(2000, Math.round(Number(opts.limit || 120) || 120)));
  const from = opts.from || opts.since || resolveKairosLookbackFrom(timeframe, limit, opts.now || new Date());
  const to = opts.to || null;
  const exchange = opts.exchange || 'binance';
  const ohlcvFetcher = opts.ohlcvFetcher || getOHLCV;
  const fetchedRows = opts.closes
    ? []
    : await ohlcvFetcher(symbol, timeframe, from, to, exchange).catch(() => []);
  const candles = opts.closes
    ? opts.closes.map(Number).filter(Number.isFinite)
    : fetchedRows.map((row) => Array.isArray(row) ? Number(row[4]) : Number(row.close)).filter(Number.isFinite);
  const prediction = predictPrice(candles, horizon);
  const timeframeMs = TIMEFRAME_MS[timeframe.toLowerCase()] || null;
  const nowMs = new Date(opts.now || Date.now()).getTime();
  const closedRows = timeframeMs == null ? [] : fetchedRows.filter((row) => {
    const candleTs = Number(Array.isArray(row) ? row[0] : row.candle_ts ?? row.timestamp);
    return Number.isFinite(candleTs) && candleTs + timeframeMs <= nowMs;
  });
  const closedCloses = opts.closes
    ? candles
    : closedRows.map((row) => Array.isArray(row) ? Number(row[4]) : Number(row.close)).filter(Number.isFinite);
  const persistencePrediction = predictPrice(closedCloses, horizon, { log: false });
  const originCandleTs = opts.originCandleTs
    ? new Date(opts.originCandleTs).toISOString()
    : closedRows.length
      ? new Date(Number(Array.isArray(closedRows.at(-1)) ? closedRows.at(-1)[0] : closedRows.at(-1).candle_ts)).toISOString()
      : null;
  return {
    ok: true,
    agent: 'kairos',
    symbol,
    exchange,
    active: isKairosActive(),
    shadowMode: isKairosShadowMode() || prediction.shadowMode !== false,
    horizon,
    prediction,
    persistencePrediction,
    originCandleTs,
    originCandleClosed: Boolean(originCandleTs),
    dataHealth: candles.length >= 30 ? 'ok' : 'insufficient_ohlcv',
    source: opts.closes ? 'provided_closes' : 'ohlcv_fetcher',
    timeframe,
    observedCandles: candles.length,
    confidenceMin: getKairosConfidenceMin(),
    recommendation: prediction.usable && isKairosActive() && !isKairosShadowMode() && Number(prediction.confidence || 0) >= getKairosConfidenceMin()
      ? prediction.direction
      : 'shadow_only',
  };
}

export async function forecastBatch(symbolClosesMap = {}, opts = {}) {
  const predictions = await predictPriceBatch(symbolClosesMap, opts.horizon || 5);
  return {
    ok: true,
    agent: 'kairos',
    active: isKairosActive(),
    shadowMode: isKairosShadowMode(),
    predictions,
  };
}

async function main() {
  const symbol = process.argv.find((arg) => arg.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';
  const json = process.argv.includes('--json');
  const result = await forecastSymbol(symbol);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[kairos] ${symbol} ${result.recommendation} confidence=${result.prediction.confidence}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ kairos 실패:' });
}

export default { forecastSymbol, forecastBatch, isKairosActive, isKairosShadowMode, getKairosConfidenceMin };
