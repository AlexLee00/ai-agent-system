#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createHephaestosSignalExecutor } from '../team/hephaestos/signal-executor.ts';

const SIZING_SIZE = 100;

function buildExecutor({
  tradeDataGuardNotify = null,
  buyReentryMultiplier = 1,
  executionModeMultiplier = 1,
} = {}) {
  const marketBuyCalls = [];
  const resolveBuyOrderAmountCalls = [];
  const lifecycleEvents = [];
  const finalizeCalls = [];

  const executor = createHephaestosSignalExecutor({
    ACTIONS: { BUY: 'BUY', SELL: 'SELL' },
    SIGNAL_STATUS: { FAILED: 'failed', EXECUTED: 'executed' },
    db: {
      updateSignalAmount: async () => true,
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
        amountUsdt: Number(signal.amount_usdt || 0),
        base: String(signal.symbol || '').split('/')[0],
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
    runBuySafetyGuards: async () => ({ success: true, tradeDataGuardNotify }),
    checkCircuitBreaker: async () => ({ allowed: true }),
    getOpenPositions: async () => [],
    getMaxPositionsOverflowPolicy: () => ({}),
    getDailyTradeCount: async () => 0,
    formatDailyTradeLimitReason: () => '',
    tryAbsorbUntrackedBalance: async () => null,
    checkBuyReentryGuards: async () => ({
      success: true,
      reducedAmountMultiplier: buyReentryMultiplier,
      softGuardApplied: buyReentryMultiplier > 0 && buyReentryMultiplier < 1,
      softGuards: buyReentryMultiplier > 0 && buyReentryMultiplier < 1
        ? [{ kind: 'buy_reentry', multiplier: buyReentryMultiplier }]
        : [],
    }),
    _tryBuyWithBtcPair: async () => null,
    shouldBlockUsdtFallbackAfterBtcPairError: () => false,
    liquidateUntrackedForCapital: async () => true,
    resolveBuyExecutionMode: async () => ({
      effectivePaperMode: true,
      reducedAmountMultiplier: executionModeMultiplier,
      softGuardApplied: executionModeMultiplier > 0 && executionModeMultiplier < 1,
      softGuards: executionModeMultiplier > 0 && executionModeMultiplier < 1
        ? [{ kind: 'execution_mode', multiplier: executionModeMultiplier }]
        : [],
    }),
    rejectExecution: async ({ reason, code, meta }) => ({ success: false, reason, code, meta }),
    resolveBuyOrderAmount: async ({ reducedAmountMultiplier = 1, softGuards = [] }) => {
      resolveBuyOrderAmountCalls.push({ reducedAmountMultiplier, softGuards });
      return { actualAmount: Number((SIZING_SIZE * Number(reducedAmountMultiplier || 1)).toFixed(8)) };
    },
    applyResponsibilityExecutionSizing: (amount) => ({ amount, multiplier: 1, reason: null }),
    buildDeterministicClientOrderId: () => 'paper-client-id',
    marketBuy: async (symbol, amountUsdt, paperMode) => {
      marketBuyCalls.push({ symbol, amountUsdt, paperMode });
      return { filled: amountUsdt / 10, price: 10, cost: amountUsdt };
    },
    persistBuyPosition: async () => true,
    attachExecutionToPositionStrategyTracked: async () => true,
    syncCryptoStrategyExecutionState: async () => true,
    applyBuyProtectiveExit: async () => true,
    resolveSellExecutionContext: async () => ({ success: false }),
    resolveSellAmount: async () => ({ success: false }),
    executeSellTrade: async () => null,
    finalizeExecutedTrade: async (payload) => {
      finalizeCalls.push(payload);
      return true;
    },
    binanceExecutionReconcileHandler: { handleExecutionPendingReconcileError: async () => ({ handled: false }) },
    notifyError: async () => true,
    recordPositionLifecycleStageEvent: async (event) => {
      lifecycleEvents.push(event);
      return { id: `event-${lifecycleEvents.length}` };
    },
  });

  return { executor, marketBuyCalls, resolveBuyOrderAmountCalls, lifecycleEvents, finalizeCalls };
}

async function runScenario(name, options = {}) {
  const fixture = buildExecutor(options);
  const result = await fixture.executor.executeSignal({
    id: `sig-${name}`,
    symbol: 'MASK/USDT',
    action: 'BUY',
    amount_usdt: 100,
  });
  assert.equal(result.success, true, `${name} should execute`);
  assert.equal(fixture.marketBuyCalls.length, 1, `${name} should submit one buy`);
  assert.equal(fixture.resolveBuyOrderAmountCalls.length, 1, `${name} should resolve order amount once`);
  return fixture;
}

export async function runLunaTradeDataGuardSizingSmoke() {
  const notify = await runScenario('guard-notify', {
    tradeDataGuardNotify: {
      requestedAmountUsdt: 100,
      adjustedAmountUsdt: 25,
      sizingMultiplier: 0.25,
    },
  });
  assert.equal(notify.resolveBuyOrderAmountCalls[0].reducedAmountMultiplier, 0.25);
  assert.equal(notify.marketBuyCalls[0].amountUsdt, 25);
  assert.ok(notify.resolveBuyOrderAmountCalls[0].softGuards.some((guard) => guard.kind === 'trade_data_notify'));
  assert.ok(notify.finalizeCalls[0].executionMeta.softGuards.some((guard) => guard.kind === 'trade_data_notify'));
  assert.equal(notify.finalizeCalls[0].executionMeta.softGuardApplied, true);

  const noGuard = await runScenario('no-guard');
  assert.equal(noGuard.resolveBuyOrderAmountCalls[0].reducedAmountMultiplier, 1);
  assert.equal(noGuard.marketBuyCalls[0].amountUsdt, 100);
  assert.equal(noGuard.finalizeCalls[0].executionMeta.softGuardApplied, false);

  const stacked = await runScenario('stacked-guard', {
    buyReentryMultiplier: 0.5,
    tradeDataGuardNotify: {
      requestedAmountUsdt: 100,
      adjustedAmountUsdt: 25,
      sizingMultiplier: 0.25,
    },
  });
  assert.equal(stacked.resolveBuyOrderAmountCalls[0].reducedAmountMultiplier, 0.125);
  assert.equal(stacked.marketBuyCalls[0].amountUsdt, 12.5);

  for (const multiplier of [0, 1, 1.2]) {
    const invalid = await runScenario(`noop-${String(multiplier).replace('.', '-')}`, {
      tradeDataGuardNotify: {
        requestedAmountUsdt: 100,
        adjustedAmountUsdt: 0,
        sizingMultiplier: multiplier,
      },
    });
    assert.equal(invalid.resolveBuyOrderAmountCalls[0].reducedAmountMultiplier, 1);
    assert.equal(invalid.marketBuyCalls[0].amountUsdt, 100);
    assert.equal(
      invalid.resolveBuyOrderAmountCalls[0].softGuards.some((guard) => guard.kind === 'trade_data_notify'),
      false,
    );
  }

  return {
    ok: true,
    smoke: 'luna-trade-data-guard-sizing',
    scenarios: {
      guardNotifySizingApplied: true,
      noGuardRegression: true,
      stackedMultiplierApplied: true,
      invalidMultiplierNoop: true,
      tradeDataSoftGuardEvidence: true,
    },
  };
}

async function main() {
  const result = await runLunaTradeDataGuardSizingSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna trade-data guard sizing smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna trade-data guard sizing smoke 실패:',
  });
}
