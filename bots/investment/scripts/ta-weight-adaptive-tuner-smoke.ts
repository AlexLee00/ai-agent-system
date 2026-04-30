#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import {
  getIndicatorPerformanceSummary,
  resetAdaptedWeights,
  retrieveAdaptedWeights,
  tuneIndicatorWeights,
} from '../shared/ta-weight-adaptive-tuner.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  resetAdaptedWeights();
  const before = retrieveAdaptedWeights('TRENDING_BULL');
  const after = tuneIndicatorWeights({
    symbol: 'BTC/USDT',
    pnl: 10,
    pnlPct: 0.08,
    regime: 'TRENDING_BULL',
    usedIndicators: ['macd', 'golden_cross'],
  });
  assert.ok(after.macd >= before.macd);
  assert.ok(after.golden_cross >= before.golden_cross);

  tuneIndicatorWeights({
    symbol: 'ETH/USDT',
    pnl: -5,
    pnlPct: -0.03,
    regime: 'TRENDING_BULL',
    usedIndicators: ['macd'],
  });
  const summary = getIndicatorPerformanceSummary('TRENDING_BULL');
  assert.equal(summary.totalTrades, 2);
  assert.equal(summary.indicators.macd.total, 2);
  return { ok: true, before, after, summary };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ ta-weight-adaptive-tuner-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ ta-weight-adaptive-tuner-smoke 실패:' });
}
