#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveCapitalGateAction } from '../team/luna.ts';

function activeSnapshot() {
  return {
    mode: 'ACTIVE_DISCOVERY',
    reasonCode: null,
    buyableAmount: 140,
    minOrderAmount: 10,
    balanceStatus: 'ok',
    openPositionCount: 0,
    maxPositionCount: 6,
  };
}

function constrainedSnapshot() {
  return {
    mode: 'CASH_CONSTRAINED',
    reasonCode: 'cash_constrained_monitor_only',
    buyableAmount: 5,
    minOrderAmount: 10,
    balanceStatus: 'ok',
    openPositionCount: 0,
    maxPositionCount: 6,
  };
}

export function runLunaMonitorOnlySmoke() {
  const active = activeSnapshot();
  assert.equal(resolveCapitalGateAction(active, 0), 'active_discovery');

  const constrained = constrainedSnapshot();
  assert.equal(resolveCapitalGateAction(constrained, 3), 'exit_only');
  assert.equal(resolveCapitalGateAction(constrained, 0), 'idle_digest');

  // discovery throttle 모드 오버라이드가 있으면 ACTIVE여도 monitor-only 동작
  assert.equal(resolveCapitalGateAction(active, 2, 'monitor_only'), 'exit_only');
  assert.equal(resolveCapitalGateAction(active, 0, 'monitor_only'), 'idle_digest');

  return {
    ok: true,
    actions: {
      active: resolveCapitalGateAction(active, 0),
      constrainedWithPosition: resolveCapitalGateAction(constrained, 3),
      constrainedNoPosition: resolveCapitalGateAction(constrained, 0),
      throttleOverride: resolveCapitalGateAction(active, 2, 'monitor_only'),
    },
  };
}

async function main() {
  const result = runLunaMonitorOnlySmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna monitor-only smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna monitor-only smoke 실패:',
  });
}
