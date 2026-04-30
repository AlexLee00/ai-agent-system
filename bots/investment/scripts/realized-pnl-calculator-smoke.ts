#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { calculateRealizedPnl, matchFifoRealizedPnl } from '../shared/realized-pnl-calculator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const pnl = calculateRealizedPnl({
    buy: { price: 100, quantity: 2, fee: 0.5 },
    sell: { price: 112, quantity: 2, fee: 0.5 },
  });
  assert.equal(pnl.ok, true);
  assert.equal(pnl.realizedPnl, 23);
  assert.ok(pnl.realizedPnlPct > 0);

  const fifo = matchFifoRealizedPnl([
    { side: 'BUY', price: 100, quantity: 1 },
    { side: 'BUY', price: 105, quantity: 1 },
    { side: 'SELL', price: 110, quantity: 1.5 },
  ]);
  assert.equal(fifo.ok, true);
  assert.equal(fifo.realized.length, 2);
  assert.equal(fifo.openLots.length, 1);
  return { ok: true, pnl, fifo };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ realized-pnl-calculator-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ realized-pnl-calculator-smoke 실패:' });
}
