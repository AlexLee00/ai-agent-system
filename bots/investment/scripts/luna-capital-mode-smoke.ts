#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveCapitalGateAction, shouldRunDiscovery } from '../team/luna.ts';

function snapshot(mode, reasonCode = null) {
  return {
    exchange: 'binance',
    tradeMode: 'normal',
    mode,
    reasonCode,
    freeCash: 0,
    availableBalance: 0,
    reservedCash: 0,
    buyableAmount: 0,
    minOrderAmount: 10,
    feeBufferAmount: 0,
    openPositionCount: 0,
    maxPositionCount: 6,
    remainingSlots: 6,
    totalCapital: 0,
    balanceStatus: mode === 'BALANCE_UNAVAILABLE' ? 'unavailable' : 'ok',
    source: mode === 'BALANCE_UNAVAILABLE' ? 'unavailable' : 'broker',
    observedAt: new Date().toISOString(),
  };
}

export function runLunaCapitalModeSmoke() {
  const unavailable = snapshot('BALANCE_UNAVAILABLE', 'buying_power_unavailable');
  assert.equal(shouldRunDiscovery(unavailable), false);
  assert.equal(resolveCapitalGateAction(unavailable, 0), 'idle_digest');

  const cashConstrained = snapshot('CASH_CONSTRAINED', 'cash_constrained_monitor_only');
  assert.equal(shouldRunDiscovery(cashConstrained), false);
  assert.equal(resolveCapitalGateAction(cashConstrained, 2), 'exit_only');

  const positionMonitorOnly = snapshot('POSITION_MONITOR_ONLY', 'position_slots_exhausted');
  assert.equal(shouldRunDiscovery(positionMonitorOnly), false);
  assert.equal(resolveCapitalGateAction(positionMonitorOnly, 1), 'exit_only');

  const activeRecovered = snapshot('ACTIVE_DISCOVERY', null);
  assert.equal(shouldRunDiscovery(activeRecovered), true);
  assert.equal(resolveCapitalGateAction(activeRecovered, 0), 'active_discovery');

  assert.equal(shouldRunDiscovery(activeRecovered, 'monitor_only'), false);
  assert.equal(resolveCapitalGateAction(activeRecovered, 0, 'monitor_only'), 'idle_digest');

  return {
    ok: true,
    modes: {
      unavailable: unavailable.mode,
      cashConstrained: cashConstrained.mode,
      positionMonitorOnly: positionMonitorOnly.mode,
      activeRecovered: activeRecovered.mode,
    },
  };
}

async function main() {
  const result = runLunaCapitalModeSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna capital mode smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna capital mode smoke 실패:',
  });
}
