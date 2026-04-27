#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { adjustLunaBuyCandidate, getCapitalConfig } from '../shared/capital-manager.ts';

const EXCHANGES = ['binance', 'kis', 'kis_overseas'];
const CAPITAL_MODES = [
  'ACTIVE_DISCOVERY',
  'CASH_CONSTRAINED',
  'POSITION_MONITOR_ONLY',
  'REDUCING_ONLY',
  'BALANCE_UNAVAILABLE',
];

function snapshot(exchange, mode) {
  const base = {
    exchange,
    tradeMode: 'normal',
    mode,
    reasonCode: null,
    freeCash: 500,
    availableBalance: 500,
    reservedCash: 50,
    buyableAmount: 500,
    minOrderAmount: 10,
    feeBufferAmount: 1,
    openPositionCount: 0,
    maxPositionCount: 5,
    remainingSlots: 5,
    totalCapital: 600,
    balanceStatus: 'ok',
    source: 'broker',
    observedAt: new Date().toISOString(),
  };

  if (mode === 'CASH_CONSTRAINED') {
    return { ...base, buyableAmount: 5, reasonCode: 'cash_constrained_monitor_only' };
  }
  if (mode === 'POSITION_MONITOR_ONLY') {
    return { ...base, remainingSlots: 0, openPositionCount: 5, reasonCode: 'position_slots_exhausted' };
  }
  if (mode === 'REDUCING_ONLY') {
    return { ...base, reasonCode: 'reducing_only_mode' };
  }
  if (mode === 'BALANCE_UNAVAILABLE') {
    return {
      ...base,
      freeCash: 0,
      availableBalance: 0,
      buyableAmount: 0,
      balanceStatus: 'unavailable',
      source: 'unavailable',
      reasonCode: 'buying_power_unavailable',
    };
  }
  return base;
}

function expectedResult(mode) {
  if (mode === 'ACTIVE_DISCOVERY') return 'accepted';
  if (mode === 'CASH_CONSTRAINED') return 'blocked_cash';
  if (mode === 'POSITION_MONITOR_ONLY') return 'blocked_slots';
  if (mode === 'REDUCING_ONLY') return 'reduce_only';
  if (mode === 'BALANCE_UNAVAILABLE') return 'blocked_balance_unavailable';
  return 'blocked_cash';
}

export function runLunaCapitalMatrixSmoke() {
  const cases = [];
  for (const exchange of EXCHANGES) {
    const normalConfig = getCapitalConfig(exchange, 'normal');
    const validationConfig = getCapitalConfig(exchange, 'validation');
    assert.ok(Number(normalConfig.max_concurrent_positions || 0) > 0, `${exchange} normal max_concurrent_positions`);
    assert.ok(Number(validationConfig.max_concurrent_positions || 0) > 0, `${exchange} validation max_concurrent_positions`);

    for (const mode of CAPITAL_MODES) {
      const result = adjustLunaBuyCandidate(100, snapshot(exchange, mode));
      assert.equal(result.result, expectedResult(mode), `${exchange}/${mode}`);
      cases.push({
        exchange,
        mode,
        result: result.result,
        adjustedAmount: result.adjustedAmount,
      });
    }
  }

  return {
    ok: true,
    caseCount: cases.length,
    exchanges: EXCHANGES,
    modes: CAPITAL_MODES,
    cases,
  };
}

async function main() {
  const result = runLunaCapitalMatrixSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna capital matrix smoke ok (${result.caseCount} cases)`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna capital matrix smoke 실패:',
  });
}
