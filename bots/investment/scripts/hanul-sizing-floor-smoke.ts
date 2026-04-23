#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { ACTIONS } from '../shared/signal.ts';
import { applyHanulStockSizingFloor } from '../team/hanul.ts';

export function runHanulSizingFloorSmoke() {
  const domesticAdjusted = applyHanulStockSizingFloor(118801, {
    action: ACTIONS.BUY,
    minOrder: 200000,
    maxOrder: 1200000,
    currency: 'KRW',
  });
  assert.equal(domesticAdjusted.amount, 200000);
  assert.equal(domesticAdjusted.adjusted, true);
  assert.equal(domesticAdjusted.blocked, false);
  assert.equal(domesticAdjusted.code, 'sizing_floor_applied');

  const alreadyValid = applyHanulStockSizingFloor(250000, {
    action: ACTIONS.BUY,
    minOrder: 200000,
    maxOrder: 1200000,
    currency: 'KRW',
  });
  assert.equal(alreadyValid.amount, 250000);
  assert.equal(alreadyValid.adjusted, false);

  const unavailable = applyHanulStockSizingFloor(118801, {
    action: ACTIONS.BUY,
    minOrder: 200000,
    maxOrder: 150000,
    currency: 'KRW',
  });
  assert.equal(unavailable.amount, 118801);
  assert.equal(unavailable.adjusted, false);
  assert.equal(unavailable.blocked, true);
  assert.equal(unavailable.code, 'sizing_floor_unavailable');

  const sellIgnored = applyHanulStockSizingFloor(1, {
    action: ACTIONS.SELL,
    minOrder: 200000,
    maxOrder: 1200000,
    currency: 'KRW',
  });
  assert.equal(sellIgnored.amount, 1);
  assert.equal(sellIgnored.adjusted, false);
  assert.equal(sellIgnored.blocked, false);

  return {
    ok: true,
    domesticAdjusted,
    alreadyValid,
    unavailable,
    sellIgnored,
  };
}

async function main() {
  const result = runHanulSizingFloorSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('hanul sizing floor smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ hanul sizing floor smoke 실패:',
  });
}
