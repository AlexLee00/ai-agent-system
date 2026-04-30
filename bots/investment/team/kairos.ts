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

export async function forecastSymbol(symbol = 'BTC/USDT', opts = {}) {
  const horizon = Number(opts.horizon || 5);
  const candles = opts.closes
    ? opts.closes
    : (await getOHLCV(symbol, opts.timeframe || '1d', opts.limit || 120).catch(() => []))
      .map((row) => Array.isArray(row) ? Number(row[4]) : Number(row.close))
      .filter(Number.isFinite);
  const prediction = predictPrice(candles, horizon);
  return {
    ok: true,
    agent: 'kairos',
    symbol,
    active: isKairosActive(),
    shadowMode: isKairosShadowMode() || prediction.shadowMode !== false,
    horizon,
    prediction,
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
