#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import {
  buildBinancePendingReconcilePayload,
  computeBinancePendingRecordedProgress,
  enqueueClientOrderPendingRetry,
  processBinancePendingJournalRepairQueue,
  processBinancePendingReconcileQueue,
  resolveBinancePendingQueueState,
  shouldBlockUsdtFallbackAfterBtcPairError,
} from '../team/hephaestos.ts';
import { createBinanceExecutionReconcileHandler } from '../team/hephaestos/binance-order-reconcile.ts';

function parseMeta(value = null) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function runBinancePendingQueuePathSmoke() {
  const marker = `smoke-binance-reconcile-${Date.now()}`;
  const ids = {
    zeroToFilled: `${marker}-zero-to-filled`,
    partialToClosed: `${marker}-partial-to-closed`,
    applyFailRetry: `${marker}-apply-fail-retry`,
    btcPairOpen: `${marker}-btc-pair-open`,
    btcPairClosed: `${marker}-btc-pair-closed`,
    clientOrderRecover: `${marker}-client-order-recover`,
    missingOrderId: `${marker}-missing-order-id`,
    unsupportedQuote: `${marker}-unsupported-quote`,
  };

  await db.initSchema();
  const inserts = [
    {
      id: ids.zeroToFilled,
      symbol: 'PHA/USDT',
      action: 'BUY',
      amountUsdt: 100,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'PHA/USDT',
          action: 'BUY',
          orderId: 'SMOKE-O1',
          expectedQty: 5,
          filledQty: 0,
          recordedFilledQty: 0,
          recordedCost: 0,
          followUpRequired: true,
          journalPending: {
            followUpRequired: true,
            queueStatus: 'queued',
            attempts: 1,
            tradeId: `${marker}-seed-journal`,
            incidentLink: `${marker}:seed`,
          },
        },
      },
    },
    {
      id: ids.partialToClosed,
      symbol: 'ZEC/USDT',
      action: 'SELL',
      amountUsdt: 80,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'ZEC/USDT',
          action: 'SELL',
          orderId: 'SMOKE-O2',
          expectedQty: 5,
          filledQty: 2,
          recordedFilledQty: 2,
          recordedCost: 6,
          followUpRequired: true,
        },
      },
    },
    {
      id: ids.applyFailRetry,
      symbol: 'TAO/USDT',
      action: 'BUY',
      amountUsdt: 120,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'TAO/USDT',
          action: 'BUY',
          orderId: 'SMOKE-O3',
          expectedQty: 3,
          filledQty: 1,
          recordedFilledQty: 1,
          recordedCost: 4,
          followUpRequired: true,
        },
      },
    },
    {
      id: ids.btcPairOpen,
      symbol: 'KITE/USDT',
      action: 'BUY',
      amountUsdt: 95,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'KITE/USDT',
          orderSymbol: 'KITE/BTC',
          action: 'BUY',
          orderId: 'SMOKE-O4',
          expectedQty: 4,
          filledQty: 0,
          recordedFilledQty: 0,
          recordedCost: 0,
          followUpRequired: true,
        },
      },
    },
    {
      id: ids.btcPairClosed,
      symbol: 'RAY/USDT',
      action: 'BUY',
      amountUsdt: 75,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'RAY/USDT',
          orderSymbol: 'RAY/BTC',
          action: 'BUY',
          orderId: 'SMOKE-O5',
          expectedQty: 2,
          filledQty: 0,
          recordedFilledQty: 0,
          recordedCost: 0,
          btcReferencePrice: 100000,
          followUpRequired: true,
        },
      },
    },
    {
      id: ids.missingOrderId,
      symbol: 'SMOKENID/USDT',
      action: 'BUY',
      amountUsdt: 66,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'SMOKENID/USDT',
          orderSymbol: 'SMOKENID/BTC',
          action: 'BUY',
          expectedQty: 1.5,
          filledQty: 0,
          recordedFilledQty: 0,
          recordedCost: 0,
          followUpRequired: true,
        },
      },
    },
    {
      id: ids.clientOrderRecover,
      symbol: 'CIDREC/USDT',
      action: 'BUY',
      amountUsdt: 72,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'CIDREC/USDT',
          orderSymbol: 'CIDREC/USDT',
          action: 'BUY',
          clientOrderId: 'SMOKE-CID-1',
          submittedAtMs: Date.now() - 60_000,
          expectedQty: 3,
          filledQty: 0,
          recordedFilledQty: 0,
          recordedCost: 0,
          followUpRequired: true,
        },
      },
    },
    {
      id: ids.unsupportedQuote,
      symbol: 'FDTEST/USDT',
      action: 'BUY',
      amountUsdt: 70,
      blockMeta: {
        pendingReconcile: {
          exchange: 'binance',
          market: 'crypto',
          symbol: 'FDTEST/USDT',
          orderSymbol: 'FDTEST/FDUSD',
          action: 'BUY',
          orderId: 'SMOKE-O6',
          expectedQty: 2.5,
          filledQty: 0,
          recordedFilledQty: 0,
          recordedCost: 0,
          followUpRequired: true,
        },
      },
    },
  ];

  try {
    for (const item of inserts) {
      await db.run(
        `INSERT INTO signals (id, symbol, action, amount_usdt, confidence, reasoning, status, exchange, trade_mode, block_code, block_meta)
         VALUES ($1, $2, $3, $4, 0.7, 'binance pending reconcile smoke', 'executed', 'binance', 'normal', 'order_pending_reconcile', $5::jsonb)`,
        [item.id, item.symbol, item.action, item.amountUsdt, JSON.stringify(item.blockMeta)],
      );
    }

    const fetchOrderMap = {
      'OID:SMOKE-O1': { id: 'SMOKE-O1', orderId: 'SMOKE-O1', status: 'closed', amount: 5, filled: 5, price: 2, average: 2, cost: 10 },
      'OID:SMOKE-O2': { id: 'SMOKE-O2', orderId: 'SMOKE-O2', status: 'closed', amount: 5, filled: 5, price: 3, average: 3, cost: 15 },
      'OID:SMOKE-O3': { id: 'SMOKE-O3', orderId: 'SMOKE-O3', status: 'closed', amount: 3, filled: 3, price: 4, average: 4, cost: 12 },
      'OID:SMOKE-O4': { id: 'SMOKE-O4', orderId: 'SMOKE-O4', status: 'open', amount: 4, filled: 4, price: 5, average: 5, cost: 20 },
      'OID:SMOKE-O5': { id: 'SMOKE-O5', orderId: 'SMOKE-O5', status: 'closed', amount: 2, filled: 2, price: 0.0001, average: 0.0001, cost: 0.0002 },
      'OID:SMOKE-O6': { id: 'SMOKE-O6', orderId: 'SMOKE-O6', status: 'closed', amount: 2.5, filled: 2.5, price: 1.01, average: 1.01, cost: 2.525 },
      'CID:SMOKE-CID-1': { id: 'SMOKE-O7', orderId: 'SMOKE-O7', clientOrderId: 'SMOKE-CID-1', status: 'closed', amount: 3, filled: 3, price: 7, average: 7, cost: 21 },
    };
    const fetchOrderSymbolCalls = [];
    const openOrderChecks = [];
    const applyDeltaCalls = [];

    const queueResult = await processBinancePendingReconcileQueue({
      tradeModes: ['normal'],
      limit: 20,
      delayMs: 0,
      deps: {
        fetchOrder: async (orderRef, orderSymbol) => {
          const ref = (orderRef && typeof orderRef === 'object') ? orderRef : { orderId: orderRef };
          const orderId = ref?.orderId ? String(ref.orderId) : null;
          const clientOrderId = ref?.clientOrderId ? String(ref.clientOrderId) : null;
          fetchOrderSymbolCalls.push({
            orderId: orderId || null,
            clientOrderId: clientOrderId || null,
            orderSymbol: String(orderSymbol || ref?.symbol || ''),
          });
          if (orderId && fetchOrderMap[`OID:${orderId}`]) return fetchOrderMap[`OID:${orderId}`];
          if (clientOrderId && fetchOrderMap[`CID:${clientOrderId}`]) return fetchOrderMap[`CID:${clientOrderId}`];
          return null;
        },
        isOrderStillOpen: async (symbol, orderId) => {
          openOrderChecks.push({ symbol: String(symbol || ''), orderId: String(orderId || '') });
          return String(orderId) === 'SMOKE-O4';
        },
        applyDelta: async ({ payload, deltaFilledQty, deltaCost, orderPrice }) => {
          applyDeltaCalls.push({
            signalId: payload.signalId,
            symbol: payload.symbol,
            orderSymbol: payload.orderSymbol || payload.symbol,
            deltaFilledQty: Number(deltaFilledQty || 0),
            deltaCost: Number(deltaCost || 0),
            orderPrice: Number(orderPrice || 0),
          });
          if (payload.signalId === ids.applyFailRetry) {
            throw new Error('apply_failed_smoke');
          }
          const fallbackCost = Number(deltaFilledQty || 0) * Number(orderPrice || 0);
          return {
            applied: true,
            tradeModeUsed: payload.tradeMode || 'normal',
            appliedFilledQty: Number(deltaFilledQty || 0),
            appliedCost: Number(deltaCost || 0) > 0 ? Number(deltaCost || 0) : fallbackCost,
            trade: {
              symbol: payload.symbol,
              side: payload.action === 'BUY' ? 'buy' : 'sell',
            },
          };
        },
      },
    });

    assert.equal(queueResult.candidates >= 8, true);
    assert.equal(queueResult.processed >= 8, true);
    assert.equal(queueResult.summary.completed >= 4, true);
    assert.equal(queueResult.summary.partial >= 1, true);
    assert.equal(queueResult.summary.failed >= 3, true);

    const afterZero = await db.getSignalById(ids.zeroToFilled);
    const zeroMeta = parseMeta(afterZero?.block_meta);
    assert.equal(afterZero?.block_code, 'order_reconciled');
    assert.equal(Number(zeroMeta?.pendingReconcile?.recordedFilledQty || 0), 5);
    assert.equal(Boolean(zeroMeta?.pendingReconcile?.followUpRequired), false);
    assert.equal(Boolean(zeroMeta?.pendingReconcile?.journalPending?.followUpRequired), true);
    assert.equal(String(zeroMeta?.pendingReconcile?.journalPending?.queueStatus || ''), 'queued');

    const afterPartial = await db.getSignalById(ids.partialToClosed);
    const partialMeta = parseMeta(afterPartial?.block_meta);
    assert.equal(afterPartial?.block_code, 'order_reconciled');
    assert.equal(Number(partialMeta?.pendingReconcile?.recordedFilledQty || 0), 5);
    assert.equal(Number(partialMeta?.pendingReconcile?.lastAppliedFilledDelta || 0), 3);

    const afterFail = await db.getSignalById(ids.applyFailRetry);
    const failMeta = parseMeta(afterFail?.block_meta);
    assert.equal(afterFail?.block_code, 'order_pending_reconcile');
    assert.equal(String(failMeta?.pendingReconcile?.queueStatus || ''), 'retrying');
    assert.equal(Number(failMeta?.pendingReconcile?.recordedFilledQty || 0), 1);
    assert.equal(Boolean(failMeta?.pendingReconcile?.followUpRequired), true);

    const afterBtcPairOpen = await db.getSignalById(ids.btcPairOpen);
    const btcPairOpenMeta = parseMeta(afterBtcPairOpen?.block_meta);
    assert.equal(afterBtcPairOpen?.block_code, 'partial_fill_pending');
    assert.equal(String(btcPairOpenMeta?.pendingReconcile?.orderSymbol || ''), 'KITE/BTC');
    assert.equal(String(btcPairOpenMeta?.pendingReconcile?.queueStatus || ''), 'partial_pending');
    assert.equal(Boolean(btcPairOpenMeta?.pendingReconcile?.followUpRequired), true);
    assert.ok(fetchOrderSymbolCalls.some((call) => call.orderId === 'SMOKE-O4' && call.orderSymbol === 'KITE/BTC'));
    assert.ok(openOrderChecks.some((call) => call.orderId === 'SMOKE-O4' && call.symbol === 'KITE/BTC'));

    const afterBtcPairClosed = await db.getSignalById(ids.btcPairClosed);
    const btcPairClosedMeta = parseMeta(afterBtcPairClosed?.block_meta);
    assert.equal(afterBtcPairClosed?.block_code, 'order_reconciled');
    assert.equal(String(btcPairClosedMeta?.pendingReconcile?.orderSymbol || ''), 'RAY/BTC');
    assert.equal(Number(btcPairClosedMeta?.pendingReconcile?.recordedFilledQty || 0), 2);
    assert.equal(Number(btcPairClosedMeta?.pendingReconcile?.recordedCost || 0), 20);
    const btcPairApplyCall = applyDeltaCalls.find((call) => call.signalId === ids.btcPairClosed);
    assert.ok(btcPairApplyCall, 'BTC pair closed apply call 존재');
    assert.equal(Number(btcPairApplyCall?.orderPrice || 0), 10);
    assert.equal(Number(btcPairApplyCall?.deltaCost || 0), 20);

    const afterMissingOrderId = await db.getSignalById(ids.missingOrderId);
    assert.equal(afterMissingOrderId?.status, 'failed');
    assert.equal(afterMissingOrderId?.block_code, 'manual_reconcile_required');

    const afterClientOrderRecover = await db.getSignalById(ids.clientOrderRecover);
    const clientRecoverMeta = parseMeta(afterClientOrderRecover?.block_meta);
    assert.equal(afterClientOrderRecover?.status, 'executed');
    assert.equal(afterClientOrderRecover?.block_code, 'order_reconciled');
    assert.equal(String(clientRecoverMeta?.pendingReconcile?.clientOrderId || ''), 'SMOKE-CID-1');
    assert.equal(Number(clientRecoverMeta?.pendingReconcile?.recordedFilledQty || 0), 3);
    assert.ok(fetchOrderSymbolCalls.some((call) => call.clientOrderId === 'SMOKE-CID-1'));

    const afterUnsupportedQuote = await db.getSignalById(ids.unsupportedQuote);
    assert.equal(afterUnsupportedQuote?.status, 'failed');
    assert.equal(afterUnsupportedQuote?.block_code, 'manual_reconcile_required');

    return {
      queueProcessed: queueResult.processed,
      queueCompleted: queueResult.summary.completed,
      queuePartial: queueResult.summary.partial,
      queueFailed: queueResult.summary.failed,
      btcPairOpenCode: afterBtcPairOpen?.block_code || null,
      btcPairClosedCode: afterBtcPairClosed?.block_code || null,
      clientOrderRecoverCode: afterClientOrderRecover?.block_code || null,
      missingOrderIdCode: afterMissingOrderId?.block_code || null,
      unsupportedQuoteCode: afterUnsupportedQuote?.block_code || null,
    };
  } finally {
    await db.run(
      `DELETE FROM signals WHERE id = ANY($1::text[])`,
      [[
        ids.zeroToFilled,
        ids.partialToClosed,
        ids.applyFailRetry,
        ids.btcPairOpen,
        ids.btcPairClosed,
        ids.clientOrderRecover,
        ids.missingOrderId,
        ids.unsupportedQuote,
      ]],
    ).catch(() => {});
  }
}

function runBtcPairFallbackGuardSmoke() {
  const orderAttemptedError = {
    code: 'btc_pair_post_order_reconcile_required',
    meta: { orderAttempted: true },
  };
  const pendingFillError = {
    code: 'order_pending_fill_verification',
    meta: { orderAttempted: true },
  };
  const preOrderError = new Error('markets_load_failed');

  assert.equal(shouldBlockUsdtFallbackAfterBtcPairError(orderAttemptedError), true);
  assert.equal(shouldBlockUsdtFallbackAfterBtcPairError(pendingFillError), true);
  assert.equal(shouldBlockUsdtFallbackAfterBtcPairError(preOrderError), false);

  return {
    orderAttemptedBlocked: shouldBlockUsdtFallbackAfterBtcPairError(orderAttemptedError),
    pendingBlocked: shouldBlockUsdtFallbackAfterBtcPairError(pendingFillError),
    preOrderAllowed: !shouldBlockUsdtFallbackAfterBtcPairError(preOrderError),
  };
}

async function runPendingEnqueueFailureSmoke() {
  const persistCalls = [];
  const notifyCalls = [];
  const result = await enqueueClientOrderPendingRetry({
    signalId: `enqueue-failure-${Date.now()}`,
    symbol: 'ENQF/USDT',
    action: 'BUY',
    amountUsdt: 55,
    signalTradeMode: 'normal',
    effectivePaperMode: false,
    pendingOrder: {
      orderId: null,
      clientOrderId: 'SMOKE-CID-ENQUEUE-FAIL',
      orderSymbol: 'ENQF/USDT',
      status: 'unknown',
      submittedAtMs: Date.now(),
      amount: 0,
      filled: 0,
      recoveryError: 'lookup_transient_smoke',
    },
    pendingMeta: {
      source: 'smoke',
    },
    pendingFilled: 0,
    pendingRawPrice: 0,
    pendingRawCost: 0,
    persistFailure: async (reason, options = {}) => {
      persistCalls.push({
        reason: String(reason || ''),
        code: String(options?.code || ''),
        meta: options?.meta || null,
      });
    },
    signal: {
      id: 'ENQUEUE-FAILURE-REGRESSION',
      reasoning: 'enqueue failure regression',
    },
    deps: {
      markSignal: async () => {
        throw new Error('mark_signal_failed_smoke');
      },
      reconcileLivePositions: async () => {
        throw new Error('should_not_reconcile_when_enqueue_failed');
      },
      notifyError: async (title, error) => {
        notifyCalls.push({
          title: String(title || ''),
          error: String(error?.message || error || ''),
        });
      },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 'pending_reconcile_enqueue_failed');
  assert.equal(result.pendingReconcile, false);
  assert.equal(result.clientOrderId, 'SMOKE-CID-ENQUEUE-FAIL');
  assert.equal(persistCalls.length, 1);
  assert.equal(persistCalls[0]?.code, 'pending_reconcile_enqueue_failed');
  assert.equal(String(persistCalls[0]?.meta?.clientOrderId || ''), 'SMOKE-CID-ENQUEUE-FAIL');
  assert.equal(notifyCalls.length, 1);
  assert.ok(String(notifyCalls[0]?.error || '').includes('mark_signal_failed_smoke'));

  return {
    resultCode: result.code,
    persistCode: persistCalls[0]?.code || null,
    notifyCount: notifyCalls.length,
  };
}

async function runBridgeReportedMutatingErrorSmoke() {
  const handler = createBinanceExecutionReconcileHandler({
    ACTIONS: { BUY: 'BUY', SELL: 'SELL' },
    toEpochMs: (value) => Number(value || 0) || null,
  });
  const error = /** @type {any} */ (new Error('Binance MCP bridge failed (market_buy): exchange rejected'));
  error.code = 'binance_mcp_mutating_bridge_failed';
  error.meta = {
    bridgeFailureStage: 'bridge_reported_error',
    bridgeErrorStatus: 'error',
    bridgeErrorMessage: 'exchange rejected before order acceptance',
    clientOrderId: 'SMOKE-BRIDGE-REPORTED-CID',
    symbol: 'ZEC/USDT',
    amountUsdt: 50,
  };

  const result = await handler.handleExecutionPendingReconcileError({
    error,
    signalId: `bridge-reported-${Date.now()}`,
    symbol: 'ZEC/USDT',
    action: 'BUY',
    amountUsdt: 50,
    signalTradeMode: 'validation',
    effectivePaperMode: false,
    executionClientOrderId: 'SMOKE-BRIDGE-REPORTED-CID',
    executionSubmittedAtMs: Date.now(),
    persistFailure: async () => {
      throw new Error('bridge_reported_error_should_not_enter_pending_reconcile');
    },
  });

  assert.equal(result.handled, false);
  assert.equal(result.error, error);

  return {
    handled: result.handled,
    errorCode: error.code,
    bridgeFailureStage: error.meta.bridgeFailureStage,
  };
}

async function runBinancePendingQueueActualApplySmoke() {
  const marker = `smoke-binance-actual-${Date.now()}`;
  const signalId = `${marker}-buy`;
  const symbol = 'ACTUAL/USDT';
  const orderId = 'SMOKE-REAL-1';

  await db.initSchema();
  await db.run(
    `INSERT INTO signals (id, symbol, action, amount_usdt, confidence, reasoning, status, exchange, trade_mode, block_code, block_meta)
     VALUES ($1, $2, 'BUY', 100, 0.8, 'binance pending reconcile actual apply smoke', 'executed', 'binance', 'normal', 'order_pending_reconcile', $3::jsonb)`,
    [signalId, symbol, JSON.stringify({
      pendingReconcile: {
        exchange: 'binance',
        market: 'crypto',
        symbol,
        action: 'BUY',
        tradeMode: 'normal',
        paperMode: true,
        orderId,
        expectedQty: 5,
        filledQty: 0,
        recordedFilledQty: 0,
        recordedCost: 0,
        followUpRequired: true,
      },
    })],
  );

  try {
    const run1 = await processBinancePendingReconcileQueue({
      tradeModes: ['normal'],
      limit: 10,
      delayMs: 0,
      deps: {
        fetchOrder: async () => ({ id: orderId, status: 'closed', amount: 5, filled: 5, price: 2, average: 2, cost: 10 }),
        isOrderStillOpen: async () => false,
      },
    });
    assert.equal(run1.processed >= 1, true);
    assert.equal(run1.summary.completed >= 1, true);

    const afterRun1 = await db.getSignalById(signalId);
    const afterRun1Meta = parseMeta(afterRun1?.block_meta);
    assert.equal(Number(afterRun1Meta?.pendingReconcile?.recordedFilledQty || 0), 5);
    const [positionAfterRun1] = await db.query(
      `SELECT amount, avg_price
         FROM positions
        WHERE symbol = $1
          AND exchange = 'binance'
          AND paper = true
          AND COALESCE(trade_mode, 'normal') = 'normal'
        LIMIT 1`,
      [symbol],
    );
    assert.equal(Number(positionAfterRun1?.amount || 0), 5);
    assert.equal(Number(positionAfterRun1?.avg_price || 0), 2);

    // recorded 메타를 고의로 stale로 되돌려도, trade-based effectiveRecorded로 delta 중복반영이 없어야 한다.
    const staleMeta = {
      ...afterRun1Meta,
      pendingReconcile: {
        ...(afterRun1Meta.pendingReconcile || {}),
        recordedFilledQty: 0,
        recordedCost: 0,
        followUpRequired: true,
        queueStatus: 'queued',
      },
    };
    await db.updateSignalBlock(signalId, {
      status: 'executed',
      reason: 'stale_recorded_simulated',
      code: 'order_pending_reconcile',
      meta: staleMeta,
    });

    const run2 = await processBinancePendingReconcileQueue({
      tradeModes: ['normal'],
      limit: 10,
      delayMs: 0,
      deps: {
        fetchOrder: async () => ({ id: orderId, status: 'closed', amount: 7, filled: 7, price: 2, average: 2, cost: 14 }),
        isOrderStillOpen: async () => false,
      },
    });
    assert.equal(run2.processed >= 1, true);
    assert.equal(run2.summary.completed >= 1, true);

    const [tradeAgg] = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS amount_sum, COALESCE(SUM(total_usdt), 0) AS cost_sum, COUNT(*)::int AS trade_count
         FROM trades
        WHERE signal_id = $1
          AND exchange = 'binance'`,
      [signalId],
    );
    assert.equal(Number(tradeAgg?.trade_count || 0), 2);
    assert.equal(Number(tradeAgg?.amount_sum || 0), 7);
    assert.equal(Number(tradeAgg?.cost_sum || 0), 14);

    const afterRun2 = await db.getSignalById(signalId);
    const afterRun2Meta = parseMeta(afterRun2?.block_meta);
    assert.equal(Number(afterRun2Meta?.pendingReconcile?.recordedFilledQty || 0), 7);
    const [positionAfterRun2] = await db.query(
      `SELECT amount, avg_price
         FROM positions
        WHERE symbol = $1
          AND exchange = 'binance'
          AND paper = true
          AND COALESCE(trade_mode, 'normal') = 'normal'
        LIMIT 1`,
      [symbol],
    );
    assert.equal(Number(positionAfterRun2?.amount || 0), 7);
    assert.equal(Number(positionAfterRun2?.avg_price || 0), 2);

    const run3 = await processBinancePendingReconcileQueue({
      tradeModes: ['normal'],
      limit: 10,
      delayMs: 0,
      deps: {
        fetchOrder: async () => ({ id: orderId, status: 'closed', amount: 7, filled: 7, price: 2, average: 2, cost: 14 }),
        isOrderStillOpen: async () => false,
      },
    });
    assert.equal(run3.processed, 0);

    return {
      run1Processed: run1.processed,
      run2Processed: run2.processed,
      run3Processed: run3.processed,
      tradeCount: Number(tradeAgg?.trade_count || 0),
      amountSum: Number(tradeAgg?.amount_sum || 0),
      positionAmount: Number(positionAfterRun2?.amount || 0),
    };
  } finally {
    await db.run(`DELETE FROM trade_journal WHERE signal_id = $1`, [signalId]).catch(() => {});
    await db.run(`DELETE FROM trades WHERE signal_id = $1`, [signalId]).catch(() => {});
    await db.run(`DELETE FROM positions WHERE symbol = $1 AND exchange = 'binance' AND paper = true`, [symbol]).catch(() => {});
    await db.run(`DELETE FROM signals WHERE id = $1`, [signalId]).catch(() => {});
  }
}

async function runBinancePendingJournalRepairSmoke() {
  const marker = `smoke-binance-journal-repair-${Date.now()}`;
  const signalId = `${marker}-signal`;
  const tradeId = `${marker}-trade`;
  const symbol = 'JRN/USDT';
  const incidentLink = `pending_reconcile_delta:${signalId}:ORD-JRN:buy:1.00000000`;

  await db.initSchema();
  await db.run(
    `INSERT INTO signals (id, symbol, action, amount_usdt, confidence, reasoning, status, exchange, trade_mode, block_code, block_meta)
     VALUES ($1, $2, 'BUY', 20, 0.75, 'binance pending journal repair smoke', 'executed', 'binance', 'normal', 'order_reconciled', $3::jsonb)`,
    [signalId, symbol, JSON.stringify({
      pendingReconcile: {
        exchange: 'binance',
        market: 'crypto',
        symbol,
        action: 'BUY',
        tradeMode: 'normal',
        paperMode: true,
        orderId: 'ORD-JRN',
        expectedQty: 1,
        filledQty: 1,
        recordedFilledQty: 1,
        recordedCost: 2,
        followUpRequired: false,
        journalPending: {
          followUpRequired: true,
          queueStatus: 'queued',
          attempts: 1,
          tradeId,
          incidentLink,
        },
      },
    })],
  );
  await db.run(
    `INSERT INTO trades
       (id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link, execution_origin, quality_flag, exclude_from_learning)
     VALUES
       ($1, $2, $3, 'buy', 1, 2, 2, true, 'binance', 'normal', $4, 'reconciliation', 'degraded', true)`,
    [tradeId, signalId, symbol, incidentLink],
  );

  try {
    const result = await processBinancePendingJournalRepairQueue({
      tradeModes: ['normal'],
      limit: 10,
      delayMs: 0,
    });
    assert.equal(result.processed >= 1, true);
    assert.equal(result.summary.repaired >= 1, true);

    const updatedSignal = await db.getSignalById(signalId);
    const updatedMeta = parseMeta(updatedSignal?.block_meta);
    assert.equal(Boolean(updatedMeta?.pendingReconcile?.journalPending?.followUpRequired), false);
    assert.equal(String(updatedMeta?.pendingReconcile?.journalPending?.queueStatus || ''), 'completed');
    assert.equal(String(updatedMeta?.pendingReconcile?.orderId || ''), 'ORD-JRN');
    assert.equal(Number(updatedMeta?.pendingReconcile?.recordedFilledQty || 0), 1);

    const [journalAgg] = await db.query(
      `SELECT COUNT(*)::int AS cnt
         FROM trade_journal
        WHERE signal_id = $1
          AND incident_link = $2`,
      [signalId, incidentLink],
    );
    assert.ok(Number(journalAgg?.cnt || 0) >= 1);

    return {
      processed: result.processed,
      repaired: result.summary.repaired,
      journalCount: Number(journalAgg?.cnt || 0),
    };
  } finally {
    await db.run(`DELETE FROM trade_journal WHERE signal_id = $1`, [signalId]).catch(() => {});
    await db.run(`DELETE FROM trades WHERE signal_id = $1`, [signalId]).catch(() => {});
    await db.run(`DELETE FROM positions WHERE symbol = $1 AND exchange = 'binance' AND paper = true`, [symbol]).catch(() => {});
    await db.run(`DELETE FROM signals WHERE id = $1`, [signalId]).catch(() => {});
  }
}

export async function runBinanceOrderPendingReconcileSmoke() {
  const payload = buildBinancePendingReconcilePayload({
    id: 'signal-binance-1',
    symbol: 'PHA/USDT',
    action: 'BUY',
    exchange: 'binance',
    trade_mode: 'normal',
    amount_usdt: 120,
    block_code: 'order_pending_reconcile',
    block_meta: JSON.stringify({
      pendingReconcile: {
        exchange: 'binance',
        market: 'crypto',
        symbol: 'PHA/USDT',
        action: 'BUY',
        orderId: '123456',
        expectedQty: 100,
        filledQty: 20,
        recordedFilledQty: 20,
        recordedCost: 6.4,
        followUpRequired: true,
      },
    }),
  });
  assert.ok(payload);
  assert.equal(payload.orderId, '123456');
  assert.equal(payload.expectedQty, 100);
  assert.equal(payload.recordedFilledQty, 20);
  assert.equal(payload.amountUsdt, 120);

  const openStillOpen = resolveBinancePendingQueueState({
    status: 'open',
    filledQty: 100,
    expectedQty: 100,
    orderStillOpen: true,
  });
  assert.equal(openStillOpen.code, 'partial_fill_pending');
  assert.equal(openStillOpen.followUpRequired, true);

  const openNoLongerOpen = resolveBinancePendingQueueState({
    status: 'open',
    filledQty: 100,
    expectedQty: 100,
    orderStillOpen: false,
  });
  assert.equal(openNoLongerOpen.code, 'partial_fill_pending');
  assert.equal(openNoLongerOpen.followUpRequired, true);

  const unknownNoLongerOpen = resolveBinancePendingQueueState({
    status: 'unknown',
    filledQty: 100,
    expectedQty: 100,
    orderStillOpen: false,
  });
  assert.equal(unknownNoLongerOpen.code, 'order_reconciled');
  assert.equal(unknownNoLongerOpen.followUpRequired, false);

  const applyFailed = computeBinancePendingRecordedProgress({
    exchangeFilledQty: 30,
    exchangeCost: 9.9,
    exchangePrice: 0.33,
    recordedFilledQty: 20,
    recordedCost: 6.4,
    applySucceeded: false,
  });
  assert.equal(applyFailed.deltaFilledQty, 10);
  assert.equal(applyFailed.appliedFilledQty, 0);
  assert.equal(applyFailed.nextRecordedFilledQty, 20);
  assert.equal(applyFailed.nextRecordedCost, 6.4);

  const applySucceeded = computeBinancePendingRecordedProgress({
    exchangeFilledQty: 30,
    exchangeCost: 9.9,
    exchangePrice: 0.33,
    recordedFilledQty: 20,
    recordedCost: 6.4,
    applySucceeded: true,
  });
  assert.equal(applySucceeded.deltaFilledQty, 10);
  assert.equal(applySucceeded.appliedFilledQty, 10);
  assert.equal(applySucceeded.nextRecordedFilledQty, 30);
  assert.ok(applySucceeded.nextRecordedCost > 6.4);

  const queuePath = await runBinancePendingQueuePathSmoke();
  const actualApplyPath = await runBinancePendingQueueActualApplySmoke();
  const journalRepairPath = await runBinancePendingJournalRepairSmoke();
  const btcFallbackGuardPath = runBtcPairFallbackGuardSmoke();
  const pendingEnqueueFailurePath = await runPendingEnqueueFailureSmoke();
  const bridgeReportedMutatingErrorPath = await runBridgeReportedMutatingErrorSmoke();

  return {
    ok: true,
    openStillOpen: openStillOpen.code,
    openNoLongerOpen: openNoLongerOpen.code,
    unknownNoLongerOpen: unknownNoLongerOpen.code,
    applyFailedNextRecorded: applyFailed.nextRecordedFilledQty,
    applySucceededNextRecorded: applySucceeded.nextRecordedFilledQty,
    queuePath,
    actualApplyPath,
    journalRepairPath,
    btcFallbackGuardPath,
    pendingEnqueueFailurePath,
    bridgeReportedMutatingErrorPath,
  };
}

async function main() {
  const result = await runBinanceOrderPendingReconcileSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('runtime binance order pending reconcile smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime binance order pending reconcile smoke 실패:',
  });
}
