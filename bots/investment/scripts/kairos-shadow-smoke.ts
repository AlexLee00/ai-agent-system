#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { forecastSymbol, forecastBatch, isKairosActive, isKairosShadowMode } from '../team/kairos.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function syntheticCloses() {
  return Array.from({ length: 90 }, (_, index) => 100 + index * 0.2 + Math.sin(index / 4));
}

export async function runSmoke() {
  const prevActive = process.env.LUNA_KAIROS_ACTIVE_ENABLED;
  const prevEnabled = process.env.LUNA_KAIROS_ENABLED;
  const prevShadow = process.env.LUNA_KAIROS_SHADOW_MODE;
  const prevMl = process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED;
  process.env.LUNA_KAIROS_ACTIVE_ENABLED = 'false';
  process.env.LUNA_KAIROS_ENABLED = 'false';
  process.env.LUNA_KAIROS_SHADOW_MODE = 'true';
  process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED = 'true';
  try {
    const forecast = await forecastSymbol('BTC/USDT', { closes: syntheticCloses(), horizon: 5 });
    assert.equal(isKairosActive(), false);
    assert.equal(isKairosShadowMode(), true);
    assert.equal(forecast.shadowMode, true);
    assert.equal(forecast.recommendation, 'shadow_only');
    assert.ok(Number.isFinite(forecast.prediction.confidence));
    const batch = await forecastBatch({ 'ETH/USDT': syntheticCloses() }, { horizon: 3 });
    assert.equal(batch.shadowMode, true);
    return { ok: true, forecast, batchSymbols: Object.keys(batch.predictions) };
  } finally {
    if (prevActive === undefined) delete process.env.LUNA_KAIROS_ACTIVE_ENABLED;
    else process.env.LUNA_KAIROS_ACTIVE_ENABLED = prevActive;
    if (prevEnabled === undefined) delete process.env.LUNA_KAIROS_ENABLED;
    else process.env.LUNA_KAIROS_ENABLED = prevEnabled;
    if (prevShadow === undefined) delete process.env.LUNA_KAIROS_SHADOW_MODE;
    else process.env.LUNA_KAIROS_SHADOW_MODE = prevShadow;
    if (prevMl === undefined) delete process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED;
    else process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED = prevMl;
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ kairos-shadow-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ kairos-shadow-smoke 실패:' });
}
