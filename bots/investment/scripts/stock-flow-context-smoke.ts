#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { deriveFlowDecision } from '../team/stock-flow.ts';

export async function runStockFlowContextSmoke() {
  const baseline = deriveFlowDecision({
    exchange: 'kis_overseas',
    quote: { price: 100, changePct: 0.1 },
    taRow: { signal: 'HOLD', confidence: 0.1 },
    overseasEvent: {
      recommendationMean: 0,
      recentUpgrades: 0,
      recentDowngrades: 0,
      secFilings: { recent30Count: 0 },
    },
  });
  assert.equal(baseline.signal, 'HOLD');
  assert.doesNotMatch(baseline.reasoning, /애널리스트 우호 0\.00/);

  const contextual = deriveFlowDecision({
    exchange: 'kis_overseas',
    quote: { price: 100, changePct: 2.6 },
    taRow: { signal: 'HOLD', confidence: 0.1 },
    activeCandidateContext: {
      rank: 2,
      score: 0.84,
      confidence: 0.81,
      source: 'pre_market_screen',
      reasonCode: 'pre_market_screen',
    },
    dailyTechnicalContext: {
      ok: true,
      reason: 'kis_daily_chart_bullish',
      source: 'kis_overseas_daily_price',
      bars: 90,
    },
    overseasEvent: {
      recommendationMean: null,
      recentUpgrades: 0,
      recentDowngrades: 0,
      secFilings: { recent30Count: 0 },
    },
  });
  assert.equal(contextual.signal, 'BUY');
  assert.ok(contextual.confidence >= 0.35);
  assert.match(contextual.reasoning, /활성후보 2위 pre_market_screen/);
  assert.match(contextual.reasoning, /KIS 일봉 kis_daily_chart_bullish/);

  return { ok: true, baseline, contextual };
}

async function main() {
  const result = await runStockFlowContextSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('stock-flow-context-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ stock-flow-context-smoke 실패:' });
}
