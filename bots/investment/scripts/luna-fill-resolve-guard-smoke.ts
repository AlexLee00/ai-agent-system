#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { resolveFillForClosedJournal } from '../shared/binance-fill-resolver.ts';

const now = Date.parse('2026-06-21T00:00:00.000Z');

function trade({
  id,
  order = 'TP-1',
  side = 'sell',
  amount = 80,
  price = 1.8625,
  offsetMs = 1,
} = {}) {
  return {
    id,
    order,
    side,
    amount,
    price,
    cost: amount * price,
    timestamp: now + offsetMs,
    datetime: new Date(now + offsetMs).toISOString(),
  };
}

async function main() {
  let microFetchCalled = false;
  const microEntry = await resolveFillForClosedJournal({
    symbol: 'BROCCOLI/USDT',
    entryTime: now - 1_000,
    entrySize: 0.0784,
    entryPrice: 0.175,
    entryValue: 0.01372,
    expectedSide: 'sell',
    orderIds: ['BROCCOLI-TP-019'],
    fetchMyTrades: async () => {
      microFetchCalled = true;
      return [trade({ id: 'micro-should-not-fetch', order: 'BROCCOLI-TP-019', amount: 0.392, price: 309 })];
    },
  });
  assert.equal(microEntry.source, 'unresolved');
  assert.equal(microEntry.reason, 'micro_entry_invalid');
  assert.equal(microFetchCalled, false, 'micro entries must be rejected before fetchMyTrades');
  assert.equal(microEntry.expectedQty, 0.0784);

  const qtyOverflow = await resolveFillForClosedJournal({
    symbol: 'ZBT/USDT',
    entryTime: now - 1_000,
    entrySize: 80,
    entryPrice: 0.14875,
    entryValue: 11.9,
    expectedSide: 'sell',
    orderIds: ['ZBT-TP-037'],
    fetchMyTrades: async () => [
      trade({ id: 'zbt-overflow-fill', order: 'ZBT-TP-037', amount: 800, price: 1.86 }),
    ],
  });
  assert.equal(qtyOverflow.source, 'unresolved');
  assert.equal(qtyOverflow.reason, 'qty_overflow');
  assert.equal(qtyOverflow.matchedQty, 800);
  assert.equal(qtyOverflow.expectedQty, 80);

  const normalPass = await resolveFillForClosedJournal({
    symbol: 'ZBT/USDT',
    entryTime: now - 1_000,
    entrySize: 80,
    entryPrice: 0.14875,
    entryValue: 11.9,
    expectedSide: 'sell',
    orderIds: ['ZBT-TP-NORMAL'],
    fetchMyTrades: async () => [
      trade({ id: 'zbt-normal-fill', order: 'ZBT-TP-NORMAL', amount: 80, price: 1.8625 }),
    ],
  });
  assert.equal(normalPass.source, 'fetchMyTrades_orderid');
  assert.equal(normalPass.matchedBy, 'order_id');
  assert.equal(normalPass.matchedQty, 80);
  assert.ok(Math.abs(normalPass.exitValue - 149) < 0.000001);
  assert.ok(Math.abs(normalPass.pnlAmount - 137.1) < 0.000001);

  const boundaryPass = await resolveFillForClosedJournal({
    symbol: 'EDGE/USDT',
    entryTime: now - 1_000,
    entrySize: 10,
    entryPrice: 0.5,
    entryValue: 5,
    expectedSide: 'sell',
    orderIds: ['EDGE-TP-5'],
    fetchMyTrades: async () => [
      trade({ id: 'edge-boundary-fill', order: 'EDGE-TP-5', amount: 10, price: 0.55 }),
    ],
  });
  assert.equal(boundaryPass.source, 'fetchMyTrades_orderid');
  assert.equal(boundaryPass.reason, undefined);
  assert.equal(boundaryPass.matchedQty, 10);
  assert.ok(Math.abs(boundaryPass.pnlAmount - 0.5) < 0.000001);

  const result = {
    ok: true,
    smoke: 'luna-fill-resolve-guard',
    scenarios: {
      microEntryBlock: true,
      qtyOverflowBlock: true,
      normalPass: true,
      boundaryPass: true,
    },
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna fill resolve guard smoke ok');
}

main().catch((error) => {
  console.error('❌ luna-fill-resolve-guard-smoke 실패:', error);
  process.exitCode = 1;
});
