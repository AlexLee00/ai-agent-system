#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createRiskAndCapitalGatePolicy } from '../team/hephaestos/risk-and-capital-gates.ts';
import { createHephaestosSignalExecutor } from '../team/hephaestos/signal-executor.ts';

function buildPolicy({
  sizing = { skip: false, size: 80, capitalPct: 8, riskPercent: 1.2 },
  minOrderUsdt = 10,
  updateSignalAmount = async () => {},
} = {}) {
  const persistCalls = [];
  const amountUpdates = [];
  const policy = createRiskAndCapitalGatePolicy({
    getInvestmentExecutionRuntimeConfig: () => ({}),
    preTradeCheck: async () => ({ allowed: true }),
    db: {
      updateSignalBlock: async () => {},
      updateSignalAmount: async (id, amount) => {
        amountUpdates.push({ id, amount });
        return updateSignalAmount(id, amount);
      },
    },
    notifyTradeSkip: async () => {},
    getOpenPositions: async () => [],
    findAnyLivePosition: async () => null,
    fetchTicker: async () => 10,
    calculatePositionSize: async () => sizing,
    getDynamicMinOrderAmount: async () => minOrderUsdt,
    getInvestmentTradeMode: () => 'normal',
  });
  return { policy, persistCalls, amountUpdates };
}

async function resolve(policy, overrides = {}) {
  const persistCalls = overrides.persistCalls || [];
  return policy.resolveBuyOrderAmount({
    persistFailure: async (reason, meta) => {
      persistCalls.push({ reason, meta });
      return { success: false, reason, meta };
    },
    symbol: 'MASK/USDT',
    action: 'BUY',
    amountUsdt: 300,
    signal: { id: 'sig-live-sizing', trade_mode: 'normal', slPrice: 8 },
    effectivePaperMode: false,
    ...overrides,
  });
}

function executorDepsForSignalAmountSmoke({
  signalAmountUpdates = [],
  updateSignalAmount = async () => {},
  marketBuyCalls = [],
} = {}) {
  return {
    ACTIONS: { BUY: 'BUY', SELL: 'SELL' },
    SIGNAL_STATUS: { FAILED: 'failed', EXECUTED: 'executed' },
    db: {
      updateSignalAmount: async (id, amount) => {
        signalAmountUpdates.push({ id, amount });
        return updateSignalAmount(id, amount);
      },
      updateSignalStatus: async () => true,
      updateSignalBlock: async () => true,
      getPaperPosition: async () => null,
    },
    initHubSecrets: async () => true,
    isPaperMode: () => true,
    getInvestmentTradeMode: () => 'normal',
    getCapitalConfig: () => ({}),
    getDynamicMinOrderAmount: async () => 10,
    buildHephaestosExecutionPreflight: async (signal) => ({
      globalPaperMode: true,
      signalTradeMode: 'normal',
      capitalPolicy: {},
      minOrderUsdt: 10,
      executionContext: {
        signalId: signal.id,
        symbol: signal.symbol,
        action: signal.action,
        amountUsdt: signal.amount_usdt,
        base: 'MASK',
        tag: '[PAPER]',
        effectivePaperMode: true,
      },
    }),
    buildExecutionRiskApprovalGuard: () => ({ approved: true }),
    notifyTradeSkip: async () => true,
    normalizePartialExitRatio: () => null,
    buildSignalQualityContext: () => ({}),
    getInvestmentAgentRoleState: async () => null,
    createSignalFailurePersister: () => async () => true,
    isBinanceSymbol: () => true,
    maybePromotePaperPositions: async () => [],
    runBuySafetyGuards: async () => ({ success: true }),
    checkCircuitBreaker: async () => ({ allowed: true }),
    getOpenPositions: async () => [],
    getMaxPositionsOverflowPolicy: () => ({}),
    getDailyTradeCount: async () => 0,
    formatDailyTradeLimitReason: () => '',
    tryAbsorbUntrackedBalance: async () => null,
    checkBuyReentryGuards: async () => ({ success: true }),
    _tryBuyWithBtcPair: async () => null,
    shouldBlockUsdtFallbackAfterBtcPairError: () => false,
    liquidateUntrackedForCapital: async () => true,
    resolveBuyExecutionMode: async () => ({ effectivePaperMode: true }),
    rejectExecution: async ({ reason, code }) => ({ success: false, reason, code }),
    resolveBuyOrderAmount: async () => ({ actualAmount: 84 }),
    applyResponsibilityExecutionSizing: () => ({ amount: 42, multiplier: 0.5, reason: 'smoke_responsibility' }),
    buildDeterministicClientOrderId: () => 'client-smoke',
    marketBuy: async (symbol, amountUsdt, paperMode) => {
      marketBuyCalls.push({ symbol, amountUsdt, paperMode });
      return { filled: 2, price: 21, cost: amountUsdt };
    },
    persistBuyPosition: async () => true,
    attachExecutionToPositionStrategyTracked: async () => true,
    syncCryptoStrategyExecutionState: async () => true,
    applyBuyProtectiveExit: async () => true,
    resolveSellExecutionContext: async () => ({ success: false }),
    resolveSellAmount: async () => ({ success: false }),
    executeSellTrade: async () => null,
    finalizeExecutedTrade: async () => true,
    binanceExecutionReconcileHandler: { handleExecutionPendingReconcileError: async () => ({ handled: false }) },
    notifyError: async () => true,
    recordPositionLifecycleStageEvent: async () => true,
  };
}

export async function runLunaPaperLiveSizingSmoke() {
  const liveFixture = buildPolicy({ sizing: { skip: false, size: 80, capitalPct: 8, riskPercent: 1.2 } });
  const live = await resolve(liveFixture.policy, { effectivePaperMode: false });
  const paperFixture = buildPolicy({ sizing: { skip: false, size: 80, capitalPct: 8, riskPercent: 1.2 } });
  const paper = await resolve(paperFixture.policy, { effectivePaperMode: true });
  assert.equal(live.actualAmount, 80);
  assert.equal(paper.actualAmount, 80);
  assert.deepEqual(liveFixture.amountUpdates, []);
  assert.deepEqual(paperFixture.amountUpdates, []);

  const skipFixture = buildPolicy({
    sizing: { skip: true, size: 0, reason: '포지션 크기 0 < 최소 10', capitalPct: null, riskPercent: null },
  });
  const skipPersist = [];
  const skipPaper = await resolve(skipFixture.policy, {
    effectivePaperMode: true,
    persistCalls: skipPersist,
  });
  assert.equal(skipPaper.success, false);
  assert.equal(skipPersist[0]?.meta?.code, 'position_sizing_rejected');
  assert.deepEqual(skipFixture.amountUpdates, []);

  const minOrderFixture = buildPolicy({
    sizing: { skip: false, size: 7, capitalPct: 0.7, riskPercent: 1.2 },
    minOrderUsdt: 10,
  });
  const minOrderPersist = [];
  const minOrderPaper = await resolve(minOrderFixture.policy, {
    effectivePaperMode: true,
    persistCalls: minOrderPersist,
  });
  assert.equal(minOrderPaper.success, false);
  assert.equal(minOrderPersist[0]?.meta?.code, 'position_sizing_rejected');
  assert.deepEqual(minOrderFixture.amountUpdates, []);

  const previousCap = process.env.LUNA_MAX_TRADE_USDT;
  try {
    process.env.LUNA_MAX_TRADE_USDT = '50';
    const capFixture = buildPolicy({ sizing: { skip: false, size: 120, capitalPct: 12, riskPercent: 1.2 } });
    const cappedPaper = await resolve(capFixture.policy, { effectivePaperMode: true });
    assert.equal(cappedPaper.actualAmount, 50);
    assert.equal(cappedPaper.liveFireCapApplied, true);
    assert.deepEqual(capFixture.amountUpdates, []);
  } finally {
    if (previousCap === undefined) delete process.env.LUNA_MAX_TRADE_USDT;
    else process.env.LUNA_MAX_TRADE_USDT = previousCap;
  }

  const signalAmountUpdates = [];
  const marketBuyCalls = [];
  const executor = createHephaestosSignalExecutor(executorDepsForSignalAmountSmoke({
    signalAmountUpdates,
    marketBuyCalls,
  }));
  const execution = await executor.executeSignal({
    id: 'sig-final-sizing',
    symbol: 'MASK/USDT',
    action: 'BUY',
    amount_usdt: 300,
  });
  assert.equal(execution.success, true);
  assert.deepEqual(signalAmountUpdates, [{ id: 'sig-final-sizing', amount: 42 }]);
  assert.deepEqual(marketBuyCalls, [{ symbol: 'MASK/USDT', amountUsdt: 42, paperMode: true }]);

  const throwUpdates = [];
  const failOpenExecutor = createHephaestosSignalExecutor({
    ...executorDepsForSignalAmountSmoke({
      signalAmountUpdates: throwUpdates,
      updateSignalAmount: async () => {
        throw new Error('update_failed');
      },
      marketBuyCalls: [],
    }),
  });
  const failOpen = await failOpenExecutor.executeSignal({
    id: 'sig-final-sizing-fail-open',
    symbol: 'MASK/USDT',
    action: 'BUY',
    amount_usdt: 300,
  });
  assert.equal(failOpen.success, true);
  assert.deepEqual(throwUpdates, [{ id: 'sig-final-sizing-fail-open', amount: 42 }]);

  return {
    ok: true,
    smoke: 'luna-paper-live-sizing',
    scenarios: {
      paperLiveAmountEqual: true,
      paperSizingSkipRejected: true,
      paperMinOrderRejected: true,
      paperLiveFireCapApplied: true,
      signalAmountSynced: true,
      signalAmountSyncFailOpen: true,
    },
  };
}

async function main() {
  const result = await runLunaPaperLiveSizingSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna paper/live sizing smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna paper/live sizing smoke 실패:',
  });
}
