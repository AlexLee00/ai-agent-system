#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildPositionCorrelationAdvisory, estimatePositionCorrelation } from '../shared/position-correlation.ts';
import { evaluateCandidateBacktestStatus } from '../shared/candidate-backtest-gate.ts';
import { computeDynamicPositionSizing } from '../shared/dynamic-position-sizer.ts';
import {
  isReverseExitPriorityEnabled,
  isTrailModeExpandEnabled,
  normalizeExitReasonTag,
  resolvePositionLifecycleFlags,
} from '../shared/position-lifecycle-flags.ts';

const saved = {
  pboEnabled: process.env.LUNA_PBO_GATE_ENABLED,
  pboMax: process.env.LUNA_PBO_MAX,
  conviction: process.env.LUNA_CONVICTION_ENABLED,
  sizing: process.env.LUNA_DYNAMIC_POSITION_SIZING_ENABLED,
  trailExpand: process.env.LUNA_TRAIL_MODE_EXPAND,
  reversePriority: process.env.LUNA_REVERSE_EXIT_PRIORITY,
};

try {
  assert.equal(estimatePositionCorrelation({ symbol: 'BTC/USDT' }, { symbol: 'BTC/USDT' }), 1);
  assert.equal(estimatePositionCorrelation({ symbol: 'BTC/USDT' }, { symbol: 'ETH/USDT' }), 0);
  const advisory = buildPositionCorrelationAdvisory({
    candidate: { symbol: 'BTC/USDT', direction: 'buy', strategy: 'trend' },
    openPositions: [{ symbol: 'BTC-PERP', side: 'buy', setup_type: 'trend' }],
    threshold: 0.8,
    reductionMultiplier: 0.7,
  });
  assert.equal(advisory.enabled, true);
  assert.equal(advisory.reductionMultiplier, 0.7);
  assert.equal(advisory.advisoryOnly, true);

  const pboOff = evaluateCandidateBacktestStatus(
    { fresh: true, healthy: true, pbo: 0.99, block_reasons: [] },
    { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow' },
  );
  assert.equal(pboOff.wouldBlock, false);
  const pboOn = evaluateCandidateBacktestStatus(
    { fresh: true, healthy: true, pbo: 0.42, block_reasons: [] },
    { LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE: 'shadow', LUNA_PBO_GATE_ENABLED: 'true', LUNA_PBO_MAX: '0.30' },
  );
  assert.equal(pboOn.wouldBlock, true);
  assert.equal(pboOn.reason, 'candidate_backtest_pbo_high');

  process.env.LUNA_DYNAMIC_POSITION_SIZING_ENABLED = 'true';
  delete process.env.LUNA_CONVICTION_ENABLED;
  const neutral = computeDynamicPositionSizing({
    pnlPct: 7.8,
    currentWeightPct: 0.08,
    targetVolatility: 0.03,
    realizedVolatility: 0.025,
    winRate: 0.62,
    rewardRisk: 1.9,
  });
  const disabledConviction = computeDynamicPositionSizing({
    pnlPct: 7.8,
    currentWeightPct: 0.08,
    targetVolatility: 0.03,
    realizedVolatility: 0.025,
    winRate: 0.62,
    rewardRisk: 1.9,
    regimeProbDelta: 0.6,
    regimeStabilityBars: 5,
  });
  assert.equal(disabledConviction.targetWeight, neutral.targetWeight, 'conviction env off must preserve output');
  process.env.LUNA_CONVICTION_ENABLED = 'true';
  const enabledConviction = computeDynamicPositionSizing({
    pnlPct: 7.8,
    currentWeightPct: 0.08,
    targetVolatility: 0.03,
    realizedVolatility: 0.025,
    winRate: 0.62,
    rewardRisk: 1.9,
    regimeProbDelta: 0.6,
    regimeStabilityBars: 5,
  });
  assert.equal(enabledConviction.details.convictionEnabled, true);
  assert.ok(enabledConviction.targetWeight >= neutral.targetWeight);

  delete process.env.LUNA_TRAIL_MODE_EXPAND;
  assert.equal(isTrailModeExpandEnabled(), false);
  process.env.LUNA_TRAIL_MODE_EXPAND = 'true';
  assert.equal(isTrailModeExpandEnabled(), true);
  assert.equal(resolvePositionLifecycleFlags().shouldApplyDynamicTrail(), true);
  delete process.env.LUNA_REVERSE_EXIT_PRIORITY;
  assert.equal(isReverseExitPriorityEnabled(), false);
  process.env.LUNA_REVERSE_EXIT_PRIORITY = 'true';
  assert.equal(isReverseExitPriorityEnabled(), true);
  assert.equal(normalizeExitReasonTag('signal_reverse_exit'), 'reverse');
  assert.equal(normalizeExitReasonTag('dynamic_trail_stop_breached'), 'trail');

  const payload = { ok: true, smoke: 'luna-loop-advisory-gates', advisory, pbo: pboOn.reason, convictionTarget: enabledConviction.targetWeight };
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
  else console.log('luna-loop-advisory-gates-smoke ok');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    const envName = {
      pboEnabled: 'LUNA_PBO_GATE_ENABLED',
      pboMax: 'LUNA_PBO_MAX',
      conviction: 'LUNA_CONVICTION_ENABLED',
      sizing: 'LUNA_DYNAMIC_POSITION_SIZING_ENABLED',
      trailExpand: 'LUNA_TRAIL_MODE_EXPAND',
      reversePriority: 'LUNA_REVERSE_EXIT_PRIORITY',
    }[key];
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
  }
}
