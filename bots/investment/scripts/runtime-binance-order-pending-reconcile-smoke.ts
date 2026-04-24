#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import {
  buildBinancePendingReconcilePayload,
  computeBinancePendingRecordedProgress,
  processBinancePendingJournalRepairQueue,
  processBinancePendingReconcileQueue,
  resolveBinancePendingQueueState,
} from '../team/hephaestos.ts';

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
      'SMOKE-O1': { id: 'SMOKE-O1', status: 'closed', amount: 5, filled: 5, price: 2, average: 2, cost: 10 },
      'SMOKE-O2': { id: 'SMOKE-O2', status: 'closed', amount: 5, filled: 5, price: 3, average: 3, cost: 15 },
      'SMOKE-O3': { id: 'SMOKE-O3', status: 'closed', amount: 3, filled: 3, price: 4, average: 4, cost: 12 },
    };

    const queueResult = await processBinancePendingReconcileQueue({
      tradeModes: ['normal'],
      limit: 20,
      delayMs: 0,
      deps: {
        fetchOrder: async (orderId) => fetchOrderMap[String(orderId)] || null,
        isOrderStillOpen: async () => false,
        applyDelta: async ({ payload, deltaFilledQty, deltaCost, orderPrice }) => {
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

    assert.equal(queueResult.candidates, 3);
    assert.equal(queueResult.processed, 3);
    assert.equal(queueResult.summary.completed, 2);
    assert.equal(queueResult.summary.failed, 1);

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

    return {
      queueProcessed: queueResult.processed,
      queueCompleted: queueResult.summary.completed,
      queueFailed: queueResult.summary.failed,
    };
  } finally {
    await db.run(
      `DELETE FROM signals WHERE id = ANY($1::text[])`,
      [[ids.zeroToFilled, ids.partialToClosed, ids.applyFailRetry]],
    ).catch(() => {});
  }
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
    assert.equal(run1.processed, 1);
    assert.equal(run1.summary.completed, 1);

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
    assert.equal(run2.processed, 1);
    assert.equal(run2.summary.completed, 1);

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
    assert.equal(result.processed, 1);
    assert.equal(result.summary.repaired, 1);

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
  assert.equal(openNoLongerOpen.code, 'order_reconciled');
  assert.equal(openNoLongerOpen.followUpRequired, false);

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

  return {
    ok: true,
    openStillOpen: openStillOpen.code,
    openNoLongerOpen: openNoLongerOpen.code,
    applyFailedNextRecorded: applyFailed.nextRecordedFilledQty,
    applySucceededNextRecorded: applySucceeded.nextRecordedFilledQty,
    queuePath,
    actualApplyPath,
    journalRepairPath,
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
