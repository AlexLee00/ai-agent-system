#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { predictPrice, predictPriceBatch, predictionToVote } from '../shared/ml-price-predictor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const oldEnabled = process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED;
  const oldShadow = process.env.LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE;
  try {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const disabled = predictPrice(closes, 5);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.usable, false);

    process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED = 'true';
    process.env.LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE = 'true';
    const shadow = predictPrice(closes, 5);
    assert.equal(shadow.enabled, true);
    assert.equal(shadow.shadowMode, true);
    assert.equal(shadow.usable, false);
    assert.ok(['up', 'down', 'neutral'].includes(shadow.direction));

    const batch = await predictPriceBatch({ BTC: closes, ETH: closes.map((v) => v * 2) });
    assert.equal(Object.keys(batch).length, 2);
    const vote = predictionToVote(shadow);
    assert.equal(vote.name, 'ml_prediction');
    return { ok: true, disabled, shadow, vote };
  } finally {
    if (oldEnabled == null) delete process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED;
    else process.env.LUNA_ML_PRICE_PREDICTOR_ENABLED = oldEnabled;
    if (oldShadow == null) delete process.env.LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE;
    else process.env.LUNA_ML_PRICE_PREDICTOR_SHADOW_MODE = oldShadow;
  }
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ ml-price-predictor-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ ml-price-predictor-smoke 실패:' });
}
