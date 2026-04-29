#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildSellBalancePolicy } from '../team/hephaestos/sell-balance-policy.ts';

const lockedPartial = buildSellBalancePolicy({
  sourceAmount: 799.65336,
  freeBalance: 0.00336,
  totalBalance: 799.65336,
  partialExitRatio: 0.4444,
});
assert.equal(lockedPartial.lockedByOpenOrders, true);
assert.equal(lockedPartial.truePositionDrift, false);
assert.ok(lockedPartial.lockedBalance > 799);
assert.ok(lockedPartial.intendedSellAmount > 300);

const trueDrift = buildSellBalancePolicy({
  sourceAmount: 799.65336,
  freeBalance: 120,
  totalBalance: 120,
  partialExitRatio: 0.5,
});
assert.equal(trueDrift.lockedByOpenOrders, false);
assert.equal(trueDrift.truePositionDrift, true);
assert.equal(trueDrift.reconcileTrackedAmount, 120);

const normal = buildSellBalancePolicy({
  sourceAmount: 100,
  freeBalance: 100,
  totalBalance: 100,
  partialExitRatio: 0.25,
});
assert.equal(normal.lockedByOpenOrders, false);
assert.equal(normal.truePositionDrift, false);
assert.equal(normal.intendedSellAmount, 25);

const payload = {
  ok: true,
  smoke: 'hephaestos-sell-balance-policy',
  lockedPartial,
  trueDrift,
  normal,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('hephaestos-sell-balance-policy-smoke ok');
}
