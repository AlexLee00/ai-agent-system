#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { extractGap } from './runtime-min-order-pressure-report.ts';

export function runRuntimeMinOrderPressureSmoke() {
  const krwWon = extractGap('최소 주문금액 미달 (118,801원 < 200,000원)');
  assert.equal(krwWon.attempted, 118801);
  assert.equal(krwWon.required, 200000);
  assert.equal(krwWon.gap, 81199);

  const krwText = extractGap('runtime gap 81,199 KRW (118,801 KRW < 200,000 KRW)');
  assert.equal(krwText.attempted, 118801);
  assert.equal(krwText.required, 200000);
  assert.equal(krwText.gap, 81199);

  const usdtText = extractGap('min order notional (9.25 USDT < 10.00 USDT)');
  assert.equal(usdtText.attempted, 9.25);
  assert.equal(usdtText.required, 10);
  assert.equal(usdtText.gap, 0.75);

  return {
    ok: true,
    krwWon,
    krwText,
    usdtText,
  };
}

async function main() {
  const result = runRuntimeMinOrderPressureSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime min-order pressure smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime min-order pressure smoke 실패:',
  });
}
