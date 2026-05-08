#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import {
  buildChartExitPolicySnapshot,
  buildDynamicTrailInputFromChart,
} from '../shared/position-reevaluator.ts';
import { computeDynamicTrail } from '../shared/dynamic-trail-engine.ts';

const saved = process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED;
process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED = 'true';

try {
  const holdChart = {
    liveIndicator: {
      compositeSignal: 'HOLD',
      timeframes: [
        { interval: '1h', close: 100, signal: 'NEUTRAL', bbUpper: 106, bbLower: 94 },
        { interval: '4h', close: 99.8, signal: 'BULLISH', bbUpper: 107, bbLower: 93 },
        { interval: '1d', close: 100.2, signal: 'NEUTRAL', bbUpper: 108, bbLower: 92 },
      ],
    },
    liveIndicatorFrames: [
      { interval: '1h', signal: 'NEUTRAL' },
      { interval: '4h', signal: 'BULLISH' },
      { interval: '1d', signal: 'NEUTRAL' },
    ],
  };
  const sellChart = {
    liveIndicator: {
      compositeSignal: 'SELL',
      timeframes: [
        { interval: '1h', close: 95, signal: 'SELL', bbUpper: 104, bbLower: 94 },
        { interval: '4h', close: 95, signal: 'SELL', bbUpper: 104, bbLower: 94 },
        { interval: '1d', close: 96, signal: 'NEUTRAL', bbUpper: 106, bbLower: 94 },
      ],
    },
    liveIndicatorFrames: [
      { interval: '1h', signal: 'SELL' },
      { interval: '4h', signal: 'SELL' },
      { interval: '1d', signal: 'NEUTRAL' },
    ],
  };

  const holdPolicy = buildChartExitPolicySnapshot(holdChart);
  assert.equal(holdPolicy.chartBearishConfirmed, false);
  assert.equal(holdPolicy.tv4hSignal, 'BULLISH');

  const sellPolicy = buildChartExitPolicySnapshot(sellChart);
  assert.equal(sellPolicy.chartBearishConfirmed, true);
  assert.equal(sellPolicy.stackedBearishConfirmed, true);

  const trailInput = buildDynamicTrailInputFromChart({
    position: { exchange: 'binance', avg_price: 100 },
    analysisSummary: holdChart,
    previousTrail: { stopPrice: 100 },
  });
  assert.ok(trailInput.atr >= 0.8, `ATR fallback/range must be material, got ${trailInput.atr}`);
  assert.equal(trailInput.breachBufferPct, 0.006);

  const minorBreach = computeDynamicTrail({
    ...trailInput,
    close: 99.7,
    previousStopPrice: 100,
  });
  assert.equal(minorBreach.breached, false);

  console.log(JSON.stringify({
    ok: true,
    smoke: 'position-chart-exit-policy',
    holdPolicy,
    sellPolicy,
    trailInput: {
      atr: trailInput.atr,
      breachBufferPct: trailInput.breachBufferPct,
    },
  }, null, 2));
} finally {
  if (saved === undefined) delete process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED;
  else process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED = saved;
}
