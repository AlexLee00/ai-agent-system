#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import * as legacy from '../team/luna.ts';
import * as policy from '../shared/luna-orchestration-policy.ts';

const active = {
  mode: 'ACTIVE_DISCOVERY',
  reasonCode: 'cash_available',
  buyableAmount: 180,
  minOrderAmount: 80,
  balanceStatus: 'ok',
  openPositionCount: 1,
  maxPositionCount: 3,
};
const constrained = {
  ...active,
  mode: 'MONITOR_ONLY',
  reasonCode: 'cash_constrained',
  buyableAmount: 20,
};

assert.equal(legacy.shouldRunDiscovery(active), policy.shouldRunDiscovery(active));
assert.equal(legacy.resolveCapitalGateAction(constrained, 2), policy.resolveCapitalGateAction(constrained, 2));
assert.equal(policy.resolveCapitalGateAction(constrained, 0), 'idle_digest');
assert.equal(policy.resolveCapitalGateAction(active, 2, 'monitor_only'), 'exit_only');
assert.equal(policy.formatCapitalModeLog(active).includes('mode=ACTIVE_DISCOVERY'), true);
assert.deepEqual(policy.applyDiscoveryThrottleToSymbols(['A', 'B', 'C'], { enabled: true, maxSymbols: 2 }), ['A', 'B']);
assert.deepEqual(policy.applyDiscoveryHardCap(['A', 'B', 'C'], 2), ['A', 'B']);
assert.deepEqual(policy.mergeUniqueSymbols(['A', 'B'], ['B', 'C']), ['A', 'B', 'C']);
assert.equal(policy.normalizeRegimeLabel({ regime: 'bull' }), 'bull');
assert.equal(policy.normalizeRegimeLabel(null), 'ranging');
assert.equal(policy.clamp01(2), 1);

const throttled = policy.applyDiscoveryThrottleToDecision({
  decisions: [
    { symbol: 'A', action: ACTIONS.BUY, confidence: 0.5, amount_usdt: 100 },
    { symbol: 'B', action: ACTIONS.BUY, confidence: 0.9, amount_usdt: 100 },
    { symbol: 'C', action: ACTIONS.SELL, confidence: 0.4, amount_usdt: 0 },
  ],
}, { enabled: true, maxBuyCandidates: 1, modeOverride: 'monitor_only' });
assert.equal(throttled.reducedCount, 1);
assert.equal(throttled.decision.decisions.find((item) => item.symbol === 'B').action, ACTIONS.BUY);
assert.equal(throttled.decision.decisions.find((item) => item.symbol === 'A').action, ACTIONS.HOLD);

const result = {
  ok: true,
  smoke: 'luna-orchestration-policy',
  checked: ['capital_gate', 'discovery_throttle', 'normalizers', 'legacy_reexport'],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('✅ luna orchestration policy smoke passed');
}

