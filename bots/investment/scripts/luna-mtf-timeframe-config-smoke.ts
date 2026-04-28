#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ANALYST_TYPES, ACTIONS } from '../shared/signal.ts';
import { analyzeMultiTimeframe } from '../shared/multi-timeframe-analyzer.ts';

export async function runLunaMtfTimeframeConfigSmoke() {
  const analyses = [{
    analyst: ANALYST_TYPES.TA_MTF,
    metadata: {
      timeframes: {
        '1m': { signal: ACTIONS.SELL, confidence: 0.99 },
        '1h': { signal: ACTIONS.BUY, confidence: 0.8 },
        '1d': { signal: ACTIONS.BUY, confidence: 0.7 },
      },
    },
  }];

  const longFrames = analyzeMultiTimeframe('BTC/USDT', analyses, 'binance', {
    timeframes: ['1h', '1d'],
  });
  assert.equal(longFrames.dominantSignal, ACTIONS.BUY);
  assert.deepEqual(longFrames.configuredTimeframes, ['1h', '1d']);
  assert.equal(longFrames.byTimeframe['1m'], undefined);

  const scalpOnly = analyzeMultiTimeframe('BTC/USDT', analyses, 'binance', {
    timeframes: ['1m'],
  });
  assert.equal(scalpOnly.dominantSignal, ACTIONS.SELL);
  assert.deepEqual(scalpOnly.configuredTimeframes, ['1m']);

  return {
    ok: true,
    longFrames,
    scalpOnly,
  };
}

async function main() {
  const result = await runLunaMtfTimeframeConfigSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna mtf timeframe config smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna mtf timeframe config smoke 실패:',
  });
}
