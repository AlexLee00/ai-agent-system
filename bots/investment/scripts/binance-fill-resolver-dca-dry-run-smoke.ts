#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { resolveFillForClosedJournal } from '../shared/binance-fill-resolver.ts';
import { buildPartialExchangeFillSkipResult } from './reconcile-open-journals.ts';

const now = Date.parse('2026-05-28T00:00:00.000Z');
let misattributionCount = 0;
let partialSkipCount = 0;

function trade({
  id,
  order = null,
  side = 'sell',
  amount = 10,
  price = 1,
  offsetMs = 0,
}) {
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

function verifyOnlyTradeIds(result, expectedIds) {
  try {
    assert.deepEqual(result.tradeIds, expectedIds);
  } catch (error) {
    misattributionCount += 1;
    throw error;
  }
}

const katDca = await resolveFillForClosedJournal({
  symbol: 'KAT/USDT',
  entryTime: now - 1_000,
  entrySize: 10,
  entryPrice: 1,
  entryValue: 10,
  expectedSide: 'sell',
  orderIds: ['KAT-TP-A'],
  fetchMyTrades: async () => [
    trade({ id: 'kat-other-entry-fill', order: 'KAT-TP-B', price: 0.91, offsetMs: 1 }),
    trade({ id: 'kat-correct-entry-fill', order: 'KAT-TP-A', price: 1.07, offsetMs: 2 }),
  ],
});
assert.equal(katDca.matchedBy, 'order_id');
verifyOnlyTradeIds(katDca, ['kat-correct-entry-fill']);

const taoShort = await resolveFillForClosedJournal({
  symbol: 'TAO/USDT',
  entryTime: now - 1_000,
  entrySize: 0.2,
  entryPrice: 500,
  entryValue: 100,
  expectedSide: 'buy',
  orderIds: ['TAO-SL-SHORT-A'],
  fetchMyTrades: async () => [
    trade({ id: 'tao-wrong-side-fill', order: 'TAO-SL-SHORT-A', side: 'sell', amount: 0.2, price: 510, offsetMs: 1 }),
    trade({ id: 'tao-short-cover-fill', order: 'TAO-SL-SHORT-A', side: 'buy', amount: 0.2, price: 490, offsetMs: 2 }),
  ],
});
assert.equal(taoShort.matchedBy, 'order_id');
verifyOnlyTradeIds(taoShort, ['tao-short-cover-fill']);

const orcaAmbiguous = await resolveFillForClosedJournal({
  symbol: 'ORCA/USDT',
  entryTime: now - 1_000,
  entrySize: 12,
  entryPrice: 1,
  entryValue: 12,
  expectedSide: 'sell',
  orderIds: [],
  fetchMyTrades: async () => [
    trade({ id: 'orca-candidate-a', amount: 12, price: 1.01, offsetMs: 1 }),
    trade({ id: 'orca-candidate-b', amount: 12, price: 0.99, offsetMs: 2 }),
  ],
});
assert.equal(orcaAmbiguous.source, 'unresolved');
assert.equal(orcaAmbiguous.reason, 'ambiguous_no_orderid');
assert.equal(orcaAmbiguous.exactQtyMatches, 2);

// partial 시나리오: order_id 매칭되나 matchedQty(60) < expectedQty(100) — partial=true 반환 확인
const partialFill = await resolveFillForClosedJournal({
  symbol: 'SOL/USDT',
  entryTime: now - 1_000,
  entrySize: 100,
  entryPrice: 1,
  entryValue: 100,
  expectedSide: 'sell',
  orderIds: ['SOL-TP-PARTIAL'],
  fetchMyTrades: async () => [
    trade({ id: 'sol-partial-fill', order: 'SOL-TP-PARTIAL', amount: 60, price: 1.05, offsetMs: 1 }),
  ],
});
assert.equal(partialFill.source, 'fetchMyTrades_orderid');
assert.equal(partialFill.partial, true);
assert.equal(partialFill.matchedQty, 60);
assert.equal(partialFill.expectedQty, 100);
const partialSkip = buildPartialExchangeFillSkipResult({
  scope: 'binance:SOL/USDT:live:validation',
  latest: { symbol: 'SOL/USDT' },
  exchangeFillResolve: partialFill,
});
assert.equal(partialSkip.action, 'skip_partial_exchange_fill');
assert.equal(partialSkip.reason, 'partial_fill_match_insufficient_for_full_close');
assert.equal(partialSkip.fillResolve.partial, true);
partialSkipCount += 1;

const excludedFallback = await resolveFillForClosedJournal({
  symbol: 'KAT/USDT',
  entryTime: now - 1_000,
  entrySize: 8,
  entryPrice: 1,
  entryValue: 8,
  expectedSide: 'sell',
  orderIds: [],
  excludedFillIds: ['already-attributed-fill'],
  fetchMyTrades: async () => [
    trade({ id: 'already-attributed-fill', amount: 8, price: 1.02, offsetMs: 1 }),
  ],
});
assert.equal(excludedFallback.source, 'unresolved');
assert.equal(excludedFallback.reason, 'no_matching_side_fills');

console.log(JSON.stringify({
  ok: true,
  dryRun: true,
  scenarios: [
    { symbol: 'KAT/USDT', matchedBy: katDca.matchedBy, tradeIds: katDca.tradeIds },
    { symbol: 'TAO/USDT', matchedBy: taoShort.matchedBy, tradeIds: taoShort.tradeIds },
    { symbol: 'ORCA/USDT', reason: orcaAmbiguous.reason, exactQtyMatches: orcaAmbiguous.exactQtyMatches },
    { symbol: 'SOL/USDT', partial: partialFill.partial, partialAction: partialSkip.action, matchedQty: partialFill.matchedQty, expectedQty: partialFill.expectedQty },
    { symbol: 'KAT/USDT', reason: excludedFallback.reason, excludedFillIds: ['already-attributed-fill'] },
  ],
  misattributionCount,
  partialSkipCount,
}, null, 2));
