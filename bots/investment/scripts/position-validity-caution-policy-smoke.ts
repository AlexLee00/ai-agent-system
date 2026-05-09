#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { applyValidityActionDecision } from '../shared/position-reevaluator.ts';

const validity = { recommendedAction: 'CAUTION', score: 1 };
const baseHold = { recommendation: 'HOLD', reasonCode: 'hold_bias', reason: 'hold' };

const monitorOnly = applyValidityActionDecision(baseHold, validity, {
  pnlPct: 0.5,
  heldHours: 34,
  analysisSummary: {
    buy: 0,
    hold: 8,
    sell: 0,
    avgConfidence: 0.58,
    liveIndicator: { compositeSignal: 'HOLD' },
  },
});

assert.equal(monitorOnly.decision.recommendation, 'HOLD');
assert.equal(monitorOnly.decision.reasonCode, 'validity_caution_monitor_only');
assert.equal(monitorOnly.validityReason, 'caution_monitor_only');

const bearishAdjust = applyValidityActionDecision(baseHold, validity, {
  pnlPct: 0.5,
  heldHours: 34,
  analysisSummary: {
    buy: 0,
    hold: 2,
    sell: 3,
    avgConfidence: 0.6,
    liveIndicator: {
      compositeSignal: 'SELL',
      timeframes: [
        { interval: '1h', signal: 'BEARISH' },
        { interval: '4h', signal: 'BEARISH' },
        { interval: '1d', signal: 'BEARISH' },
      ],
    },
  },
});

assert.equal(bearishAdjust.decision.recommendation, 'ADJUST');
assert.equal(bearishAdjust.decision.reasonCode, 'validity_caution_adjust');

const profitAdjust = applyValidityActionDecision(baseHold, validity, {
  pnlPct: 3.1,
  heldHours: 34,
  analysisSummary: {
    buy: 0,
    hold: 8,
    sell: 0,
    avgConfidence: 0.58,
    liveIndicator: { compositeSignal: 'HOLD' },
  },
});

assert.equal(profitAdjust.decision.recommendation, 'ADJUST');
assert.equal(profitAdjust.decision.reasonCode, 'validity_caution_adjust');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    ok: true,
    smoke: 'position-validity-caution-policy',
    monitorOnly: monitorOnly.decision.reasonCode,
    bearishAdjust: bearishAdjust.decision.reasonCode,
    profitAdjust: profitAdjust.decision.reasonCode,
  }, null, 2));
} else {
  console.log('position-validity-caution-policy-smoke ok');
}
