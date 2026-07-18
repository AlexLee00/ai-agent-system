#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  isGuardSizingAuthorityEnabled,
  resolveGuardSizingAuthority,
} from '../team/hephaestos/guard-sizing-authority.ts';
import { createHephaestosSignalExecutor } from '../team/hephaestos/signal-executor.ts';

const zecGuard = {
  source: 'crypto_defensive_rotation_without_live_evidence',
  referenceAmountUsdt: 36.37,
  multiplier: 0.25,
  capAmountUsdt: 9.0925,
};
const zecNotify = {
  blockers: ['crypto_defensive_rotation_without_live_evidence'],
  sizingMultiplier: 0.25,
  requestedAmountUsdt: 36.37,
  adjustedAmountUsdt: 9.0925,
};

function resolve(downstreamAmountUsdt, guardCaps, env = {}) {
  return resolveGuardSizingAuthority({
    downstreamAmountUsdt,
    guardCaps,
    minOrderUsdt: 5,
  }, env);
}

assert.equal(isGuardSizingAuthorityEnabled({}), false);
assert.equal(isGuardSizingAuthorityEnabled({ LUNA_GUARD_SIZING_AUTHORITY: 'off' }), false);
assert.equal(isGuardSizingAuthorityEnabled({ LUNA_GUARD_SIZING_AUTHORITY: '1' }), true);

const off = resolve(98.975, [zecGuard]);
assert.equal(off.appliedAmountUsdt, 98.975);
assert.equal(off.counterfactualAmountUsdt, 9.0925);
assert.equal(off.applied, false);

const on = resolve(98.975, [zecGuard], { LUNA_GUARD_SIZING_AUTHORITY: 'on' });
assert.equal(on.appliedAmountUsdt, 9.0925);
assert.equal(on.counterfactualAmountUsdt, 9.0925);
assert.equal(on.applied, true);

const zero = resolve(98.975, [{
  source: 'zero_guard',
  referenceAmountUsdt: 36.37,
  multiplier: 0,
  capAmountUsdt: 0,
}], { LUNA_GUARD_SIZING_AUTHORITY: 'on' });
assert.equal(zero.appliedAmountUsdt, 0);
assert.equal(zero.wouldRejectBelowMinimum, true);

const neutral = resolve(98.975, [{
  source: 'neutral_guard',
  referenceAmountUsdt: 36.37,
  multiplier: 1,
  capAmountUsdt: 36.37,
}], { LUNA_GUARD_SIZING_AUTHORITY: 'on' });
assert.equal(neutral.appliedAmountUsdt, 98.975);
assert.equal(neutral.authoritativeCapUsdt, null);

const multiple = resolve(100, [
  { source: 'guard_a', referenceAmountUsdt: 100, multiplier: 0.5, capAmountUsdt: 50 },
  { source: 'guard_b', referenceAmountUsdt: 100, multiplier: 0.25, capAmountUsdt: 25 },
  { source: 'guard_b_duplicate', referenceAmountUsdt: 100, multiplier: 0.25, capAmountUsdt: 25 },
], { LUNA_GUARD_SIZING_AUTHORITY: 'on' });
assert.equal(multiple.appliedAmountUsdt, 25);
assert.equal(multiple.authoritativeCapUsdt, 25);
assert.equal(multiple.winningCap.source, 'guard_b');

const invalid = resolve(100, [{
  source: 'invalid_guard',
  referenceAmountUsdt: 100,
  multiplier: 1.2,
  capAmountUsdt: 120,
}], { LUNA_GUARD_SIZING_AUTHORITY: 'on' });
assert.equal(invalid.appliedAmountUsdt, 0);
assert.equal(invalid.invalidCaps.length, 1);

async function executeZec(env, tradeDataGuardNotify = zecNotify, btcDirectResult = null) {
  const brokerAmounts = [];
  const lifecycle = [];
  let btcPairAttempts = 0;
  let liquidationAttempts = 0;
  const executor = createHephaestosSignalExecutor({
    env,
    ACTIONS: { BUY: 'buy', SELL: 'sell' },
    SIGNAL_STATUS: { FAILED: 'failed', EXECUTED: 'executed' },
    db: { getPaperPosition: async () => null, updateSignalStatus: async () => {} },
    initHubSecrets: async () => true,
    isPaperMode: () => false,
    getInvestmentTradeMode: () => 'normal',
    getCapitalConfig: async () => ({}),
    getDynamicMinOrderAmount: async () => 5,
    buildHephaestosExecutionPreflight: async () => ({
      globalPaperMode: false,
      signalTradeMode: 'normal',
      capitalPolicy: {},
      minOrderUsdt: 5,
      executionContext: {
        signalId: 77,
        symbol: 'ZEC/USDT',
        action: 'buy',
        base: 'ZEC',
        tag: 'guard-authority-smoke',
        amountUsdt: 36.37,
        effectivePaperMode: false,
        exchange: 'binance',
      },
    }),
    buildExecutionRiskApprovalGuard: () => ({ approved: true }),
    notifyTradeSkip: async () => {},
    normalizePartialExitRatio: () => 1,
    buildSignalQualityContext: () => ({}),
    getInvestmentAgentRoleState: async () => null,
    createSignalFailurePersister: () => async () => {},
    isBinanceSymbol: () => true,
    maybePromotePaperPositions: async () => [],
    runBuySafetyGuards: async () => ({
      success: true,
      tradeDataGuardNotify,
    }),
    tryAbsorbUntrackedBalance: async () => null,
    checkBuyReentryGuards: async () => ({ success: true, reducedAmountMultiplier: 1, softGuards: [] }),
    _tryBuyWithBtcPair: async () => {
      btcPairAttempts += 1;
      return btcDirectResult;
    },
    shouldBlockUsdtFallbackAfterBtcPairError: () => false,
    liquidateUntrackedForCapital: async () => { liquidationAttempts += 1; },
    resolveBuyExecutionMode: async () => ({
      success: true,
      effectivePaperMode: false,
      effectiveTradeMode: 'normal',
      reducedAmountMultiplier: 1,
      softGuards: [],
      softGuardApplied: false,
    }),
    rejectExecution: async ({ reason, code, meta }) => ({ success: false, reason, code, meta }),
    resolveBuyOrderAmount: async () => ({ success: true, actualAmount: 98.975 }),
    applyResponsibilityExecutionSizing: (amount) => ({ amount, multiplier: 1, reason: null }),
    buildDeterministicClientOrderId: () => 'guard-authority-smoke-77',
    marketBuy: async (_symbol, amount) => {
      brokerAmounts.push(amount);
      return { filled: amount / 546.822, price: 546.822, cost: amount };
    },
    persistBuyPosition: async () => {},
    attachExecutionToPositionStrategyTracked: async () => {},
    syncCryptoStrategyExecutionState: async () => {},
    applyBuyProtectiveExit: async () => {},
    finalizeExecutedTrade: async () => {},
    binanceExecutionReconcileHandler: { handleExecutionPendingReconcileError: async ({ error }) => ({ handled: false, error }) },
    notifyError: async () => {},
    recordPositionLifecycleStageEvent: async (event) => {
      lifecycle.push(event);
      return event;
    },
  });
  const result = await executor.executeSignal({
    id: 77,
    symbol: 'ZEC/USDT',
    action: 'buy',
    amount_usdt: 36.37,
    confidence: 0.8,
    exchange: 'binance',
  });
  return { result, brokerAmounts, lifecycle, btcPairAttempts, liquidationAttempts };
}

const offExecution = await executeZec({});
assert.deepEqual(offExecution.brokerAmounts, [98.975]);
assert.equal(offExecution.btcPairAttempts, 1);
assert.equal(offExecution.lifecycle.find((event) => event.stageId === 'stage_3')
  ?.evidenceSnapshot?.guardSizingAuthority?.counterfactualAmountUsdt, 9.0925);

const onExecution = await executeZec({ LUNA_GUARD_SIZING_AUTHORITY: 'on' });
assert.deepEqual(onExecution.brokerAmounts, [9.0925]);
assert.equal(onExecution.btcPairAttempts, 0);

const zeroExecution = await executeZec({ LUNA_GUARD_SIZING_AUTHORITY: 'on' }, {
  blockers: ['zero_guard'],
  sizingMultiplier: 0,
  requestedAmountUsdt: 36.37,
  adjustedAmountUsdt: 0,
});
assert.equal(zeroExecution.result.success, false);
assert.deepEqual(zeroExecution.brokerAmounts, []);
assert.equal(zeroExecution.liquidationAttempts, 0);

const neutralExecution = await executeZec({ LUNA_GUARD_SIZING_AUTHORITY: 'on' }, {
  blockers: ['neutral_guard'],
  sizingMultiplier: 1,
  requestedAmountUsdt: 36.37,
  adjustedAmountUsdt: 36.37,
});
assert.deepEqual(neutralExecution.brokerAmounts, [98.975]);
assert.equal(neutralExecution.btcPairAttempts, 1);

const btcDirectExecution = await executeZec({}, zecNotify, {
  success: true,
  btcDirect: true,
  btcPair: 'ZEC/BTC',
  amount: 0.2,
  price: 546.822,
});
const btcDirectLifecycle = btcDirectExecution.lifecycle.find((event) => event.stageId === 'stage_4');
assert.equal(btcDirectExecution.result.btcDirect, true);
assert.equal(btcDirectLifecycle.evidenceSnapshot.guardSizingAuthority.counterfactualAmountUsdt, 9.0925);
assert.equal(btcDirectLifecycle.evidenceSnapshot.counterfactualQuantity, 9.0925 / 546.822);

console.log(JSON.stringify({
  ok: true,
  checks: 31,
  zecLegacyAmountUsdt: off.appliedAmountUsdt,
  zecCounterfactualAmountUsdt: off.counterfactualAmountUsdt,
  zecAuthoritativeAmountUsdt: on.appliedAmountUsdt,
}));
