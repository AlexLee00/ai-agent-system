#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ANALYST_TYPES } from '../shared/signal.ts';
import {
  applyRegimeBiasToAnalystWeights,
  buildLunaAnalystWeights,
  buildRegimeAnalystBias,
} from '../shared/luna-analyst-weight-policy.ts';

function weightSum(weights) {
  return Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0);
}

function assertNormalized(weights, label) {
  const sum = weightSum(weights);
  assert.ok(sum >= 0.98 && sum <= 1.02, `${label} weights normalized (${sum})`);
}

export function runLunaAnalystWeightPolicySmoke() {
  const base = buildLunaAnalystWeights('binance', { paperMode: false });
  const bull = buildLunaAnalystWeights('binance', {
    paperMode: false,
    marketRegime: { regime: 'trending_bull' },
  });
  const bear = buildLunaAnalystWeights('binance', {
    paperMode: false,
    marketRegime: { regime: 'trending_bear' },
  });
  const stockBull = buildLunaAnalystWeights('kis', {
    paperMode: false,
    marketRegime: { regime: 'trending_bull' },
  });
  const bias = buildRegimeAnalystBias({ regime: 'volatile' });
  const custom = applyRegimeBiasToAnalystWeights({
    [ANALYST_TYPES.TA_MTF]: 0.5,
    [ANALYST_TYPES.ONCHAIN]: 0.5,
    [ANALYST_TYPES.MARKET_FLOW]: 0,
  }, { regime: 'volatile' });

  assertNormalized(base, 'base');
  assertNormalized(bull, 'bull');
  assertNormalized(bear, 'bear');
  assertNormalized(stockBull, 'stock');
  assert.ok(Number(bias[ANALYST_TYPES.SENTIMENT] || 0) > 1, 'volatile sentiment bias increases');
  assert.equal(custom[ANALYST_TYPES.MARKET_FLOW], 0, 'zero base market flow remains zero');
  assert.notDeepEqual(bull, bear, 'regime guide changes analyst weights');

  return {
    ok: true,
    base,
    bull,
    bear,
    stockBull,
    volatileBias: bias,
  };
}

async function main() {
  const result = runLunaAnalystWeightPolicySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna analyst weight policy smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna analyst weight policy smoke 실패:',
  });
}
