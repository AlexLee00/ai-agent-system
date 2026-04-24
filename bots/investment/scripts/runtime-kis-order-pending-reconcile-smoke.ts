#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildHanulPendingReconcilePayload,
  classifyHanulPendingReconcileState,
} from '../team/hanul.ts';

export function runKisOrderPendingReconcileSmoke() {
  const payload = buildHanulPendingReconcilePayload({
    id: 'signal-1',
    symbol: 'AAPL',
    action: 'BUY',
    exchange: 'kis_overseas',
    trade_mode: 'normal',
    block_code: 'order_pending_reconcile',
    block_meta: JSON.stringify({
      pendingReconcile: {
        market: 'overseas',
        exchange: 'kis_overseas',
        symbol: 'AAPL',
        action: 'BUY',
        ordNo: '12345',
        expectedQty: 5,
        beforeQty: 0,
        observedQty: 0,
        filledQty: 0,
        followUpRequired: true,
      },
    }),
  });
  assert.ok(payload);
  assert.equal(payload.sourceKey, 'pendingReconcile');
  assert.equal(payload.symbol, 'AAPL');
  assert.equal(payload.expectedQty, 5);
  assert.equal(payload.filledQty, 0);
  assert.equal(payload.followUpRequired, true);

  const queued = classifyHanulPendingReconcileState({
    expectedQty: 5,
    filledQty: 0,
    verified: false,
  });
  assert.equal(queued.code, 'order_pending_reconcile');
  assert.equal(queued.followUpRequired, true);

  const partial = classifyHanulPendingReconcileState({
    expectedQty: 5,
    filledQty: 2,
    verified: false,
  });
  assert.equal(partial.code, 'partial_fill_pending');
  assert.equal(partial.followUpRequired, true);

  const completedByFill = classifyHanulPendingReconcileState({
    expectedQty: 5,
    filledQty: 5,
    verified: false,
  });
  assert.equal(completedByFill.code, 'order_reconciled');
  assert.equal(completedByFill.followUpRequired, false);

  const completedByVerification = classifyHanulPendingReconcileState({
    expectedQty: 5,
    filledQty: 0,
    verified: true,
  });
  assert.equal(completedByVerification.code, 'order_reconciled');
  assert.equal(completedByVerification.followUpRequired, false);

  return {
    ok: true,
    sourceKey: payload.sourceKey,
    queued: queued.code,
    partial: partial.code,
    completed: completedByFill.code,
  };
}

async function main() {
  const result = runKisOrderPendingReconcileSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('runtime kis order pending reconcile smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime kis order pending reconcile smoke 실패:',
  });
}
