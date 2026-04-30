#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { calculateAtrTpSl } from '../shared/tp-sl-auto-setter.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const long = calculateAtrTpSl({ entryPrice: 100, atr: 5, side: 'BUY', rr: 2 });
  assert.equal(long.ok, true);
  assert.equal(long.stopLoss, 95);
  assert.equal(long.takeProfit, 110);

  const short = calculateAtrTpSl({ entryPrice: 100, atr: 4, side: 'SELL', rr: 1.5 });
  assert.equal(short.stopLoss, 104);
  assert.equal(short.takeProfit, 94);

  const invalid = calculateAtrTpSl({ entryPrice: 0, atr: 1 });
  assert.equal(invalid.ok, false);
  return { ok: true, long, short, invalid };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ tp-sl-auto-setter-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ tp-sl-auto-setter-smoke 실패:' });
}
