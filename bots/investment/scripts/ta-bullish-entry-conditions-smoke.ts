#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { evaluateBullishEntry, evaluateBearishExit } from '../shared/ta-bullish-entry-conditions.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const closes = [100, 98, 96, 97, 99, 101];
  const bullish = evaluateBullishEntry({
    closes,
    volumes: Array.from({ length: 25 }, (_, i) => (i === 24 ? 2500 : 1000)),
    indicators: {
      rsi: 32,
      macd: { histogram: 0.4, macd: 1.4, signal: 1.0 },
      bb: { lower: 96, upper: 110 },
      mas: { ma5: 101, ma20: 100, ma60: 98 },
    },
    divergence: { overall: 'bullish', bullishScore: 0.5 },
    crossSignals: [{ type: 'golden_cross', fastPeriod: 5 }],
    patterns: { bullishScore: 0.4 },
    supportResistance: { atSupport: true },
  });
  assert.equal(bullish.entry, true);
  assert.ok(bullish.score >= 0.6);

  const bearish = evaluateBearishExit({
    closes: [100, 105, 110],
    indicators: { rsi: 75, macd: { histogram: -0.2, macd: 0.8, signal: 1.1 }, bb: { lower: 90, upper: 111 } },
    divergence: { overall: 'bearish', bearishScore: 0.4 },
    crossSignals: [{ type: 'death_cross' }],
    patterns: { bearishScore: 0.4 },
    supportResistance: { atResistance: true },
  });
  assert.equal(bearish.exit, true);
  return { ok: true, bullish, bearish };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ ta-bullish-entry-conditions-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ ta-bullish-entry-conditions-smoke 실패:' });
}
