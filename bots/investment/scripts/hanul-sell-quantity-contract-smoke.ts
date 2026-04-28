#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  alignHanulSellQuantityWithBroker,
  resolveHanulSellQuantity,
} from '../team/hanul.ts';

export function runHanulSellQuantityContractSmoke() {
  const normalPartial = resolveHanulSellQuantity({
    baseQty: 15,
    partialExitRatio: 0.47,
  });
  assert.equal(normalPartial.success, true);
  assert.equal(normalPartial.qty, 7);
  assert.equal(normalPartial.partialExitRatio, 0.47);
  assert.equal(normalPartial.residualFullExit, false);

  const residualFullExit = resolveHanulSellQuantity({
    baseQty: 2,
    partialExitRatio: 0.47,
    residualFullExitMaxQty: 2,
  });
  assert.equal(residualFullExit.success, true);
  assert.equal(residualFullExit.qty, 2);
  assert.equal(residualFullExit.partialExitRatio, 1);
  assert.equal(residualFullExit.requestedPartialExitRatio, 0.47);
  assert.equal(residualFullExit.residualFullExit, true);

  const largeUnexecutablePartial = resolveHanulSellQuantity({
    baseQty: 5,
    partialExitRatio: 0.1,
    residualFullExitMaxQty: 2,
  });
  assert.equal(largeUnexecutablePartial.success, false);
  assert.equal(largeUnexecutablePartial.code, 'partial_sell_below_minimum');

  const brokerClamp = alignHanulSellQuantityWithBroker({
    intendedQty: 15,
    brokerQty: 13,
    market: 'overseas',
    symbol: 'POET',
  });
  assert.equal(brokerClamp.success, true);
  assert.equal(brokerClamp.qty, 13);
  assert.equal(brokerClamp.adjusted, true);
  assert.equal(brokerClamp.code, 'broker_qty_clamped');

  const domesticBrokerClamp = alignHanulSellQuantityWithBroker({
    intendedQty: 8.9,
    brokerQty: 7.7,
    market: 'domestic',
    symbol: '005930',
  });
  assert.equal(domesticBrokerClamp.success, true);
  assert.equal(domesticBrokerClamp.qty, 7);
  assert.equal(domesticBrokerClamp.adjusted, true);
  assert.equal(domesticBrokerClamp.code, 'broker_qty_clamped');

  const brokerMissing = alignHanulSellQuantityWithBroker({
    intendedQty: 2,
    brokerQty: 0,
    market: 'overseas',
    symbol: 'POET',
  });
  assert.equal(brokerMissing.success, false);
  assert.equal(brokerMissing.code, 'broker_position_missing');

  return {
    ok: true,
    normalPartial,
    residualFullExit,
    largeUnexecutablePartial,
    brokerClamp,
    domesticBrokerClamp,
    brokerMissing,
  };
}

async function main() {
  const result = runHanulSellQuantityContractSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('hanul sell quantity contract smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ hanul sell quantity contract smoke 실패:',
  });
}
