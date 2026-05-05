#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  createPendingSignalProcessing,
  getPendingSignalDelayMs,
  getPendingSignalConcurrency,
  getPendingTradeModeQueueConcurrency,
} from '../team/hephaestos/pending-signal-processing.ts';
import {
  createHephaestosSignalExecutor,
  isHephaestosHotPathPrefetchEnabled,
} from '../team/hephaestos/signal-executor.ts';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function observeMaxConcurrency(concurrency) {
  let running = 0;
  let maxRunning = 0;
  const processor = createPendingSignalProcessing({
    executeSignal: async (signal) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(10);
      running -= 1;
      return { id: signal.id };
    },
    delay: async () => {},
  });

  const results = await processor.runPendingSignalBatch([
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
  ], {
    tradeMode: 'validation',
    delayMs: 0,
    concurrency,
  });

  return {
    maxRunning,
    resultIds: results.map((result) => result.id),
  };
}

assert.equal(getPendingSignalConcurrency({}), 1);
assert.equal(getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: '2' }), 2);
assert.equal(getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: '99' }), 4);
assert.equal(getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: 'bad' }), 1);
assert.equal(getPendingSignalConcurrency({ LUNA_PENDING_SIGNAL_CONCURRENCY: '3' }), 3);
assert.equal(getPendingSignalDelayMs({}), 500);
assert.equal(getPendingSignalDelayMs({ HEPHAESTOS_PENDING_SIGNAL_DELAY_MS: '120' }), 120);
assert.equal(getPendingSignalDelayMs({ HEPHAESTOS_PENDING_SIGNAL_DELAY_MS: '1' }), 50);
assert.equal(getPendingTradeModeQueueConcurrency({}), 1);
assert.equal(getPendingTradeModeQueueConcurrency({ HEPHAESTOS_PENDING_TRADE_MODE_QUEUE_CONCURRENCY: '2' }), 2);
assert.equal(getPendingTradeModeQueueConcurrency({ HEPHAESTOS_PENDING_TRADE_MODE_QUEUE_CONCURRENCY: '99' }), 2);

assert.equal(isHephaestosHotPathPrefetchEnabled({}), true);
assert.equal(isHephaestosHotPathPrefetchEnabled({ HEPHAESTOS_HOT_PATH_PREFETCH_ENABLED: '1' }), true);
assert.equal(isHephaestosHotPathPrefetchEnabled({ HEPHAESTOS_HOT_PATH_PREFETCH_ENABLED: 'true' }), true);
assert.equal(isHephaestosHotPathPrefetchEnabled({ HEPHAESTOS_HOT_PATH_PREFETCH_ENABLED: '0' }), false);
assert.equal(isHephaestosHotPathPrefetchEnabled({ HEPHAESTOS_HOT_PATH_PREFETCH_ENABLED: 'false' }), false);

const sequential = await observeMaxConcurrency(1);
assert.equal(sequential.maxRunning, 1);
assert.deepEqual(sequential.resultIds, ['a', 'b', 'c', 'd']);

const parallel = await observeMaxConcurrency(2);
assert.equal(parallel.maxRunning, 2);
assert.deepEqual(parallel.resultIds, ['a', 'b', 'c', 'd']);

let tradeModeRunning = 0;
let maxTradeModeRunning = 0;
const tradeModeProcessor = createPendingSignalProcessing({
  db: {
    getApprovedSignals: async (_exchange, tradeMode) => [{ id: tradeMode }],
  },
  initHubSecrets: async () => true,
  getInvestmentTradeMode: () => 'normal',
  processBinancePendingReconcileQueue: async () => ({ processed: 0 }),
  processBinancePendingJournalRepairQueue: async () => ({ processed: 0 }),
  syncPositionsAtMarketOpen: async () => ({ ok: true, mismatchCount: 0 }),
  cleanupStalePendingSignals: async () => [],
  reconcileLivePositionsWithBrokerBalance: async () => [],
  executeSignal: async (signal) => {
    tradeModeRunning += 1;
    maxTradeModeRunning = Math.max(maxTradeModeRunning, tradeModeRunning);
    await sleep(10);
    tradeModeRunning -= 1;
    return { id: signal.id };
  },
  delay: async () => {},
});

process.env.HEPHAESTOS_PENDING_TRADE_MODE_QUEUE_CONCURRENCY = '2';
process.env.HEPHAESTOS_PENDING_SIGNAL_DELAY_MS = '50';
const tradeModeResults = await tradeModeProcessor.processAllPendingSignals();
delete process.env.HEPHAESTOS_PENDING_TRADE_MODE_QUEUE_CONCURRENCY;
delete process.env.HEPHAESTOS_PENDING_SIGNAL_DELAY_MS;
assert.equal(maxTradeModeRunning, 2);
assert.deepEqual(tradeModeResults.map((result) => result.id).sort(), ['normal', 'validation']);

const retiredSynthetic = [];
const syntheticFilterProcessor = createPendingSignalProcessing({
  db: {
    getApprovedSignals: async () => [
      { id: 'reflect-1', symbol: 'REFLECT_123', status: 'approved', created_at: '2026-05-05T00:00:00.000Z' },
      { id: 'live-1', symbol: 'BTC/USDT', status: 'approved', created_at: '2026-05-05T00:01:00.000Z' },
    ],
    updateSignalBlock: async (id, payload) => {
      retiredSynthetic.push({ id, payload });
    },
  },
  initHubSecrets: async () => true,
  getInvestmentTradeMode: () => 'normal',
  processBinancePendingReconcileQueue: async () => ({ processed: 0 }),
  processBinancePendingJournalRepairQueue: async () => ({ processed: 0 }),
  syncPositionsAtMarketOpen: async () => ({ ok: true, mismatchCount: 0 }),
  cleanupStalePendingSignals: async () => [],
  reconcileLivePositionsWithBrokerBalance: async () => [],
  executeSignal: async () => ({}),
  delay: async () => {},
});
const syntheticFiltered = await syntheticFilterProcessor.listHephaestosExecutableSignals('normal');
assert.equal(syntheticFiltered.signals.length, 1);
assert.equal(syntheticFiltered.signals[0].symbol, 'BTC/USDT');
assert.equal(syntheticFiltered.syntheticCount, 1);
assert.equal(retiredSynthetic.length, 1);
assert.equal(retiredSynthetic[0].id, 'reflect-1');
assert.equal(retiredSynthetic[0].payload.code, 'synthetic_reflection_signal');

const prefetchEvents = [];
const hotPathExecutor = createHephaestosSignalExecutor({
  ACTIONS: { BUY: 'BUY', SELL: 'SELL' },
  SIGNAL_STATUS: { FAILED: 'failed', EXECUTED: 'executed' },
  db: {
    updateSignalStatus: async () => true,
  },
  initHubSecrets: async () => {
    prefetchEvents.push('secrets:start');
    await sleep(20);
    prefetchEvents.push('secrets:end');
    return true;
  },
  isPaperMode: () => true,
  getInvestmentTradeMode: () => 'normal',
  getCapitalConfig: () => ({}),
  getDynamicMinOrderAmount: () => 10,
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
      base: 'BTC',
      tag: '[PAPER]',
      effectivePaperMode: true,
    },
  }),
  buildExecutionRiskApprovalGuard: () => ({ approved: true }),
  notifyTradeSkip: async () => true,
  normalizePartialExitRatio: () => null,
  buildSignalQualityContext: () => ({}),
  getInvestmentAgentRoleState: async () => {
    prefetchEvents.push('role:start');
    await sleep(5);
    prefetchEvents.push('role:end');
    return { role: 'executor' };
  },
  createSignalFailurePersister: () => async () => true,
  isBinanceSymbol: () => true,
  binanceExecutionReconcileHandler: {
    handleExecutionPendingReconcileError: async () => ({ handled: false }),
  },
  notifyError: async () => true,
});

await hotPathExecutor.executeSignal({
  id: 1,
  symbol: 'BTC/USDT',
  action: 'HOLD',
  amount_usdt: 0,
});
assert.ok(prefetchEvents.includes('role:start'));
assert.ok(prefetchEvents.includes('secrets:start'));
assert.ok(
  prefetchEvents.indexOf('role:start') < prefetchEvents.indexOf('secrets:end'),
  `role prefetch should start before secrets finish: ${prefetchEvents.join(' -> ')}`,
);

const payload = {
  ok: true,
  smoke: 'hephaestos-hot-path-options',
  sequential,
  parallel,
  prefetchEvents,
  tradeModeQueue: {
    maxRunning: maxTradeModeRunning,
    resultIds: tradeModeResults.map((result) => result.id).sort(),
  },
  maxConfiguredConcurrency: getPendingSignalConcurrency({ HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY: '99' }),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos hot path options smoke passed');
}
