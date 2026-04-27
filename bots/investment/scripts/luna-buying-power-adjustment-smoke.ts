#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { adjustLunaBuyCandidate } from '../shared/capital-manager.ts';

function snapshot(overrides = {}) {
  return {
    exchange: 'binance',
    tradeMode: 'normal',
    mode: 'ACTIVE_DISCOVERY',
    reasonCode: null,
    freeCash: 200,
    availableBalance: 200,
    reservedCash: 10,
    buyableAmount: 180,
    minOrderAmount: 50,
    feeBufferAmount: 1,
    openPositionCount: 1,
    maxPositionCount: 6,
    remainingSlots: 5,
    totalCapital: 300,
    balanceStatus: 'ok',
    source: 'broker',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function runLunaBuyingPowerAdjustmentSmoke() {
  const accepted = adjustLunaBuyCandidate(100, snapshot({ buyableAmount: 300, remainingSlots: 3 }));
  assert.equal(accepted.result, 'accepted');
  assert.equal(accepted.adjustedAmount, 100);

  const reduced = adjustLunaBuyCandidate(180, snapshot({ buyableAmount: 120, remainingSlots: 1 }));
  assert.equal(reduced.result, 'reduced');
  assert.equal(reduced.adjustedAmount, 120);

  const blockedCash = adjustLunaBuyCandidate(100, snapshot({ buyableAmount: 40, minOrderAmount: 50 }));
  assert.equal(blockedCash.result, 'blocked_cash');
  assert.equal(blockedCash.adjustedAmount, 0);

  const blockedSlots = adjustLunaBuyCandidate(100, snapshot({ remainingSlots: 0 }));
  assert.equal(blockedSlots.result, 'blocked_slots');
  assert.equal(blockedSlots.adjustedAmount, 0);

  const blockedUnavailable = adjustLunaBuyCandidate(100, snapshot({ balanceStatus: 'unavailable' }));
  assert.equal(blockedUnavailable.result, 'blocked_balance_unavailable');
  assert.equal(blockedUnavailable.adjustedAmount, 0);

  const reduceOnly = adjustLunaBuyCandidate(100, snapshot({ mode: 'REDUCING_ONLY' }));
  assert.equal(reduceOnly.result, 'reduce_only');
  assert.equal(reduceOnly.adjustedAmount, 0);

  return {
    ok: true,
    cases: {
      accepted: accepted.result,
      reduced: reduced.result,
      blockedCash: blockedCash.result,
      blockedSlots: blockedSlots.result,
      blockedUnavailable: blockedUnavailable.result,
      reduceOnly: reduceOnly.result,
    },
  };
}

async function main() {
  const result = runLunaBuyingPowerAdjustmentSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna buying power adjustment smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna buying power adjustment smoke 실패:',
  });
}
