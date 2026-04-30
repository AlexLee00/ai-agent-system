#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { scoreTechnicalSetup } from '../shared/ta-integrated-scorer.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const closes = [101, 100, 99, 98, 97, 98, 99, 100, 101, 102];
  const result = scoreTechnicalSetup({
    closes,
    highs: closes.map((v) => v + 1),
    lows: closes.map((v) => v - 1),
    volumes: Array.from({ length: 25 }, (_, index) => 1000 + index * 10),
    regime: 'TRENDING_BULL',
    indicators: {
      rsi: 35,
      macd: { histogram: 0.2, macd: 1.2, signal: 1 },
      bb: { lower: 97, upper: 105 },
      mas: { ma5: 101, ma20: 100, ma60: 99 },
    },
    currentPrice: 102,
    crossSignals: [{ type: 'golden_cross', fastPeriod: 5 }],
    divergence: { overall: 'bullish', bullishScore: 0.6 },
    patterns: { bullishScore: 0.4, bearishScore: 0 },
    supportResistance: { atSupport: true },
  });
  assert.equal(result.ok, true);
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(Array.isArray(result.reasonCodes));
  return { ok: true, result };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ ta-integrated-scorer-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ ta-integrated-scorer-smoke 실패:' });
}
