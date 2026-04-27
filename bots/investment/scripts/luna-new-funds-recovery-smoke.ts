#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveCapitalGateAction, shouldRunDiscovery } from '../team/luna.ts';
import { adjustLunaBuyCandidate } from '../shared/capital-manager.ts';

function snapshot(overrides = {}) {
  return {
    exchange: 'binance',
    tradeMode: 'normal',
    mode: 'CASH_CONSTRAINED',
    reasonCode: 'cash_constrained_monitor_only',
    freeCash: 8,
    availableBalance: 8,
    reservedCash: 2,
    buyableAmount: 6,
    minOrderAmount: 10,
    feeBufferAmount: 0.1,
    openPositionCount: 2,
    maxPositionCount: 7,
    remainingSlots: 5,
    totalCapital: 100,
    balanceStatus: 'ok',
    source: 'broker',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function runLunaNewFundsRecoverySmoke() {
  const beforeDeposit = snapshot();
  assert.equal(shouldRunDiscovery(beforeDeposit), false);
  assert.equal(resolveCapitalGateAction(beforeDeposit, beforeDeposit.openPositionCount), 'exit_only');
  const beforeBuy = adjustLunaBuyCandidate(50, beforeDeposit);
  assert.equal(beforeBuy.result, 'blocked_cash');

  const afterDeposit = snapshot({
    mode: 'ACTIVE_DISCOVERY',
    reasonCode: null,
    freeCash: 250,
    availableBalance: 250,
    reservedCash: 25,
    buyableAmount: 220,
    totalCapital: 350,
  });
  assert.equal(shouldRunDiscovery(afterDeposit), true);
  assert.equal(resolveCapitalGateAction(afterDeposit, afterDeposit.openPositionCount), 'active_discovery');
  const firstCandidate = adjustLunaBuyCandidate(100, afterDeposit);
  assert.equal(firstCandidate.result, 'reduced');
  assert.ok(firstCandidate.adjustedAmount >= afterDeposit.minOrderAmount);

  const diversifiedCandidate = adjustLunaBuyCandidate(35, afterDeposit);
  assert.equal(diversifiedCandidate.result, 'accepted');
  assert.equal(diversifiedCandidate.adjustedAmount, 35);

  return {
    ok: true,
    before: {
      mode: beforeDeposit.mode,
      action: resolveCapitalGateAction(beforeDeposit, beforeDeposit.openPositionCount),
      buyResult: beforeBuy.result,
    },
    after: {
      mode: afterDeposit.mode,
      action: resolveCapitalGateAction(afterDeposit, afterDeposit.openPositionCount),
      firstCandidate: firstCandidate.result,
      firstAdjustedAmount: firstCandidate.adjustedAmount,
      diversifiedCandidate: diversifiedCandidate.result,
    },
  };
}

async function main() {
  const result = runLunaNewFundsRecoverySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna new-funds recovery smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna new-funds recovery smoke 실패:',
  });
}
